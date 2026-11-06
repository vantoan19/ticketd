use ticketd_core::{
    AttachmentKind, Workspace,
    drive::{AttachmentProvider, DriveError, DriveMetadata},
};

struct SelectedFile;
impl AttachmentProvider for SelectedFile {
    fn metadata(&self, file_id: &str, _: Option<&str>) -> Result<DriveMetadata, DriveError> {
        Ok(DriveMetadata {
            id: file_id.into(),
            name: "Current plan".into(),
            mime_type: "application/vnd.google-apps.document".into(),
            size_bytes: None,
            web_url: format!("https://docs.google.com/document/d/{file_id}/edit"),
            resource_key: None,
        })
    }
}

#[test]
fn selected_native_files_are_reusable_current_references_without_local_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let connection = uuid::Uuid::new_v4().to_string();
    let file = workspace
        .reference_drive_file(&connection, "selected-doc", None, &SelectedFile)
        .unwrap();
    assert_eq!(file.kind, AttachmentKind::ExternalReference);
    assert!(serde_json::to_value(&file).unwrap()["size_bytes"].is_null());
    assert_eq!(
        workspace.attachment_open_target(&file.id).unwrap(),
        ticketd_core::AttachmentOpenTarget::ExternalUrl(
            "https://docs.google.com/document/d/selected-doc/edit".into()
        )
    );
    assert_eq!(
        workspace
            .reference_drive_file(&connection, "selected-doc", None, &SelectedFile)
            .unwrap()
            .id,
        file.id
    );
    let ticket = workspace.create_ticket("Read current plan").unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let document = workspace
        .create_document(None, &format!("See [my plan]({uri})."))
        .unwrap();
    assert_eq!(
        workspace.embedded_attachments(&document.id).unwrap()[0].id,
        file.id
    );
    assert!(
        workspace
            .export_attachment(&file.id, dir.path().join("original.doc"))
            .unwrap_err()
            .to_string()
            .contains("external reference")
    );
    assert_eq!(
        workspace
            .drive_reference(&file.id)
            .unwrap()
            .metadata
            .size_bytes,
        None
    );
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let content = workspace
        .inspect_backup(&backup)
        .unwrap()
        .attachment_content
        .unwrap();
    assert_eq!(content.remote_references, 1);
    assert_eq!(content.local_snapshots, 0);
    assert_eq!(content.retained_bytes, 0);
    assert_eq!(
        workspace.export().unwrap()["drive_references"][0]["file_id"],
        "selected-doc"
    );
    let restored_path = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored_path, &backup).unwrap();
    let restored = Workspace::open(restored_path).unwrap();
    assert_eq!(
        restored.drive_reference(&file.id).unwrap(),
        workspace.drive_reference(&file.id).unwrap()
    );
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.resolve_attachment_uri(&uri).unwrap(), file);
    workspace
        .set_ticket_attachment(&ticket.reference, &file.id, false)
        .unwrap();
    assert_eq!(workspace.attachment(&file.id).unwrap(), file);
}

#[test]
fn concurrent_selection_reuses_identity_and_failed_reference_save_rolls_back() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let connection = uuid::Uuid::new_v4().to_string();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TABLE drive_commit_fault (id TEXT REFERENCES tickets(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER fail_drive_commit AFTER INSERT ON drive_references BEGIN INSERT INTO drive_commit_fault VALUES ('absent'); END;").unwrap();
    assert!(
        workspace
            .reference_drive_file(&connection, "selected-doc", None, &SelectedFile)
            .is_err()
    );
    assert!(workspace.attachments(10, 0).unwrap().is_empty());
    faults
        .execute_batch("DROP TRIGGER fail_drive_commit; DROP TABLE drive_commit_fault;")
        .unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let connection = connection.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut workspace = Workspace::open(path).unwrap();
                barrier.wait();
                workspace
                    .reference_drive_file(&connection, "selected-doc", None, &SelectedFile)
                    .unwrap()
            })
        })
        .collect();
    let files: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(files[0].id, files[1].id);
    assert_eq!(workspace.attachments(10, 0).unwrap().len(), 1);
}

#[test]
fn provider_failure_retains_last_known_metadata_and_cannot_create_valid_new_references() {
    struct Offline;
    impl AttachmentProvider for Offline {
        fn metadata(&self, _: &str, _: Option<&str>) -> Result<DriveMetadata, DriveError> {
            Err(DriveError::new(
                ticketd_core::drive::DriveErrorKind::Offline,
                "Drive offline",
            ))
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let connection = uuid::Uuid::new_v4().to_string();
    let file = workspace
        .reference_drive_file(&connection, "selected-doc", None, &SelectedFile)
        .unwrap();
    let last = workspace.drive_reference(&file.id).unwrap();
    assert!(
        workspace
            .resolve_drive_reference(&file.id, &Offline)
            .is_err()
    );
    assert_eq!(workspace.drive_reference(&file.id).unwrap(), last);
    assert!(
        workspace
            .reference_drive_file(&connection, "not-stored", None, &Offline)
            .is_err()
    );
    assert_eq!(workspace.attachments(10, 0).unwrap(), [file]);
}
