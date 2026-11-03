use ticketd_core::{DocumentPatch, Workspace};

#[test]
fn document_fields_survive_restart_and_edits_do_not_change_recent_order() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let first = workspace
        .create_document(None, "\nFirst thought\n")
        .unwrap();
    let second = workspace.create_document(Some("Second"), "Body").unwrap();
    workspace.open_document(&first.id).unwrap();
    workspace
        .change_document(
            &second.id,
            DocumentPatch {
                title: None,
                body: Some("Updated".into()),
            },
        )
        .unwrap();
    drop(workspace);
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace
            .recent_documents()
            .unwrap()
            .iter()
            .map(|d| d.id.as_str())
            .collect::<Vec<_>>(),
        vec![first.id.as_str(), second.id.as_str()]
    );
    assert_eq!(
        workspace.show_document(&first.id).unwrap().body,
        "\nFirst thought\n"
    );
    assert_eq!(
        workspace
            .show_document(&second.id)
            .unwrap()
            .title
            .as_deref(),
        Some("Second")
    );
    assert_eq!(workspace.show_document(&second.id).unwrap().body, "Updated");
}

#[test]
fn retry_and_export_preserve_document_identity_and_markdown() {
    use ticketd_core::{WriteRequest, WriteResult};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let request = || WriteRequest::CreateDocument {
        title: None,
        body: "# Source\n\n- [ ] Work\n".into(),
    };
    let first = workspace.write(Some("capture-1"), request()).unwrap();
    let second = workspace.write(Some("capture-1"), request()).unwrap();
    assert_eq!(first, second);
    let WriteResult::Document(document) = first else {
        panic!("expected document")
    };
    assert_eq!(workspace.recent_documents().unwrap().len(), 1);
    let export = workspace.export().unwrap();
    assert_eq!(export["documents"][0]["id"], document.id);
    assert_eq!(export["documents"][0]["body"], "# Source\n\n- [ ] Work\n");
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let restored = Workspace::open(&backup).unwrap();
    assert_eq!(
        restored.show_document(&document.id).unwrap().body,
        "# Source\n\n- [ ] Work\n"
    );
}

#[test]
fn replayed_patch_can_clear_title_without_replacing_body() {
    use ticketd_core::{WriteRequest, WriteResult};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let doc = workspace.create_document(Some("Old"), "Keep this").unwrap();
    let request: WriteRequest = serde_json::from_value(
        serde_json::json!({"operation":"change_document", "id":doc.id, "patch":{"title":null}}),
    )
    .unwrap();
    let WriteResult::Document(updated) = workspace.write(Some("clear-title"), request).unwrap()
    else {
        panic!("expected document")
    };
    assert_eq!(updated.title, None);
    assert_eq!(updated.body, "Keep this");
}

#[test]
fn trash_and_restore_preserve_document_across_restart_and_backup() {
    use ticketd_core::{WriteRequest, WriteResult};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let doc = workspace
        .create_document(Some("Context"), "# Original\n")
        .unwrap();
    let request = || WriteRequest::TrashDocument { id: doc.id.clone() };
    let first = workspace.write(Some("trash"), request()).unwrap();
    assert_eq!(first, workspace.write(Some("trash"), request()).unwrap());
    assert!(workspace.recent_documents().unwrap().is_empty());
    assert!(workspace.open_document(&doc.id).unwrap().trashed);
    assert!(
        workspace
            .change_document(
                &doc.id,
                DocumentPatch {
                    title: None,
                    body: Some("lost".into())
                }
            )
            .is_err()
    );
    assert_eq!(workspace.trashed_documents().unwrap()[0].id, doc.id);
    assert_eq!(workspace.export().unwrap()["documents"][0]["trashed"], 1);
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    drop(workspace);
    let mut workspace = Workspace::open(&backup).unwrap();
    assert!(workspace.show_document(&doc.id).unwrap().trashed);
    let WriteResult::Document(restored) = workspace
        .write(None, WriteRequest::RestoreDocument { id: doc.id.clone() })
        .unwrap()
    else {
        panic!("expected document")
    };
    assert!(!restored.trashed);
    assert_eq!(restored.body, "# Original\n");
    assert_eq!(workspace.recent_documents().unwrap()[0].id, doc.id);
}

#[test]
fn activity_details_are_atomic_hidden_and_preserved_on_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Work").unwrap();
    let reference = ticket.reference;
    assert!(
        workspace
            .add_activity_with_details(&reference, " ", None, Some("details"), None)
            .is_err()
    );
    assert!(workspace.recent_documents().unwrap().is_empty());
    let activity = workspace
        .add_activity_with_details(&reference, "Progress", None, Some("# Evidence\n"), None)
        .unwrap();
    let id = activity.supporting_document_id.as_deref().unwrap();
    assert_eq!(workspace.show_document(id).unwrap().body, "# Evidence\n");
    assert_eq!(
        workspace.show_document(id).unwrap().origin_brief.as_deref(),
        Some("Progress")
    );
    assert!(workspace.recent_documents().unwrap().is_empty());
    let export = workspace.export().unwrap();
    assert_eq!(
        export["documents"][0]["originating_activity_id"],
        activity.id
    );
    let backup = dir.path().join("activity-backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let restored = Workspace::open(&backup).unwrap();
    assert_eq!(
        restored
            .activity(&reference, &activity.id)
            .unwrap()
            .supporting_document_id
            .as_deref(),
        Some(id)
    );
    assert_eq!(restored.show_document(id).unwrap().body, "# Evidence\n");
    workspace.delete_activity(&reference, &activity.id).unwrap();
    assert_eq!(workspace.show_document(id).unwrap().body, "# Evidence\n");
    assert_eq!(workspace.recent_documents().unwrap()[0].id, id);
}

#[test]
fn retry_replays_activity_and_its_details() {
    use ticketd_core::{WriteRequest, WriteResult};
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Work").unwrap();
    let request = || WriteRequest::AddActivityWithDetails {
        reference: ticket.reference.clone(),
        brief: "Report".into(),
        agent: None,
        details: Some("Evidence".into()),
        existing_document_id: None,
    };
    let first = workspace.write(Some("report-1"), request()).unwrap();
    let second = workspace.write(Some("report-1"), request()).unwrap();
    assert_eq!(first, second);
    let WriteResult::Activity(activity) = first else {
        panic!("expected activity")
    };
    assert_eq!(
        workspace
            .show_document(activity.supporting_document_id.as_deref().unwrap())
            .unwrap()
            .body,
        "Evidence"
    );
    assert_eq!(
        workspace
            .activities(&ticket.reference, 100, 0)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn shared_support_and_trash_preserve_briefs_and_existing_document_visibility() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("Work").unwrap();
    let document = workspace
        .create_document(Some("Investigation"), "Evidence")
        .unwrap();
    let one = workspace
        .add_activity_with_details(&ticket.reference, "First", None, None, Some(&document.id))
        .unwrap();
    let two = workspace
        .add_activity_with_details(&ticket.reference, "Second", None, None, Some(&document.id))
        .unwrap();
    assert_eq!(workspace.recent_documents().unwrap()[0].id, document.id);
    workspace.set_document_trashed(&document.id, true).unwrap();
    assert_eq!(
        workspace
            .activity(&ticket.reference, &two.id)
            .unwrap()
            .brief,
        "Second"
    );
    workspace
        .delete_activity(&ticket.reference, &one.id)
        .unwrap();
    assert_eq!(
        workspace
            .activity(&ticket.reference, &two.id)
            .unwrap()
            .supporting_document_id
            .as_deref(),
        Some(document.id.as_str())
    );
    workspace.set_document_trashed(&document.id, false).unwrap();
    assert_eq!(
        workspace.show_document(&document.id).unwrap().body,
        "Evidence"
    );
    assert!(
        workspace
            .add_activity_with_details(&ticket.reference, "Failed", None, None, Some("missing"))
            .is_err()
    );
    assert_eq!(
        workspace
            .activities(&ticket.reference, 100, 0)
            .unwrap()
            .len(),
        1
    );
}
