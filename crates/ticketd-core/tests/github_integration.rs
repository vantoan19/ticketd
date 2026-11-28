use rusqlite::Connection;
use ticketd_core::{
    Workspace,
    source::{GithubMigrationNotice, VerifiedGithubLogin},
};

#[test]
fn upgrades_github_connections_and_preserves_tickets_and_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, 105).unwrap();
    let fixture = Connection::open(&path).unwrap();
    fixture.execute_batch(
        "INSERT INTO source_connections
           (id, name, provider, site, configuration, account, account_key, contract_version, saved_at, revision)
         VALUES
           ('github','First','github','','{\"repositories\":[\"Owner/One\"],\"assignee\":\"@me\"}','sam','sam',2,'2026-01-01T00:00:00Z','first'),
           ('github-2','Second','github','','{\"repositories\":[\"Owner/Two\",\"Owner/Three\"],\"labels\":[\"bug\"]}','pat','pat',2,'2026-01-01T00:00:00Z','second'),
           ('linear','Team','linear','','{}','lin','lin',2,'2026-01-01T00:00:00Z','linear');
         INSERT INTO projects (id, name, path, remote) VALUES ('two','Two','/tmp/ticketd-fixture','github.com/owner/two');
         INSERT INTO source_connection_status (connection_id,last_attempt_at,last_refreshed_at,error_code,error_message,read_partitions)
         VALUES ('github','2026-01-05T00:00:00Z','2026-01-04T00:00:00Z','rate_limited','Wait','[\"owner/one\"]');
         INSERT INTO tickets (id, reference, title, status) VALUES ('issue','T-AB','Saved issue','Todo');
         INSERT INTO publication_attempts
           (id,ticket_id,provider,destination,destination_host,title,body,status,started_at,lease_expires_at,updated_at)
         VALUES
           ('uncertain','issue','github','owner/one','github.com','Saved issue','','unresolved','2026-01-02T00:00:00Z','2026-01-02T00:01:00Z','2026-01-02T00:01:00Z');
         INSERT INTO publication_connections VALUES ('uncertain','github','2026-01-02T00:00:01Z');",
    ).unwrap();
    drop(fixture);

    let mut workspace = Workspace::open(&path).unwrap();
    let notices = workspace
        .reconcile_github_migration(|host, login| {
            assert_eq!(host, "github.com");
            assert_eq!(login, None);
            Some(VerifiedGithubLogin {
                login: "SAM".into(),
                account_id: Some("id:1".into()),
            })
        })
        .unwrap();
    assert_eq!(notices, vec![GithubMigrationNotice {
        repository: "github.com/owner/three".into(),
        message: "The previous GitHub login pat differs from the active login and no active Project claims this repository.".into(),
    }]);
    let repositories = workspace.github_repositories().unwrap();
    assert_eq!(repositories.len(), 3);
    let one = &repositories[0];
    assert_eq!(one.rule.repository, "github.com/owner/one");
    assert_eq!(one.rule.assignee.as_deref(), Some("@me"));
    assert_eq!(one.error.as_ref().unwrap().code, "rate_limited");
    let two = &repositories[2];
    assert_eq!(two.rule.labels, ["bug"]);
    assert_eq!(two.project_login.as_deref(), Some("pat"));
    assert_eq!(workspace.show_ticket("T-AB").unwrap().id, "issue");
    assert_eq!(workspace.publication_attempts("T-AB").unwrap().len(), 1);
    assert_eq!(
        workspace
            .saved_sources()
            .unwrap()
            .into_iter()
            .map(|source| source.id)
            .collect::<Vec<_>>(),
        ["linear"]
    );
    drop(workspace);
    assert_eq!(
        Workspace::open(path)
            .unwrap()
            .github_repositories()
            .unwrap(),
        repositories
    );
}
