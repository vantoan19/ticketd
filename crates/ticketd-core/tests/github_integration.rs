use rusqlite::Connection;
use ticketd_core::{
    Workspace,
    source::{AttemptState, GithubMigrationNotice, Ownership, VerifiedGithubLogin},
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
           ('github-2','Second','github','','{\"repositories\":[\"Owner/Two\",\"Owner/Three\"],\"labels\":[\"bug\"]}','pat','id:22',2,'2026-01-01T00:00:00Z','second'),
           ('linear','Team','linear','','{}','lin','lin',2,'2026-01-01T00:00:00Z','linear');
         INSERT INTO projects (id, name, path, remote) VALUES ('two','Two','/tmp/ticketd-fixture','github.com/owner/two');
         INSERT INTO source_connection_status (connection_id,last_attempt_at,last_refreshed_at,error_code,error_message,read_partitions)
         VALUES ('github','2026-01-05T00:00:00Z','2026-01-04T00:00:00Z','rate_limited','Wait','[\"owner/one\"]');
         INSERT INTO tickets (id, reference, title, body, status)
         VALUES ('issue','T-AB','Saved issue','','Todo'),
                ('tracked','T-AB2','Cached imported issue','Cached body','In progress');
         INSERT INTO external_identities
           (ticket_id,provider,external_id,locator,display,url,origin,partition,repository)
         VALUES ('tracked','github','91','owner/one#9','owner/one#9','https://github.com/owner/one/issues/9','imported','owner/one','github.com/owner/one');
         INSERT INTO external_ownership (ticket_id,authority) VALUES ('tracked','external');
         INSERT INTO source_sync (ticket_id,state_category,state_name,last_refreshed_at,last_attempt_at,last_error_code,last_error_message)
         VALUES ('tracked','open','Open','2026-01-04T00:00:00Z','2026-01-05T00:00:00Z','rate_limited','Wait');
         INSERT INTO source_connection_tickets VALUES ('tracked','github');
         INSERT INTO publication_attempts
           (id,ticket_id,provider,destination,destination_host,title,body,status,started_at,lease_expires_at,updated_at)
         VALUES
           ('uncertain','issue','github','owner/one','github.com','Saved issue','','unresolved','2026-01-02T00:00:00Z','2026-01-02T00:01:00Z','2026-01-02T00:01:00Z'),
           ('finished','tracked','github','owner/one','github.com','Cached imported issue','Cached body','succeeded','2026-01-02T00:00:00Z','2026-01-02T00:01:00Z','2026-01-02T00:01:00Z');
         INSERT INTO publication_connections VALUES
           ('uncertain','github','2026-01-02T00:00:01Z'), ('finished','github','2026-01-02T00:00:01Z');",
    ).unwrap();
    drop(fixture);

    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace
            .reconcile_github_migration(|_, _| None)
            .unwrap()
            .len(),
        3
    );
    let changed_login = workspace
        .reconcile_github_migration(|_, login| {
            Some(VerifiedGithubLogin {
                login: login.unwrap_or("SAM").into(),
                account_id: Some("id:99".into()),
            })
        })
        .unwrap();
    assert!(
        changed_login
            .iter()
            .any(|notice| notice.repository == "github.com/owner/two"
                && notice.message.contains("could not be verified"))
    );
    assert_eq!(
        workspace
            .github_project_login(Some("two"), "github.com")
            .unwrap(),
        None
    );
    let notices = workspace
        .reconcile_github_migration(|host, login| {
            assert_eq!(host, "github.com");
            Some(match login {
                Some("pat") => VerifiedGithubLogin {
                    login: "pat".into(),
                    account_id: Some("id:22".into()),
                },
                None => VerifiedGithubLogin {
                    login: "SAM".into(),
                    account_id: Some("id:1".into()),
                },
                _ => panic!("unexpected migration login"),
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
    let uncertain = &workspace.publication_attempts("T-AB").unwrap()[0];
    assert_eq!(uncertain.id, "uncertain");
    assert_eq!(uncertain.state, AttemptState::Unresolved);
    let cached = workspace.show_ticket("T-AB2").unwrap();
    assert_eq!(cached.id, "tracked");
    assert_eq!(cached.body, "Cached body");
    assert_eq!(cached.project_id, None);
    let source = cached.source.unwrap();
    assert_eq!(source.id, "91");
    assert_eq!(source.ownership, Ownership::External);
    assert_eq!(source.last_error.unwrap().code, "rate_limited");
    assert_eq!(
        workspace.publication_attempts("T-AB2").unwrap()[0].state,
        AttemptState::Succeeded
    );
    let export = workspace.export().unwrap();
    let context = export["github_publication_context"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["attempt_id"] == "uncertain")
        .unwrap();
    assert_eq!(context["host"], "github.com");
    assert_eq!(context["login"], "sam");
    assert_eq!(context["tracker_started_at"], "2026-01-02T00:00:01Z");
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

#[test]
fn overlapping_legacy_rules_keep_failures_and_only_share_coverage_for_the_same_account() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, 105).unwrap();
    let fixture = Connection::open(&path).unwrap();
    fixture.execute_batch(
        "INSERT INTO source_connections
           (id, name, provider, site, configuration, account, account_key, contract_version, saved_at, revision)
         VALUES
           ('one','One','github','','{\"repositories\":[\"owner/same\",\"owner/conflict\"]}','sam','id:1',2,'2026-01-01T00:00:00Z','one'),
           ('two','Two','github','','{\"repositories\":[\"owner/same\"]}','SAM','sam',2,'2026-01-01T00:00:00Z','two'),
           ('three','Three','github','','{\"repositories\":[\"owner/conflict\"]}','pat','id:2',2,'2026-01-01T00:00:00Z','three');
         INSERT INTO source_connection_status
           (connection_id,last_attempt_at,last_refreshed_at,error_code,error_message,last_checked_tickets,read_partitions)
         VALUES
           ('one','2026-01-04T00:00:00Z','2026-01-04T00:00:00Z',NULL,NULL,3,'[\"owner/same\",\"owner/conflict\"]'),
           ('two','2026-01-05T00:00:00Z',NULL,'unavailable','Offline',NULL,NULL),
           ('three','2026-01-06T00:00:00Z',NULL,'unauthenticated','Sign in again',NULL,NULL);",
    ).unwrap();
    drop(fixture);

    let mut workspace = Workspace::open(path).unwrap();
    let repositories = workspace.github_repositories().unwrap();
    assert!(
        repositories[0]
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("pat: Sign in again")
    );
    assert_eq!(repositories[0].last_refreshed_at, None);
    assert!(
        repositories[1]
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("SAM: Offline")
    );
    let token = workspace.change_token().unwrap();
    let notices = workspace
        .reconcile_github_migration(|_, login| {
            login.is_none().then(|| VerifiedGithubLogin {
                login: "sam".into(),
                account_id: Some("id:1".into()),
            })
        })
        .unwrap();
    assert!(workspace.change_token().unwrap() > token);
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].repository, "github.com/owner/conflict");
    let repositories = workspace.github_repositories().unwrap();
    assert_eq!(repositories[0].last_refreshed_at, None);
    assert_eq!(
        repositories[1].last_refreshed_at.as_deref(),
        Some("2026-01-04T00:00:00Z")
    );
    assert_eq!(repositories[1].error.as_ref().unwrap().message, "Offline");
    assert_eq!(
        workspace.source_statuses().unwrap()[0].last_checked_tickets,
        Some(3)
    );
}
