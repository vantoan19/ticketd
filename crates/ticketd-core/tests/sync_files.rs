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
    let source = populated(&directory);
    let checkout = directory.path().join("checkout").canonicalize().unwrap();

    let files = export_all(&source);

    assert!(source.list_projects().unwrap()[0].path.contains("checkout"));
    for (path, text) in &files {
        assert!(!text.contains("checkout"), "{path} carries a checkout path");
        assert!(!text.contains(checkout.to_str().unwrap()));
        assert!(!text.contains("read"), "{path} carries inbox state");
    }
    let mut target = workspace(&directory, "target.sqlite3");
    import_all(&mut target, &files);
    assert_eq!(
        target.list_projects().unwrap()[0].paths,
        Vec::<String>::new()
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
        (good.replace("format: 1", "format: 2"), "newer ticketd"),
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

#[test]
fn external_source_provenance_travels_with_the_ticket() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = workspace(&directory, "a.sqlite3");
    let text = "---\nkind: ticket\nformat: 1\nid: \"3f2c9a1e-0000-4000-8000-000000000001\"\nref: \"T-ZZ7\"\ntitle: \"Imported\"\nstatus: \"Done\"\ntrashed: false\nfollowing: false\nsource_provider: \"github\"\nsource_external_id: \"I_42\"\nsource_locator: \"acme/site#42\"\nsource_display: \"acme/site#42\"\nsource_url: \"https://example.test/acme/site/issues/42\"\nsource_origin: \"imported\"\nsource_linked_at: \"2026-01-02T03:04:05.000Z\"\nsource_authority: \"external\"\nsource_authority_changed_at: \"2026-01-02T03:04:05.000Z\"\nsource_state: \"closed\"\nsource_closure_reason: \"completed\"\nsource_updated_at: \"2026-01-03T00:00:00Z\"\n---\nFrom the tracker.\n";
    let record = SyncRecord::parse(text).unwrap();

    workspace.apply_sync_record(&record).unwrap();

    let ticket = workspace.show_ticket("T-ZZ7").unwrap();
    let source = ticket.source.unwrap();
    assert_eq!(source.locator, "acme/site#42");
    assert_eq!(source.ownership, ticketd_core::source::Ownership::External);
    assert_eq!(
        workspace
            .export_sync_record(SyncKind::Ticket, &ticket.id)
            .unwrap()
            .to_markdown(),
        text
    );
    // Another device taking the ticket over arrives as a changed field.
    let taken = SyncRecord::parse(&text.replace(
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
