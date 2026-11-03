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
fn search_tracks_edits_and_organization_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let first = workspace
        .create_document(None, "\nA rare compass in the forest")
        .unwrap();
    let second = workspace
        .create_document(Some("Compass notes"), "other")
        .unwrap();
    workspace.set_document_pin(&first.id, true).unwrap();
    workspace
        .set_document_tag(&first.id, "research", true)
        .unwrap();
    assert_eq!(
        workspace
            .search_documents("compass", None, 10, 0)
            .unwrap()
            .len(),
        2
    );
    workspace
        .change_document(
            &second.id,
            DocumentPatch {
                title: Some(Some("Changed".into())),
                body: None,
            },
        )
        .unwrap();
    drop(workspace);
    let workspace = Workspace::open(&path).unwrap();
    let results = workspace
        .search_documents("compass", Some("research"), 1, 0)
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, first.id);
    assert!(results[0].snippet.contains("compass"));
    assert_eq!(workspace.pinned_documents(10, 0).unwrap()[0].id, first.id);
    assert_eq!(
        workspace
            .search_documents("compass", None, 1, 1)
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn organization_writes_are_replayable_and_exported() {
    use ticketd_core::WriteRequest;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let document = workspace.create_document(None, "Example").unwrap();
    let pin = || WriteRequest::SetDocumentPin {
        id: document.id.clone(),
        pinned: true,
    };
    assert_eq!(
        workspace.write(Some("pin"), pin()).unwrap(),
        workspace.write(Some("pin"), pin()).unwrap()
    );
    workspace
        .write(
            Some("tag"),
            WriteRequest::SetDocumentTag {
                id: document.id.clone(),
                tag: "  Research ".into(),
                present: true,
            },
        )
        .unwrap();
    assert_eq!(
        workspace.document_tags(&document.id).unwrap(),
        vec!["research"]
    );
    let export = workspace.export().unwrap();
    assert_eq!(export["document_pins"][0]["document_id"], document.id);
    assert_eq!(export["document_tags"][0]["tag_name"], "research");
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
