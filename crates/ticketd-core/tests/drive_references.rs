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
fn access_checks_preserve_authored_references_and_recover_only_the_original_file_and_account() {
    struct Denied;
    impl AttachmentProvider for Denied {
        fn metadata(&self, _: &str, _: Option<&str>) -> Result<DriveMetadata, DriveError> {
            Err(DriveError::new(
                ticketd_core::drive::DriveErrorKind::PermissionDenied,
                "Request access in Drive",
            ))
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let connection = uuid::Uuid::new_v4().to_string();
    let file = workspace
        .reference_drive_file(&connection, "selected-doc", None, &SelectedFile)
        .unwrap();
    let registered_at = file.added_at.clone();
    assert!(registered_at.is_some());
    workspace
        .rename_attachment(&file.id, "Authored name")
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let body = format!("My [literal label]({uri}) stays here.");
    let document = workspace.create_document(None, &body).unwrap();
    let previous = workspace.drive_reference(&file.id).unwrap();
    let status = workspace.check_drive_reference(&file.id, &Denied).unwrap();
    assert_eq!(status.reference, previous);
    assert_eq!(
        status.failure.unwrap().kind,
        ticketd_core::drive::DriveErrorKind::PermissionDenied
    );
    for (account, selected) in [
        (connection.clone(), "different-file"),
        (uuid::Uuid::new_v4().to_string(), "selected-doc"),
    ] {
        let selection = ticketd_core::drive::DriveSelection {
            connection_id: account,
            file_ids: vec![selected.into()],
        };
        assert!(
            workspace
                .recover_drive_reference(&file.id, &selection, &SelectedFile)
                .is_err()
        );
        assert_eq!(workspace.attachments(10, 0).unwrap().len(), 1);
    }
    let selection = ticketd_core::drive::DriveSelection {
        connection_id: connection,
        file_ids: vec!["selected-doc".into()],
    };
    assert_eq!(
        workspace
            .recover_drive_reference(&file.id, &selection, &SelectedFile)
            .unwrap(),
        previous
    );
    assert!(
        workspace
            .check_drive_reference(&file.id, &SelectedFile)
            .unwrap()
            .failure
            .is_none()
    );
    drop(workspace);
    let workspace = Workspace::open(path).unwrap();
    assert_eq!(
        workspace.attachment(&file.id).unwrap().added_at,
        registered_at
    );
    assert_eq!(
        workspace.attachment(&file.id).unwrap().display_name,
        "Authored name"
    );
    assert_eq!(workspace.show_document(&document.id).unwrap().body, body);
    assert!(!dir.path().join("workspace.sqlite3.attachments").exists());
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
    assert!(chrono::DateTime::parse_from_rfc3339(file.added_at.as_deref().unwrap()).is_ok());
    assert!(
        !workspace
            .attachment_cleanup_review(&file.id)
            .unwrap()
            .eligible
    );
    assert!(workspace.quarantine_attachment(&file.id).is_err());
    assert!(workspace.restore_attachment(&file.id).is_err());
    assert!(
        workspace
            .purge_attachment(&file.id)
            .unwrap_err()
            .to_string()
            .contains("Remote files are never deleted")
    );
    assert_eq!(
        workspace
            .resolve_drive_reference(&file.id, &SelectedFile)
            .unwrap()
            .metadata
            .id,
        "selected-doc"
    );
    assert_eq!(
        workspace.attachment(&file.id).unwrap().added_at,
        file.added_at
    );
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
    workspace
        .retain_draft(&ticketd_core::DraftRetention {
            owner: "drive-draft".into(),
            kind: "draft".into(),
            revision: 0,
            payload: Some(serde_json::json!({"body":format!("[Current plan]({uri})")})),
            markdown: vec![format!("[Current plan]({uri})")],
        })
        .unwrap();
    assert!(
        workspace
            .attachment_usage(&file.id)
            .unwrap()
            .protections
            .iter()
            .any(|p| p.owner == "drive-draft")
    );
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

#[test]
#[ignore = "requires a preserved schema50 CLI in TICKETD_SCHEMA50_CLI; run explicitly for cross-version verification"]
fn schema50_upgrade_preserves_local_receipts_canonical_uses_drafts_undo_and_safety_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("trace.txt");
    std::fs::write(&source, b"retained version50 bytes").unwrap();
    let old_cli = std::env::var_os("TICKETD_SCHEMA50_CLI")
        .expect("supply the preserved, verified schema50 executable");
    let old = |args: &[&str]| {
        let result = std::process::Command::new(&old_cli)
            .env("TICKETD_TEST_WORKSPACE", &path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        result.stdout
    };
    old(&["attachment", "limit", "--bytes", "4096"]);
    let file: ticketd_core::Attachment = serde_json::from_slice(&old(&[
        "attachment",
        "add",
        source.to_str().unwrap(),
        "--request-id",
        "version50-upload",
    ]))
    .unwrap();
    let uri: String = serde_json::from_slice(&old(&["attachment", "uri", &file.id])).unwrap();
    let body = format!("[Trace]({uri})");
    let ticket: serde_json::Value =
        serde_json::from_slice(&old(&["create", "Retain source context"])).unwrap();
    let ticket_reference = ticket["reference"].as_str().unwrap();
    old(&["attachment", "link", &file.id, ticket_reference]);
    let document: serde_json::Value =
        serde_json::from_slice(&old(&["document", "create", "--body", &body])).unwrap();
    let fixture = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        fixture
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        50
    );
    // Persist the documented schema50 recovery wire format, then validate the
    // fixture using that version's CLI before the current core opens it.
    for kind in ["draft", "undo"] {
        let owner = format!("version50-{kind}");
        fixture.execute("INSERT INTO attachment_drafts(owner,kind,revision,payload,markdown) VALUES(?1,?2,1,?3,?4)", rusqlite::params![owner, kind, if kind == "draft" { Some(serde_json::json!({"body":body}).to_string()) } else { None }, serde_json::to_string(&vec![&body]).unwrap()]).unwrap();
        fixture
            .execute(
                "INSERT INTO attachment_draft_references(owner,uri,attachment_id) VALUES(?1,?2,?3)",
                rusqlite::params![owner, uri, file.id],
            )
            .unwrap();
    }
    drop(fixture);
    let old_usage: serde_json::Value =
        serde_json::from_slice(&old(&["attachment", "usage", &file.id])).unwrap();
    assert_eq!(old_usage["eligible"], false);
    assert!(
        old_usage["protections"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["kind"] == "undo")
    );
    let old_drafts: Vec<ticketd_core::DraftRetention> =
        serde_json::from_slice(&old(&["attachment", "recovery-drafts"])).unwrap();
    std::fs::remove_file(&source).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.attachment_upload_limit().unwrap(), 4096);
    assert_eq!(
        workspace
            .import_attachment("version50-upload", &source, None)
            .unwrap(),
        file
    );
    assert_eq!(workspace.attachment_uri(&file.id).unwrap(), uri);
    assert_eq!(
        workspace.ticket_attachments(ticket_reference).unwrap(),
        std::slice::from_ref(&file)
    );
    assert_eq!(
        workspace
            .embedded_attachments(document["id"].as_str().unwrap())
            .unwrap(),
        std::slice::from_ref(&file)
    );
    assert_eq!(workspace.draft_retentions().unwrap().len(), 2);
    assert_eq!(workspace.draft_retentions().unwrap(), old_drafts);
    let usage = workspace.attachment_usage(&file.id).unwrap();
    assert!(!usage.eligible);
    assert!(usage.protections.iter().any(|p| p.kind == "undo"));
    let backups = workspace.safety_backups().unwrap();
    assert_eq!(backups.len(), 1);
    let restored = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored, &backups[0].path).unwrap();
    let restored = Workspace::open(restored).unwrap();
    assert_eq!(
        restored.draft_retentions().unwrap(),
        workspace.draft_retentions().unwrap()
    );
    let output = dir.path().join("restored.txt");
    restored.export_attachment(&file.id, &output).unwrap();
    assert_eq!(std::fs::read(output).unwrap(), b"retained version50 bytes");
    // Migration must restore change-token triggers on the rebuilt parent table.
    let before = workspace.change_token().unwrap();
    let more = dir.path().join("new.txt");
    std::fs::write(&more, b"new").unwrap();
    workspace
        .import_attachment("post-migration", &more, None)
        .unwrap();
    assert!(workspace.change_token().unwrap() > before);
}

#[test]
fn shared_preview_keeps_remote_metadata_without_serving_or_exporting_remote_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let connection = uuid::Uuid::new_v4().to_string();
    let file = workspace
        .reference_drive_file(&connection, "selected-doc", None, &SelectedFile)
        .unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    let preview = workspace.attachment_preview(&identity, &file.id).unwrap();
    assert_eq!(preview.attachment, file);
    assert_eq!(preview.status, ticketd_core::PreviewStatus::Unsupported);
    assert!(preview.media_type.is_none());
    assert!(preview.can_open);
    assert!(preview.message.unwrap().contains("No local snapshot"));
    assert!(workspace.attachment_media(&identity, &file.id).is_err());
    assert!(!dir.path().join("workspace.attachments").exists());
    let old = workspace
        .import_attachment_bytes("old", "old.txt", b"old bytes", |_, _| true)
        .unwrap();
    let ticket = workspace
        .create_ticket("Replace just this association")
        .unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &old.id, true)
        .unwrap();
    workspace
        .write(
            Some("replace-drive"),
            ticketd_core::WriteRequest::ReplaceTicketAttachment {
                reference: ticket.reference.clone(),
                previous_id: old.id.clone(),
                replacement_id: file.id.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        workspace.ticket_attachments(&ticket.reference).unwrap(),
        [file]
    );
    let destination = dir.path().join("old.txt");
    workspace.export_attachment(&old.id, &destination).unwrap();
    assert_eq!(std::fs::read(destination).unwrap(), b"old bytes");
}
