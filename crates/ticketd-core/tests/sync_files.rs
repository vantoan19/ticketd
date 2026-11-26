//! The two-way converter between Workspace records and sync files
//! (`docs/sync-file-format.md`), through the shared-core interface.

use ticketd_core::{
    Error, EvidenceInput, EvidenceKind, RelationshipKind, Status, SyncKind, SyncRecord, SyncValue,
    TicketPatch, Workspace,
};

#[allow(clippy::unwrap_used)] // A Workspace that cannot open fails the test during setup.
fn workspace(directory: &tempfile::TempDir, name: &str) -> Workspace {
    Workspace::open(directory.path().join(name)).unwrap()
}

/// Every sync file of a Workspace, as (path, text), in a stable order.
#[allow(clippy::unwrap_used)] // Test setup; a failure here fails the test.
fn export_all(workspace: &Workspace) -> Vec<(String, String)> {
    let mut files = Vec::new();
    for kind in SyncKind::ALL {
        for id in workspace.sync_record_ids(kind).unwrap() {
            let record = workspace.export_sync_record(kind, &id).unwrap();
            files.push((record.path(), record.to_markdown()));
        }
    }
    files
}

/// Applies files in the given order, then once more for records whose targets arrived later.
#[allow(clippy::unwrap_used)] // Test setup; a failure here fails the test.
fn import_all(workspace: &mut Workspace, files: &[(String, String)]) {
    for round in 0..2 {
        let mut missing = Vec::new();
        for (path, text) in files {
            let record = SyncRecord::parse(text).unwrap();
            missing.extend(
                workspace
                    .apply_sync_record(&record)
                    .unwrap()
                    .into_iter()
                    .map(|target| (path.clone(), target)),
            );
        }
        if round == 1 {
            assert_eq!(missing, []);
        }
    }
}

#[test]
fn a_ticket_exports_as_one_markdown_file_with_a_yaml_header() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = workspace(&directory, "a.sqlite3");
    let ticket = workspace.create_ticket("Fix \"login\"").unwrap();
    workspace
        .change_ticket(
            "T-KQ1",
            TicketPatch {
                body: Some("Users are logged out.\n\n- after 5 minutes".into()),
                status: Some(Status::InProgress),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    workspace.add_tag("T-KQ1", "urgent").unwrap();
    workspace.add_tag("T-KQ1", "backend").unwrap();

    let record = workspace
        .export_sync_record(SyncKind::Ticket, &ticket.id)
        .unwrap();

    assert_eq!(record.path(), format!("tickets/{}.md", ticket.id));
    assert_eq!(
        record.to_markdown(),
        format!(
            "---\nkind: ticket\nformat: 1\nid: \"{}\"\nref: \"T-KQ1\"\ntitle: \"Fix \\\"login\\\"\"\nstatus: \"In progress\"\ntags:\n  - \"backend\"\n  - \"urgent\"\ntrashed: false\nfollowing: false\n---\nUsers are logged out.\n\n- after 5 minutes\n",
            ticket.id
        )
    );
    assert_eq!(SyncRecord::parse(&record.to_markdown()).unwrap(), record);
}

/// A Workspace using every synced record kind, field and relationship.
#[allow(clippy::unwrap_used)] // Test setup; a failure here fails the test.
fn populated(directory: &tempfile::TempDir) -> Workspace {
    let mut workspace = workspace(directory, "source.sqlite3");
    let checkout = directory.path().join("checkout");
    std::fs::create_dir(&checkout).unwrap();
    let project = workspace
        .create_project("Website", checkout.to_str().unwrap())
        .unwrap();
    let plan = workspace.create_plan("Launch").unwrap();
    workspace
        .set_plan_purpose(&plan.id, "Ship the **site**.\n")
        .unwrap();
    let spec = workspace
        .create_document(Some("Spec"), "# Spec\n\nSee T-KQ1.")
        .unwrap();
    let notes = workspace.create_document(None, "").unwrap();
    workspace.set_plan_spec(&plan.id, Some(&spec.id)).unwrap();
    workspace
        .set_plan_document(&plan.id, &notes.id, true)
        .unwrap();
    workspace.set_document_pin(&spec.id, true).unwrap();
    workspace
        .set_document_tag(&spec.id, "design", true)
        .unwrap();
    workspace.set_document_trashed(&notes.id, true).unwrap();

    workspace
        .create_ticket_in_context("Fix login", Some(&project.id), Some(&plan.id))
        .unwrap();
    workspace.create_ticket("Add logout").unwrap();
    workspace.create_ticket("Old report").unwrap();
    let fourth = workspace.create_ticket("Subtask").unwrap();
    assert_eq!(fourth.reference, "T-KQ4");
    workspace
        .change_ticket(
            "T-KQ1",
            TicketPatch {
                body: Some(format!(
                    "Body with a [link](ticketd://document/{}).\n",
                    spec.id
                )),
                status: Some(Status::InReview),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    workspace.add_tag("T-KQ1", "backend").unwrap();
    workspace.add_dependency("T-KQ1", "T-KQ2", None).unwrap();
    workspace.set_parent("T-KQ4", Some("T-KQ1"), None).unwrap();
    workspace
        .add_contextual_relationship("T-KQ1", "T-KQ2", RelationshipKind::Related, None)
        .unwrap();
    workspace
        .add_contextual_relationship("T-KQ2", "T-KQ3", RelationshipKind::Discovered, None)
        .unwrap();
    workspace
        .mark_duplicate("T-KQ3", "T-KQ2", Some("codex"))
        .unwrap();
    workspace
        .set_ticket_document("T-KQ1", &spec.id, true)
        .unwrap();
    workspace.set_following("T-KQ1", true).unwrap();
    workspace
        .set_reminder("T-KQ1", Some("2031-01-02T03:04:05Z"))
        .unwrap();
    workspace.set_trashed("T-KQ4", true, None).unwrap();

    workspace
        .add_activity("T-KQ1", "Started.\n\nSee T-KQ2.", Some("codex"))
        .unwrap();
    workspace
        .add_activity_with_details(
            "T-KQ1",
            "Investigated",
            None,
            Some("# Findings\n\nLong details."),
            None,
        )
        .unwrap();
    workspace
        .add_activity_with_details("T-KQ2", "Read the spec", None, None, Some(&spec.id))
        .unwrap();
    workspace
        .add_evidence(
            "T-KQ1",
            EvidenceInput {
                kind: EvidenceKind::PullRequest,
                name: "PR 12".into(),
                value: "https://example.test/pull/12".into(),
                editing_agent: Some("codex".into()),
            },
        )
        .unwrap();
    workspace
}

#[test]
fn every_record_kind_round_trips_into_an_empty_workspace() {
    let directory = tempfile::tempdir().unwrap();
    let source = populated(&directory);
    let files = export_all(&source);
    assert_eq!(
        SyncKind::ALL.map(|kind| source.sync_record_ids(kind).unwrap().len()),
        // Agents and Automations round-trip in `automation_sync.rs`.
        [1, 3, 1, 4, 0, 0]
    );

    // Reversed: every relationship arrives before its target.
    let mut reversed = workspace(&directory, "reversed.sqlite3");
    import_all(
        &mut reversed,
        &files.iter().rev().cloned().collect::<Vec<_>>(),
    );
    let mut ordered = workspace(&directory, "ordered.sqlite3");
    import_all(&mut ordered, &files);

    assert_eq!(export_all(&reversed), files);
    assert_eq!(export_all(&ordered), files);
    // The imported Workspace works through the ordinary interface.
    let ticket = reversed.show_ticket("T-KQ1").unwrap();
    assert_eq!(ticket.status, Status::InReview);
    assert_eq!(ticket.children[0].reference, "T-KQ4");
    assert_eq!(
        reversed.show_ticket("T-KQ2").unwrap().prerequisites.len(),
        1
    );
    assert_eq!(
        reversed
            .show_ticket("T-KQ3")
            .unwrap()
            .duplicate_of
            .as_deref(),
        Some("T-KQ2")
    );
    assert_eq!(reversed.activities("T-KQ1", 10, 0).unwrap().len(), 2);
    // Links index even though the Document arrived after the ticket that links to it.
    let spec = &source.pinned_documents(10, 0).unwrap()[0];
    let backlinks = source.document_backlinks(&spec.id, 10, 0).unwrap();
    assert!(!backlinks.is_empty());
    assert_eq!(
        reversed.document_backlinks(&spec.id, 10, 0).unwrap().len(),
        backlinks.len()
    );
}

#[test]
fn device_local_data_is_not_exported() {
    let directory = tempfile::tempdir().unwrap();
    let mut source = populated(&directory);
    let checkout = directory.path().join("checkout").canonicalize().unwrap();
    let project = source.list_projects().unwrap().remove(0);
    let remote = "github.com/acme/website";
    source
        .edit_project_with_remote(
            &project.id,
            &project.name,
            &project.path,
            ticketd_core::ProjectRemoteChange::Set(remote),
        )
        .unwrap();

    let files = export_all(&source);

    assert!(source.list_projects().unwrap()[0].path.contains("checkout"));
    for (path, text) in &files {
        assert!(!text.contains("checkout"), "{path} carries a checkout path");
        assert!(!text.contains(checkout.to_str().unwrap()));
        assert!(!text.contains(remote), "{path} carries a Project remote");
        assert!(!text.contains("read"), "{path} carries inbox state");
    }
    let mut target = workspace(&directory, "target.sqlite3");
    import_all(&mut target, &files);
    let imported = target.show_project(&project.id).unwrap();
    assert!(imported.paths.is_empty());
    assert!(imported.remote.is_none());
    assert_eq!(
        target.show_ticket("T-KQ1").unwrap().project_id.as_deref(),
        Some(project.id.as_str())
    );
    assert_eq!(target.inbox(10, 0).unwrap(), []);
}

#[test]
fn applying_a_changed_file_updates_the_record_with_the_same_guid() {
    let directory = tempfile::tempdir().unwrap();
    let source = populated(&directory);
    let mut target = workspace(&directory, "target.sqlite3");
    import_all(&mut target, &export_all(&source));
    let id = source.show_ticket("T-KQ1").unwrap().id;
    let mut record = source.export_sync_record(SyncKind::Ticket, &id).unwrap();

    record
        .fields
        .insert("title".into(), SyncValue::Text("Fix sign-in".into()));
    record
        .fields
        .insert("body".into(), SyncValue::Text("See T-KQ3.".into()));
    record.fields.remove("parent");
    record.fields.remove("reminder");
    record
        .fields
        .insert("trashed".into(), SyncValue::Flag(true));
    record.fields.insert(
        "tags".into(),
        SyncValue::Set(["frontend".to_owned()].into()),
    );
    record.parts.remove(0);
    let edited = SyncRecord::parse(&record.to_markdown()).unwrap();
    assert_eq!(target.apply_sync_record(&edited).unwrap(), []);

    let ticket = target.show_ticket("T-KQ1").unwrap();
    assert_eq!(ticket.id, id);
    assert_eq!(ticket.title, "Fix sign-in");
    assert!(ticket.trashed);
    assert_eq!(ticket.tags, ["frontend"]);
    assert_eq!(target.reminder("T-KQ1").unwrap(), None);
    assert_eq!(target.activities("T-KQ1", 10, 0).unwrap().len(), 1);
    assert_eq!(target.list_trash().unwrap().len(), 2);
    assert_eq!(
        target.export_sync_record(SyncKind::Ticket, &id).unwrap(),
        edited
    );
    // Applying the same file again changes nothing a view shows.
    let token = target.change_token().unwrap();
    assert_eq!(target.apply_sync_record(&edited).unwrap(), []);
    assert_eq!(target.change_token().unwrap(), token);
}

#[test]
fn a_relationship_to_a_record_that_has_not_arrived_is_reported_and_applied_later() {
    let directory = tempfile::tempdir().unwrap();
    let source = populated(&directory);
    let blocker = source.show_ticket("T-KQ1").unwrap().id;
    let blocked = source.show_ticket("T-KQ2").unwrap().id;
    let record = source
        .export_sync_record(SyncKind::Ticket, &blocked)
        .unwrap();
    let mut target = workspace(&directory, "target.sqlite3");

    let missing = target.apply_sync_record(&record).unwrap();

    assert!(
        missing
            .iter()
            .any(|target| target.field == "blocked_by" && target.id == blocker)
    );
    assert_eq!(target.show_ticket("T-KQ2").unwrap().title, "Add logout");
    assert_eq!(target.show_ticket("T-KQ2").unwrap().prerequisites, []);
    import_all(&mut target, &export_all(&source));
    assert_eq!(
        target.show_ticket("T-KQ2").unwrap().prerequisites[0].reference,
        "T-KQ1"
    );
}

#[test]
fn text_that_looks_like_file_structure_round_trips() {
    let directory = tempfile::tempdir().unwrap();
    let mut source = workspace(&directory, "source.sqlite3");
    let hostile = "---\nid: nope\n---\n<!-- ticketd:activity -->\n\\<!-- ticketd:evidence -->\r\nends with blank lines\n\n";
    let ticket = source
        .create_ticket("true: [x] #1 \u{85}\u{2028} é \\ '")
        .unwrap();
    source
        .change_ticket(
            "T-KQ1",
            TicketPatch {
                body: Some(hostile.into()),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    source.add_activity("T-KQ1", hostile, None).unwrap();
    source.add_tag("T-KQ1", "null").unwrap();
    source.add_tag("T-KQ1", "123").unwrap();
    let document = source.create_document(Some(""), "").unwrap();

    let mut target = workspace(&directory, "target.sqlite3");
    import_all(&mut target, &export_all(&source));

    assert_eq!(export_all(&target), export_all(&source));
    let copy = target.show_ticket("T-KQ1").unwrap();
    assert_eq!(copy.title, ticket.title);
    assert_eq!(copy.body, hostile);
    assert_eq!(copy.tags, ["123", "null"]);
    assert_eq!(target.activities("T-KQ1", 10, 0).unwrap()[0].brief, hostile);
    assert_eq!(
        target.show_document(&document.id).unwrap().title.as_deref(),
        Some("")
    );
}

#[test]
fn a_file_edited_by_hand_in_ordinary_yaml_is_accepted() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = workspace(&directory, "a.sqlite3");
    let text = "---\r\nkind: ticket\r\nid: 3f2c9a1e-0000-4000-8000-000000000001\r\nref: T-ZZ7\r\ntitle: Fix login   # comment\r\nstatus: Todo\r\ntags: [Backend, urgent]\r\nproject: ~\r\n---\r\nBody";

    let record = SyncRecord::parse(text).unwrap();
    workspace.apply_sync_record(&record).unwrap();

    let ticket = workspace.show_ticket("T-ZZ7").unwrap();
    assert_eq!(ticket.title, "Fix login");
    assert_eq!(ticket.body, "Body");
    assert_eq!(ticket.tags, ["backend", "urgent"]);
    // A ticket from another device keeps its reference and does not use this device's counter.
    assert_eq!(workspace.create_ticket("Local").unwrap().reference, "T-KQ1");
}

#[test]
fn a_malformed_file_is_rejected_with_the_reason_and_changes_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = workspace(&directory, "a.sqlite3");
    let ticket = workspace.create_ticket("Fix login").unwrap();
    let good = workspace
        .export_sync_record(SyncKind::Ticket, &ticket.id)
        .unwrap()
        .to_markdown();
    let other = "3f2c9a1e-0000-4000-8000-000000000002";
    let cases = [
        (String::new(), "start with a '---' line"),
        ("no header".into(), "start with a '---' line"),
        ("---\nkind: ticket\n".into(), "closing '---' line"),
        (
            good.replace("kind: ticket", "kind: [ticket"),
            "not valid YAML",
        ),
        (good.replace("kind: ticket", "kind: effort"), "'kind'"),
        (good.replace(&ticket.id, "42"), "'id'"),
        (good.replace("title: \"Fix login\"\n", ""), "'title'"),
        (good.replace("\"Fix login\"", "\" \""), "'title'"),
        (good.replace("\"Fix login\"", "2024"), "'title'"),
        (good.replace("\"Todo\"", "\"Doing\""), "'status'"),
        (good.replace("\"T-KQ1\"", "\"T-1\""), "'ref'"),
        (
            good.replace("trashed: false", "trashed: \"no\""),
            "'trashed'",
        ),
        (
            good.replace("trashed: false", "colour: \"red\""),
            "'colour'",
        ),
        (
            good.replace("trashed: false", "reminder: \"tomorrow\""),
            "'reminder'",
        ),
        (
            good.replace("trashed: false", "blocked_by: [\"KQ2\"]"),
            "'blocked_by'",
        ),
        (
            good.replace("trashed: false", &format!("parent: \"{}\"", ticket.id)),
            "'parent'",
        ),
        // Its own reference names the ticket itself as much as its id does.
        (
            good.replace("trashed: false", "parent: \"T-KQ1\""),
            "'parent'",
        ),
        (good.replace("format: 1", "format: 5"), "newer ticketd"),
        (good.replace("format: 1", "format: one"), "'format'"),
        (
            good.replace("trashed: false", "source_provider: \"github\""),
            "'source_",
        ),
        (
            format!("{good}<!-- ticketd:activity -->\n---\nid: \"{other}\"\n---\ntext\n"),
            "'reported_at'",
        ),
        (
            format!(
                "{good}<!-- ticketd:evidence -->\n---\nid: \"{other}\"\nkind: \"guess\"\nname: \"n\"\nvalue: \"v\"\ncreated_at: \"2026-01-01T00:00:00Z\"\nupdated_at: \"2026-01-01T00:00:00Z\"\n---\n"
            ),
            "'kind'",
        ),
    ];

    for (text, reason) in cases {
        match SyncRecord::parse(&text) {
            Err(Error::SyncFile(message)) => {
                assert!(message.contains(reason), "{message:?} lacks {reason:?}");
            }
            other => panic!("expected {reason:?}, got {other:?} for {text:?}"),
        }
    }
    assert_eq!(
        workspace
            .export_sync_record(SyncKind::Ticket, &ticket.id)
            .unwrap()
            .to_markdown(),
        good
    );
}

#[test]
fn a_file_that_cannot_be_applied_leaves_the_workspace_unchanged() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = workspace(&directory, "a.sqlite3");
    let ticket = workspace.create_ticket("Fix login").unwrap();
    let before = export_all(&workspace);
    let good = &before[0].1;
    // Another ticket claiming this reference, and this ticket claiming another reference.
    let clash = good
        .replace(&ticket.id, "3f2c9a1e-0000-4000-8000-000000000003")
        .replace("Fix login", "Impostor");
    let renamed = good
        .replace("T-KQ1", "T-KQ9")
        .replace("Fix login", "Renamed");

    for text in [clash, renamed] {
        let record = SyncRecord::parse(&text).unwrap();
        let error = workspace.apply_sync_record(&record).unwrap_err();
        assert!(matches!(error, Error::SyncFile(_)), "{error:?}");
    }

    assert_eq!(export_all(&workspace), before);
}

const GITHUB_ISSUE: &str = "---\nkind: ticket\nformat: 1\nid: \"3f2c9a1e-0000-4000-8000-000000000001\"\nref: \"T-ZZ7\"\ntitle: \"Imported\"\nstatus: \"Done\"\ntrashed: false\nfollowing: false\nsource_provider: \"github\"\nsource_external_id: \"7\"\nsource_locator: \"acme/site#42\"\nsource_display: \"acme/site#42\"\nsource_url: \"https://example.test/acme/site/issues/42\"\nsource_origin: \"imported\"\nsource_linked_at: \"2026-01-02T03:04:05.000Z\"\nsource_authority: \"external\"\nsource_authority_changed_at: \"2026-01-02T03:04:05.000Z\"\nsource_state: \"closed\"\nsource_closure_reason: \"completed\"\nsource_updated_at: \"2026-01-03T00:00:00Z\"\n---\nFrom the tracker.\n";

#[test]
fn external_source_provenance_travels_with_the_ticket() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = workspace(&directory, "a.sqlite3");
    let text = GITHUB_ISSUE;
    let record = SyncRecord::parse(text).unwrap();

    workspace.apply_sync_record(&record).unwrap();

    let ticket = workspace.show_ticket("T-ZZ7").unwrap();
    let source = ticket.source.unwrap();
    assert_eq!(source.locator, "acme/site#42");
    assert_eq!(source.ownership, ticketd_core::source::Ownership::External);
    let repository = |workspace: &Workspace| {
        workspace.export().unwrap()["external_identities"][0]["repository"].clone()
    };
    assert_eq!(repository(&workspace), "example.test/acme/site");
    assert_eq!(
        source.state.category,
        ticketd_core::source::StateCategory::Completed
    );
    assert_eq!(source.state.name.as_deref(), Some("Closed"));
    let markdown = workspace
        .export_sync_record(SyncKind::Ticket, &ticket.id)
        .unwrap()
        .to_markdown();
    assert!(markdown.contains("format: 3\n"));
    assert!(markdown.contains("source_state_category: \"completed\"\n"));
    assert!(markdown.contains("source_state_name: \"Closed\"\n"));
    assert!(markdown.contains("source_partition: \"@example.test/acme/site\"\n"));
    let parsed = SyncRecord::parse(&markdown).unwrap();
    assert_eq!(parsed, record);
    let mut other = Workspace::open(directory.path().join("b.sqlite3")).unwrap();
    other.apply_sync_record(&parsed).unwrap();
    assert_eq!(
        other.show_ticket("T-ZZ7").unwrap().source.unwrap().state,
        source.state
    );
    assert_eq!(
        other
            .export_sync_record(SyncKind::Ticket, &ticket.id)
            .unwrap()
            .to_markdown(),
        markdown
    );
    assert_eq!(
        SyncRecord::parse(&text.replace("format: 1\n", "")).unwrap(),
        record
    );
    assert!(SyncRecord::parse(&markdown.replace("format: 3", "format: 2")).is_err());
    let old_enterprise = markdown.replace("https://example.test/", "https://example.test:8443/");
    let parsed = SyncRecord::parse(&old_enterprise).unwrap();
    assert_eq!(
        parsed.fields["source_external_id"],
        SyncValue::Text("@example.test:8443:7".into())
    );
    assert_eq!(
        parsed.fields["source_partition"],
        SyncValue::Text("@example.test:8443/acme/site".into())
    );

    // A transfer on another device replaces the stored repository as well as the locator.
    let transferred = text.replace("acme/site", "acme/moved");
    workspace
        .apply_sync_record(&SyncRecord::parse(&transferred).unwrap())
        .unwrap();
    assert_eq!(repository(&workspace), "example.test/acme/moved");
    // A locator without a matching canonical URL cannot contribute a repository.
    let unknown = transferred.replace(
        "source_locator: \"acme/moved",
        "source_locator: \"acme/elsewhere",
    );
    workspace
        .apply_sync_record(&SyncRecord::parse(&unknown).unwrap())
        .unwrap();
    assert!(repository(&workspace).is_null());
    // Another device taking the ticket over arrives as a changed field.
    let taken = SyncRecord::parse(&unknown.replace(
        "source_authority: \"external\"",
        "source_authority: \"local\"",
    ))
    .unwrap();
    workspace.apply_sync_record(&taken).unwrap();
    assert_eq!(
        workspace
            .show_ticket("T-ZZ7")
            .unwrap()
            .source
            .unwrap()
            .ownership,
        ticketd_core::source::Ownership::Local
    );
}

#[test]
fn syncing_the_same_github_issue_preserves_local_pause_and_conversation() {
    use ticketd_core::source::ConversationEntry;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let unverified = GITHUB_ISSUE.replace("https://example.test/acme/site/issues/42", "");
    let record = SyncRecord::parse(&unverified).unwrap();
    let reference = "T-ZZ7";
    workspace.apply_sync_record(&record).unwrap();
    rusqlite::Connection::open(path)
        .unwrap()
        .execute_batch(
            "INSERT INTO source_connection_removals (ticket_id, removed_at)
             SELECT id, '2026-01-04T00:00:00Z' FROM tickets;
             INSERT INTO source_conversation (ticket_id, kind, entry_id, position, actor, body, created_at)
             SELECT id, 'comment', 'comment-1', 0, 'octocat', 'Cached reply', '2026-01-04T00:00:00Z' FROM tickets;",
        )
        .unwrap();
    let conversation = workspace.source_conversation(reference).unwrap();
    assert!(
        matches!(&conversation[..], [ConversationEntry::Comment { body, .. }] if body == "Cached reply")
    );

    // Confirm the host first, then follow a transfer on the same site.
    let transferred = GITHUB_ISSUE
        .replace("source_external_id: \"7\"", "source_external_id: \"9\"")
        .replace("acme/site", "acme/moved");
    for (text, expected_id) in [
        (GITHUB_ISSUE, "@example.test:7"),
        (&transferred, "@example.test:9"),
    ] {
        workspace
            .apply_sync_record(&SyncRecord::parse(text).unwrap())
            .unwrap();
        let source = workspace.show_ticket(reference).unwrap().source.unwrap();
        assert_eq!(source.id, expected_id);
        assert_eq!(source.unavailable.unwrap().code, "connection_removed");
        assert_eq!(
            workspace.source_conversation(reference).unwrap(),
            conversation
        );
    }

    // A different site on the same host does not share its cached issue.
    let other = transferred
        .replace("example.test", "example.test:8443")
        .replace("acme/moved", "acme/another");
    workspace
        .apply_sync_record(&SyncRecord::parse(&other).unwrap())
        .unwrap();
    let source = workspace.show_ticket(reference).unwrap().source.unwrap();
    assert_eq!(source.id, "@example.test:8443:9");
    assert_ne!(source.unavailable.unwrap().code, "connection_removed");
    assert!(workspace.source_conversation(reference).unwrap().is_empty());
}

#[test]
fn project_sync_files_in_older_formats_read_as_active() {
    let id = "3f2c9a1e-0000-4000-8000-000000000001";
    let directory = tempfile::tempdir().unwrap();
    let mut target = workspace(&directory, "target.sqlite3");
    for format in 1..=3 {
        let legacy =
            format!("---\nkind: project\nformat: {format}\nid: {id}\nname: Website\n---\n");
        let record = SyncRecord::parse(&legacy).unwrap();
        assert_eq!(record.fields.get("archived"), Some(&SyncValue::Flag(false)));
        assert_eq!(target.apply_sync_record(&record).unwrap(), []);
        assert!(!target.show_project(id).unwrap().archived);
    }
}

#[test]
fn documents_plans_and_projects_update_by_guid() {
    let directory = tempfile::tempdir().unwrap();
    let source = populated(&directory);
    let mut target = workspace(&directory, "target.sqlite3");
    import_all(&mut target, &export_all(&source));
    let spec = source.pinned_documents(10, 0).unwrap()[0].id.clone();

    let edit = |workspace: &Workspace, kind, id: &str, from: &str, to: &str| {
        let text = workspace
            .export_sync_record(kind, id)
            .unwrap()
            .to_markdown();
        assert!(text.contains(from), "{text}");
        SyncRecord::parse(&text.replace(from, to)).unwrap()
    };
    let plan = source.list_plans(true).unwrap()[0].id.clone();
    let project = source.list_projects().unwrap()[0].id.clone();

    for record in [
        edit(&source, SyncKind::Document, &spec, "# Spec", "# Design"),
        edit(
            &source,
            SyncKind::Plan,
            &plan,
            "archived: false",
            "archived: true",
        ),
        edit(&source, SyncKind::Project, &project, "Website", "Web"),
    ] {
        assert_eq!(target.apply_sync_record(&record).unwrap(), []);
        assert_eq!(
            target.export_sync_record(record.kind, &record.id).unwrap(),
            record
        );
    }

    let after = target.show_document(&spec).unwrap();
    assert_eq!(after.body, "# Design\n\nSee T-KQ1.");
    assert!(target.show_plan(&plan).unwrap().plan.archived);
    assert_eq!(target.show_project(&project).unwrap().name, "Web");
}

/// F37: the documented example is what a person copies; it must parse exactly as written.
#[test]
fn every_example_file_in_the_format_document_parses_as_written() {
    let document = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/sync-file-format.md"
    ))
    .unwrap()
    .replace("\r\n", "\n");
    let examples: Vec<&str> = document
        .split("```markdown\n")
        .skip(1)
        .map(|rest| rest.split("\n```").next().unwrap())
        .collect();
    assert!(!examples.is_empty());
    for example in examples {
        let record = SyncRecord::parse(&format!("{example}\n")).unwrap_or_else(|error| {
            panic!("the example does not parse: {error}\n{example}");
        });
        assert_eq!(record.parts.len(), 1);
        assert_eq!(
            record.fields.get("body"),
            Some(&SyncValue::Text(
                "Users are logged out after 5 minutes.".into()
            ))
        );
    }
}
