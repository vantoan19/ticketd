use ticketd_core::{DocumentPatch, RecordKind, Status, TicketPatch, Workspace};

#[allow(clippy::unwrap_used)] // A Workspace that cannot open fails the test during setup.
fn workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("versions.sqlite3")).unwrap();
    (dir, workspace)
}

fn body(text: &str) -> TicketPatch {
    TicketPatch {
        body: Some(text.into()),
        ..Default::default()
    }
}

#[test]
fn editing_a_ticket_saves_the_previous_version() {
    let (_dir, mut workspace) = workspace();
    let ticket = workspace.create_ticket("Fix login").unwrap();
    assert_eq!(
        workspace
            .versions(RecordKind::Ticket, &ticket.reference)
            .unwrap(),
        []
    );

    workspace
        .change_ticket(&ticket.reference, body("First draft"))
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                title: Some("Fix sign-in".into()),
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
        .unwrap();
    // Saving the same content again is not a change.
    workspace
        .change_ticket(&ticket.reference, body("First draft"))
        .unwrap();

    let versions = workspace
        .versions(RecordKind::Ticket, &ticket.reference)
        .unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0].changed, ["title", "status"]);
    assert_eq!(versions[1].changed, ["body"]);

    let newest = workspace.version(versions[0].id).unwrap();
    assert_eq!(newest.kind, RecordKind::Ticket);
    assert_eq!(newest.record_id, ticket.id);
    assert_eq!(newest.title.as_deref(), Some("Fix login"));
    assert_eq!(newest.body, "First draft");
    assert_eq!(newest.status, Some(Status::Todo));
    assert!(!newest.trashed);
    assert_eq!(workspace.version(versions[1].id).unwrap().body, "");
}

#[test]
fn trashing_a_ticket_saves_the_previous_version() {
    let (_dir, mut workspace) = workspace();
    let ticket = workspace.create_ticket("Fix login").unwrap();
    workspace
        .set_trashed(&ticket.reference, true, None)
        .unwrap();
    let versions = workspace
        .versions(RecordKind::Ticket, &ticket.reference)
        .unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].changed, ["trashed"]);
}

#[test]
fn editing_a_document_saves_the_previous_version() {
    let (_dir, mut workspace) = workspace();
    let document = workspace.create_document(Some("Notes"), "One").unwrap();
    workspace
        .change_document(
            &document.id,
            DocumentPatch {
                title: Some(None),
                body: Some("Two".into()),
                expected_updated_at: None,
                ..Default::default()
            },
        )
        .unwrap();
    // Opening a Document is not a change to it.
    workspace.open_document(&document.id).unwrap();

    let versions = workspace
        .versions(RecordKind::Document, &document.id)
        .unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].changed, ["title", "body"]);
    let version = workspace.version(versions[0].id).unwrap();
    assert_eq!(version.kind, RecordKind::Document);
    assert_eq!(version.title.as_deref(), Some("Notes"));
    assert_eq!(version.body, "One");
    assert_eq!(version.status, None);
}

#[test]
fn restoring_a_ticket_version_is_a_new_edit_that_appears_in_history() {
    let (_dir, mut workspace) = workspace();
    let ticket = workspace.create_ticket("Fix login").unwrap();
    workspace
        .change_ticket(&ticket.reference, body("Original"))
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                title: Some("Renamed".into()),
                body: Some("Rewritten".into()),
                status: Some(Status::Done),
                ..Default::default()
            },
        )
        .unwrap();
    let original = workspace
        .versions(RecordKind::Ticket, &ticket.reference)
        .unwrap()[0]
        .id;

    workspace.restore_version(original).unwrap();

    let restored = workspace.show_ticket(&ticket.reference).unwrap();
    assert_eq!(restored.title, "Fix login");
    assert_eq!(restored.body, "Original");
    assert_eq!(restored.status, Status::Todo);
    let versions = workspace
        .versions(RecordKind::Ticket, &ticket.reference)
        .unwrap();
    assert_eq!(versions.len(), 3);
    let replaced = workspace.version(versions[0].id).unwrap();
    assert_eq!(replaced.body, "Rewritten");
    assert_eq!(replaced.status, Some(Status::Done));
    // The restored version itself stays in history.
    assert_eq!(versions[1].id, original);
}

#[test]
fn restoring_a_document_version_is_a_new_edit_that_appears_in_history() {
    let (_dir, mut workspace) = workspace();
    let document = workspace.create_document(Some("Notes"), "One").unwrap();
    workspace
        .change_document(
            &document.id,
            DocumentPatch {
                title: Some(None),
                body: Some("Two".into()),
                expected_updated_at: None,
                ..Default::default()
            },
        )
        .unwrap();
    let first = workspace
        .versions(RecordKind::Document, &document.id)
        .unwrap()[0]
        .id;

    workspace.restore_version(first).unwrap();

    let restored = workspace.show_document(&document.id).unwrap();
    assert_eq!(restored.title.as_deref(), Some("Notes"));
    assert_eq!(restored.body, "One");
    let versions = workspace
        .versions(RecordKind::Document, &document.id)
        .unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(workspace.version(versions[0].id).unwrap().body, "Two");
}

#[test]
fn expiry_removes_only_versions_older_than_30_days() {
    let (_dir, mut workspace) = workspace();
    let ticket = workspace.create_ticket("Fix login").unwrap();
    workspace
        .change_ticket(&ticket.reference, body("Edited"))
        .unwrap();
    let versions = |workspace: &Workspace| {
        workspace
            .versions(RecordKind::Ticket, &ticket.reference)
            .unwrap()
    };
    let replaced_at =
        chrono::DateTime::parse_from_rfc3339(&versions(&workspace)[0].replaced_at).unwrap();
    let after = |duration: chrono::Duration| Some((replaced_at + duration).to_rfc3339());

    let at_30_days = after(chrono::Duration::days(30));
    assert_eq!(workspace.expire_versions(at_30_days.as_deref()).unwrap(), 0);
    assert_eq!(versions(&workspace).len(), 1);

    let past_30_days = after(chrono::Duration::days(30) + chrono::Duration::seconds(1));
    assert_eq!(
        workspace.expire_versions(past_30_days.as_deref()).unwrap(),
        1
    );
    assert_eq!(versions(&workspace), []);
    // The current version is the record itself and is never removed.
    assert_eq!(
        workspace.show_ticket(&ticket.reference).unwrap().body,
        "Edited"
    );
}
