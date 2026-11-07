use std::{io::Read, sync::Mutex};
use ticketd_core::{Workspace, drive::*};

const CONNECTION: &str = "81aa7bfb-05c3-4934-a4e7-5c84e2cb83ec";

#[test]
fn removed_uploaded_copy_keeps_provenance_but_old_upload_and_write_receipts_cannot_resurrect_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let provider = Provider::default();
    let file = workspace
        .upload_drive_bytes(
            "upload-remove",
            "diagnostic.zip",
            b"original bytes",
            &destination(),
            &provider,
            |_, _| true,
        )
        .unwrap();
    let mut provenance = workspace.drive_uploaded_copy(&file.id).unwrap();
    provenance.as_mut().unwrap().record_removed = true;
    let rename = || ticketd_core::WriteRequest::RenameAttachment {
        id: file.id.clone(),
        display_name: "Diagnostic".into(),
    };
    workspace.write(Some("rename-copy"), rename()).unwrap();
    let before = workspace.drive_upload("upload-remove").unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TABLE removal_commit_fault(id TEXT REFERENCES attachments(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_copy_removal AFTER DELETE ON attachments BEGIN INSERT INTO removal_commit_fault VALUES(OLD.id); END;").unwrap();
    assert!(workspace.remove_remote_attachment(&file.id).is_err());
    assert_eq!(workspace.drive_upload("upload-remove").unwrap(), before);
    assert!(workspace.attachment(&file.id).is_ok());
    faults
        .execute_batch("DROP TRIGGER fail_copy_removal; DROP TABLE removal_commit_fault;")
        .unwrap();
    workspace.remove_remote_attachment(&file.id).unwrap();
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    for error in [
        workspace
            .upload_drive_bytes(
                "upload-remove",
                "diagnostic.zip",
                b"original bytes",
                &destination(),
                &provider,
                |_, _| true,
            )
            .unwrap_err(),
        workspace.write(Some("rename-copy"), rename()).unwrap_err(),
    ] {
        assert!(error.to_string().contains("remains in Drive"), "{error}");
        assert!(
            error
                .to_string()
                .contains("https://drive.google.com/file/d/reserved-file/view"),
            "{error}"
        );
    }
    workspace
        .check_drive_upload("upload-remove", &provider)
        .unwrap();
    assert!(workspace.attachments(10, 0).unwrap().is_empty());
    assert_eq!(workspace.drive_uploaded_copy(&file.id).unwrap(), provenance);
    assert_eq!(provider.ids.lock().unwrap().len(), 1);
    let backup = dir.path().join("removed.sqlite3");
    workspace.backup(&backup).unwrap();
    let restored = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored, backup).unwrap();
    assert_eq!(
        Workspace::open(restored)
            .unwrap()
            .drive_uploaded_copy(&file.id)
            .unwrap(),
        provenance
    );
}

#[test]
#[ignore = "requires preserved actual schema54 CLI in TICKETD_SCHEMA54_CLI"]
fn real_schema54_upgrade_keeps_legacy_destinations_and_complete_recovery() {
    use ticketd_core::AttachmentUploadDestination;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let source = dir.path().join("trace.log");
    std::fs::write(&source, b"original bytes").unwrap();
    let old_cli =
        std::env::var_os("TICKETD_SCHEMA54_CLI").expect("supply the preserved schema54 CLI");
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
        serde_json::from_slice::<serde_json::Value>(&result.stdout).unwrap()
    };
    let original: ticketd_core::Attachment = serde_json::from_value(old(&[
        "attachment",
        "add",
        source.to_str().unwrap(),
        "--request-id",
        "legacy-local",
    ]))
    .unwrap();
    let orphan: ticketd_core::Attachment = serde_json::from_value(old(&[
        "attachment",
        "add",
        source.to_str().unwrap(),
        "--request-id",
        "legacy-manifest",
    ]))
    .unwrap();
    let uri = old(&["attachment", "uri", &original.id]);
    let document = old(&[
        "document",
        "create",
        "--body",
        &format!("[Literal label]({})", uri.as_str().unwrap()),
    ]);
    let fixture = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        fixture
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        54
    );
    // Fault injection: completed bytes/manifest survived but registration did not.
    fixture
        .execute(
            "DELETE FROM request_outcomes WHERE id='legacy-manifest'",
            [],
        )
        .unwrap();
    fixture
        .execute("DELETE FROM attachments WHERE id=?1", [&orphan.id])
        .unwrap();
    // Historical provider-boundary fixture, using the pre55 serialized journal contract.
    let operation = DriveUploadOperation {
        request_id: "legacy-drive".into(),
        attachment_id: uuid::Uuid::new_v4().to_string(),
        remote_file_id: Some("reserved-file".into()),
        request: DriveUploadRequest {
            destination: destination(),
            filename: "trace.log".into(),
            size_bytes: 14,
            sha256: "52c3935626c104b2cbc9031291a1c4d56614c38f52072a361d658a58a9c48698".into(),
        },
        state: DriveUploadState::Uncertain,
        provenance: None,
    };
    fixture
        .execute(
            "INSERT INTO drive_upload_operations VALUES (?1,?2,?3)",
            rusqlite::params![
                operation.request_id,
                operation.attachment_id,
                serde_json::to_string(&operation).unwrap()
            ],
        )
        .unwrap();
    drop(fixture);
    std::fs::remove_file(&source).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::Local
    );
    let mut next_folder = destination();
    next_folder.folder_id = "new-folder".into();
    let new_default = workspace
        .set_drive_upload_destination(&next_folder, &Provider::default())
        .unwrap();
    for request in ["legacy-local", "legacy-manifest"] {
        assert_eq!(
            workspace.begin_attachment_upload(request, None).unwrap(),
            AttachmentUploadDestination::Local
        );
    }
    assert_eq!(
        workspace
            .import_attachment("legacy-local", &source, None)
            .unwrap(),
        original
    );
    assert_eq!(
        workspace
            .import_attachment("legacy-manifest", &source, None)
            .unwrap(),
        orphan
    );
    assert_eq!(
        workspace
            .embedded_attachments(document["id"].as_str().unwrap())
            .unwrap(),
        vec![original.clone()]
    );
    let backup = dir.path().join("complete.sqlite3");
    workspace.backup(&backup).unwrap();
    let restored_path = dir.path().join("restored.db");
    Workspace::restore(&restored_path, &backup).unwrap();
    let mut restored = Workspace::open(&restored_path).unwrap();
    assert_eq!(
        restored.attachment_upload_destination().unwrap(),
        new_default
    );
    restored.set_local_upload_destination().unwrap();
    assert!(
        matches!(restored.begin_attachment_upload("legacy-drive", None).unwrap(), AttachmentUploadDestination::GoogleDrive { destination: selected, .. } if selected == destination())
    );
    assert_eq!(restored.drive_upload("legacy-drive").unwrap(), operation);
    let exported = dir.path().join("restored.log");
    restored.export_attachment(&original.id, &exported).unwrap();
    assert_eq!(std::fs::read(exported).unwrap(), b"original bytes");
    let safety = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains("pre-migration")
        })
        .unwrap();
    assert!(
        workspace
            .inspect_backup(&safety)
            .unwrap()
            .attachment_content
            .is_some()
    );
    let safety_target = dir.path().join("safety-restored.db");
    Workspace::restore(&safety_target, &safety).unwrap();
    let safety_workspace = Workspace::open(safety_target).unwrap();
    assert_eq!(safety_workspace.attachment(&original.id).unwrap(), original);
    assert_eq!(safety_workspace.attachment(&orphan.id).unwrap(), orphan);
}

#[test]
fn workspace_upload_preference_persists_and_failed_validation_preserves_it() {
    use ticketd_core::AttachmentUploadDestination;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::Local
    );
    let selected = workspace
        .set_drive_upload_destination(&destination(), &Provider::default())
        .unwrap();
    assert!(
        matches!(&selected, AttachmentUploadDestination::GoogleDrive { folder_name, .. } if folder_name == "Uploads")
    );
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.attachment_upload_destination().unwrap(), selected);
    let offline = Provider {
        folder_offline: true,
        ..Provider::default()
    };
    assert!(
        workspace
            .set_drive_upload_destination(&destination(), &offline)
            .unwrap_err()
            .to_string()
            .contains("offline")
    );
    assert_eq!(workspace.attachment_upload_destination().unwrap(), selected);
    let readonly = Provider {
        readonly: true,
        ..Provider::default()
    };
    assert!(
        workspace
            .set_drive_upload_destination(&destination(), &readonly)
            .unwrap_err()
            .to_string()
            .contains("writable")
    );
    let mut invalid = destination();
    invalid.folder_id = "../invalid".into();
    assert!(
        workspace
            .set_drive_upload_destination(&invalid, &Provider::default())
            .is_err()
    );
    assert_eq!(workspace.attachment_upload_destination().unwrap(), selected);
    workspace.set_local_upload_destination().unwrap();
    assert_eq!(
        Workspace::open(&path)
            .unwrap()
            .attachment_upload_destination()
            .unwrap(),
        AttachmentUploadDestination::Local
    );
}

#[test]
fn new_uploads_bind_the_preference_once_across_changes_restart_and_explicit_overrides() {
    use ticketd_core::AttachmentUploadDestination;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace
            .begin_attachment_upload("local-capture", None)
            .unwrap(),
        AttachmentUploadDestination::Local
    );
    let drive = workspace
        .set_drive_upload_destination(&destination(), &Provider::default())
        .unwrap();
    assert_eq!(
        workspace
            .begin_attachment_upload("drive-capture", None)
            .unwrap(),
        drive
    );
    workspace.set_local_upload_destination().unwrap();
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace
            .begin_attachment_upload("drive-capture", None)
            .unwrap(),
        drive
    );
    assert_eq!(
        workspace
            .begin_attachment_upload("local-capture", None)
            .unwrap(),
        AttachmentUploadDestination::Local
    );
    assert_eq!(
        workspace
            .begin_attachment_upload("new-capture", None)
            .unwrap(),
        AttachmentUploadDestination::Local
    );
    assert!(
        workspace
            .begin_attachment_upload("drive-capture", Some(AttachmentUploadDestination::Local))
            .is_err()
    );
    workspace
        .set_drive_upload_destination(&destination(), &Provider::default())
        .unwrap();
    assert_eq!(
        workspace
            .begin_attachment_upload("explicit-local", Some(AttachmentUploadDestination::Local))
            .unwrap(),
        AttachmentUploadDestination::Local
    );
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let restored_path = dir.path().join("restored.db");
    Workspace::restore(&restored_path, &backup).unwrap();
    let mut restored = Workspace::open(restored_path).unwrap();
    assert_eq!(restored.attachment_upload_destination().unwrap(), drive);
    assert_eq!(
        restored
            .begin_attachment_upload("local-capture", None)
            .unwrap(),
        AttachmentUploadDestination::Local
    );
}

#[test]
fn bound_destinations_cannot_be_changed_by_other_upload_adapters_or_concurrent_preferences() {
    use ticketd_core::AttachmentUploadDestination;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let source = dir.path().join("trace.log");
    std::fs::write(&source, b"original bytes").unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    let mut other = Workspace::open(&path).unwrap();
    let provider = Provider::default();
    let drive = workspace
        .set_drive_upload_destination(&destination(), &provider)
        .unwrap();
    workspace
        .begin_attachment_upload("drive-bound", None)
        .unwrap();
    assert!(
        workspace
            .import_attachment("drive-bound", &source, None)
            .is_err()
    );
    let file = workspace
        .upload_drive_file("drive-bound", &source, &destination(), &provider, |_, _| {
            other.set_local_upload_destination().unwrap();
            true
        })
        .unwrap();
    assert_eq!(
        workspace
            .begin_attachment_upload("drive-bound", None)
            .unwrap(),
        drive
    );
    assert_eq!(
        workspace
            .drive_uploaded_copy(&file.id)
            .unwrap()
            .unwrap()
            .request
            .destination,
        destination()
    );
    assert_eq!(
        workspace.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::Local
    );
    workspace
        .begin_attachment_upload("local-bound", None)
        .unwrap();
    assert!(
        workspace
            .upload_drive_file("local-bound", &source, &destination(), &provider, |_, _| {
                true
            })
            .is_err()
    );
    assert!(workspace.drive_upload("local-bound").is_err());
    assert_eq!(provider.ids.lock().unwrap().len(), 1);
}

#[test]
fn reserved_upload_identity_cannot_be_claimed_by_an_unrelated_write() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.db")).unwrap();
    workspace.begin_attachment_upload("reserved", None).unwrap();
    assert!(
        workspace
            .write(
                Some("reserved"),
                ticketd_core::WriteRequest::CreateTicket {
                    title: "Unrelated".into(),
                    project_id: None
                }
            )
            .is_err()
    );
}

#[test]
#[ignore = "requires the preserved schema51 executable in TICKETD_SCHEMA51_CLI"]
fn real_schema51_upgrade_preserves_local_receipts_references_and_complete_safety_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("trace.log");
    std::fs::write(&source, b"original bytes").unwrap();
    let old_cli =
        std::env::var_os("TICKETD_SCHEMA51_CLI").expect("supply the preserved schema51 CLI");
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
        serde_json::from_slice::<serde_json::Value>(&result.stdout).unwrap()
    };
    let file: ticketd_core::Attachment = serde_json::from_value(old(&[
        "attachment",
        "add",
        source.to_str().unwrap(),
        "--request-id",
        "old-upload",
    ]))
    .unwrap();
    let uri = old(&["attachment", "uri", &file.id]);
    let body = format!("[Trace]({})", uri.as_str().unwrap());
    let document = old(&["document", "create", "--body", &body]);
    let fixture = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        fixture
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        51
    );
    drop(fixture);
    std::fs::remove_file(&source).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace
            .import_attachment("old-upload", &source, None)
            .unwrap(),
        file
    );
    assert_eq!(
        workspace
            .embedded_attachments(document["id"].as_str().unwrap())
            .unwrap(),
        std::slice::from_ref(&file)
    );
    let safety = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|p| p.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .contains("pre-migration")
        })
        .unwrap();
    assert_eq!(
        workspace
            .inspect_backup(&safety)
            .unwrap()
            .attachment_content
            .unwrap()
            .retained_bytes,
        14
    );
    let restored = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored, &safety).unwrap();
    let restored = Workspace::open(restored).unwrap();
    assert_eq!(restored.attachment(&file.id).unwrap(), file);
    assert_eq!(
        restored
            .resolve_attachment_uri(uri.as_str().unwrap())
            .unwrap(),
        file
    );
    assert!(workspace.drive_uploads().unwrap().is_empty());
}
fn destination() -> DriveUploadDestination {
    DriveUploadDestination {
        connection_id: CONNECTION.into(),
        folder_id: "folder".into(),
        resource_key: None,
    }
}
#[derive(Default)]
struct Provider {
    uploaded: Mutex<Option<DriveUploadedFile>>,
    ids: Mutex<Vec<String>>,
    fail_before: std::sync::atomic::AtomicBool,
    fail_after: bool,
    readonly: bool,
    folder_offline: bool,
    unverified: bool,
    database: Option<std::path::PathBuf>,
    allocation_failed: bool,
    reserved: std::sync::atomic::AtomicUsize,
}
#[allow(clippy::unwrap_used)] // Fixture failures must fail the test, never become provider errors.
impl DriveUploadProvider for Provider {
    fn folder(&self, id: &str, _: Option<&str>) -> Result<DriveFolder, DriveError> {
        if self.folder_offline {
            return Err(DriveError::new(
                DriveErrorKind::Offline,
                "Drive is offline; retry or choose local explicitly",
            ));
        }
        Ok(DriveFolder {
            id: id.into(),
            name: "Uploads".into(),
            can_add_children: !self.readonly,
        })
    }
    fn reserve_file_id(&self) -> Result<String, DriveError> {
        if self.allocation_failed {
            return Err(DriveError::new(
                DriveErrorKind::Offline,
                "ID allocation unavailable",
            ));
        }
        let index = self
            .reserved
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(if index == 0 {
            "reserved-file".into()
        } else {
            format!("reserved-file-{index}")
        })
    }
    fn uploaded_file(&self, id: &str) -> Result<Option<DriveUploadedFile>, DriveError> {
        Ok(self
            .uploaded
            .lock()
            .unwrap()
            .clone()
            .filter(|f| f.metadata.id == id))
    }
    fn upload_blob(
        &self,
        operation: &DriveUploadOperation,
        input: &mut dyn Read,
        progress: &mut dyn FnMut(u64, u64) -> bool,
    ) -> Result<(), DriveError> {
        let id = operation.remote_file_id.as_ref().unwrap();
        self.ids.lock().unwrap().push(id.clone());
        if let Some(path) = &self.database {
            let persisted = Workspace::open(path)
                .unwrap()
                .drive_upload(&operation.request_id)
                .unwrap();
            assert_eq!(persisted.remote_file_id.as_ref(), Some(id));
            assert_eq!(persisted.state, DriveUploadState::Uncertain);
        }
        if self
            .fail_before
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(DriveError::new(
                DriveErrorKind::Offline,
                "response lost before completion",
            ));
        }
        let mut bytes = Vec::new();
        input.read_to_end(&mut bytes).unwrap();
        assert!(bytes == b"original bytes" || bytes == b"revised bytes");
        *self.uploaded.lock().unwrap() = Some(DriveUploadedFile {
            metadata: DriveMetadata {
                id: id.clone(),
                name: operation.request.filename.clone(),
                mime_type: "application/octet-stream".into(),
                size_bytes: Some(bytes.len() as u64),
                web_url: format!("https://drive.google.com/file/d/{id}/view"),
                resource_key: None,
            },
            sha256_checksum: (!self.unverified).then(|| {
                if bytes == b"original bytes" {
                    "52c3935626c104b2cbc9031291a1c4d56614c38f52072a361d658a58a9c48698"
                } else {
                    "fbbc2c3431a44cfdde4191200aa44fcadf6f0bb0fe0c139abd61a455b422e2b4"
                }
                .into()
            }),
            version: Some("1".into()),
            operation_id: Some(operation.attachment_id.clone()),
            parent_ids: vec!["folder".into()],
        });
        if !progress(bytes.len() as u64, bytes.len() as u64) {
            return Err(DriveError::new(
                DriveErrorKind::Cancelled,
                "canceled after provider completion; remote file remains",
            ));
        }
        if self.fail_after {
            return Err(DriveError::new(
                DriveErrorKind::Offline,
                "completion response lost",
            ));
        }
        Ok(())
    }
}
#[allow(clippy::unwrap_used)] // Controlled external metadata fixture.
impl AttachmentProvider for Provider {
    fn metadata(&self, _: &str, _: Option<&str>) -> Result<DriveMetadata, DriveError> {
        Ok(self
            .uploaded
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .metadata
            .clone())
    }
}

#[test]
fn selecting_a_completed_item_during_registration_recovery_keeps_the_upload_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let provider = Provider::default();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TRIGGER fail_registration BEFORE INSERT ON drive_references BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
    assert!(
        workspace
            .upload_drive_bytes(
                "selection-race",
                "trace.log",
                b"original bytes",
                &destination(),
                &provider,
                |_, _| true
            )
            .is_err()
    );
    let reserved = workspace
        .drive_upload("selection-race")
        .unwrap()
        .attachment_id;
    faults
        .execute_batch("DROP TRIGGER fail_registration")
        .unwrap();
    let selected = workspace
        .reference_drive_file(CONNECTION, "reserved-file", None, &provider)
        .unwrap();
    assert_eq!(selected.id, reserved);
    assert_eq!(
        workspace
            .check_drive_upload("selection-race", &provider)
            .unwrap()
            .state,
        DriveUploadState::Completed
    );
    assert_eq!(workspace.attachments(10, 0).unwrap().len(), 1);
    assert_eq!(provider.ids.lock().unwrap().len(), 1);
    let provenance = workspace
        .drive_uploaded_copy(&selected.id)
        .unwrap()
        .unwrap();
    workspace
        .rename_attachment(&selected.id, "Authored uploaded copy")
        .unwrap();
    workspace
        .resolve_drive_reference(&selected.id, &provider)
        .unwrap();
    assert_eq!(
        workspace
            .drive_uploaded_copy(&selected.id)
            .unwrap()
            .unwrap(),
        provenance
    );
    assert_eq!(
        workspace.attachment(&selected.id).unwrap().display_name,
        "Authored uploaded copy"
    );
}

#[test]
fn removing_a_selected_uncertain_upload_prevents_later_reconciliation_from_registering_it_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let provider = Provider::default();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TRIGGER fail_registration BEFORE INSERT ON drive_references BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
    assert!(
        workspace
            .upload_drive_bytes(
                "remove-uncertain",
                "trace.log",
                b"original bytes",
                &destination(),
                &provider,
                |_, _| true
            )
            .is_err()
    );
    faults
        .execute_batch("DROP TRIGGER fail_registration")
        .unwrap();
    let selected = workspace
        .reference_drive_file(CONNECTION, "reserved-file", None, &provider)
        .unwrap();
    assert_eq!(
        workspace.drive_upload("remove-uncertain").unwrap().state,
        DriveUploadState::Uncertain
    );
    workspace.remove_remote_attachment(&selected.id).unwrap();
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    let _ = workspace.check_drive_upload("remove-uncertain", &provider);
    assert!(workspace.attachments(10, 0).unwrap().is_empty());
    assert!(
        workspace
            .upload_drive_bytes(
                "remove-uncertain",
                "trace.log",
                b"original bytes",
                &destination(),
                &provider,
                |_, _| true
            )
            .is_err()
    );
    assert_eq!(provider.ids.lock().unwrap().len(), 1);
    let restored = workspace
        .reference_drive_file(CONNECTION, "reserved-file", None, &provider)
        .unwrap();
    assert_eq!(restored.id, selected.id);
    assert_eq!(
        workspace
            .drive_uploaded_copy(&restored.id)
            .unwrap()
            .unwrap()
            .state,
        DriveUploadState::Completed
    );
}

#[test]
fn in_flight_cancellation_preserves_removal_when_saving_its_older_journal_observation() {
    struct Abandon {
        inner: Provider,
        path: std::path::PathBuf,
    }
    impl DriveUploadProvider for Abandon {
        fn folder(&self, id: &str, key: Option<&str>) -> Result<DriveFolder, DriveError> {
            self.inner.folder(id, key)
        }
        fn reserve_file_id(&self) -> Result<String, DriveError> {
            self.inner.reserve_file_id()
        }
        fn uploaded_file(&self, _: &str) -> Result<Option<DriveUploadedFile>, DriveError> {
            Ok(None)
        }
        #[allow(clippy::unwrap_used)] // Controlled external transport callback exercises a second real Workspace writer.
        fn upload_blob(
            &self,
            op: &DriveUploadOperation,
            input: &mut dyn Read,
            progress: &mut dyn FnMut(u64, u64) -> bool,
        ) -> Result<(), DriveError> {
            self.inner.upload_blob(op, input, progress)?;
            let mut other = Workspace::open(&self.path).unwrap();
            let selected = other
                .reference_drive_file(CONNECTION, "reserved-file", None, &self.inner)
                .unwrap();
            other.remove_remote_attachment(&selected.id).unwrap();
            Err(DriveError::new(
                DriveErrorKind::Cancelled,
                "Cancellation response raced record removal",
            ))
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let provider = Abandon {
        inner: Provider::default(),
        path: path.clone(),
    };
    let mut workspace = Workspace::open(path).unwrap();
    assert!(
        workspace
            .upload_drive_bytes(
                "late-cancel",
                "trace.log",
                b"original bytes",
                &destination(),
                &provider,
                |_, _| true
            )
            .is_err()
    );
    let operation = workspace.drive_upload("late-cancel").unwrap();
    assert_eq!(operation.state, DriveUploadState::Cancelled);
    assert!(operation.record_removed);
    assert_eq!(operation.request.destination, destination());
    assert!(
        workspace
            .check_drive_upload("late-cancel", &provider.inner)
            .is_err()
    );
    assert!(workspace.attachments(10, 0).unwrap().is_empty());
    let reconciled = workspace.drive_upload("late-cancel").unwrap();
    assert!(reconciled.record_removed);
    assert_eq!(reconciled.state, DriveUploadState::Completed);
    assert_eq!(reconciled.attachment_id, operation.attachment_id);
    assert_eq!(reconciled.request, operation.request);
    assert_eq!(provider.inner.ids.lock().unwrap().len(), 1);
}

#[test]
fn legacy_upload_journal_without_removal_flag_replays_and_supports_deliberate_picker_readd() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let provider = Provider::default();
    let file = workspace
        .upload_drive_bytes(
            "old-json",
            "trace.log",
            b"original bytes",
            &destination(),
            &provider,
            |_, _| true,
        )
        .unwrap();
    let original = workspace.drive_upload("old-json").unwrap();
    // The pre-removal journal wire format had no flag; retain its original data unchanged.
    rusqlite::Connection::open(&path).unwrap().execute("UPDATE drive_upload_operations SET operation=json_remove(operation,'$.record_removed')",[]).unwrap();
    drop(workspace);
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.drive_upload("old-json").unwrap(), original);
    assert_eq!(
        workspace
            .upload_drive_bytes(
                "old-json",
                "trace.log",
                b"original bytes",
                &destination(),
                &provider,
                |_, _| true
            )
            .unwrap(),
        file
    );
    workspace.remove_remote_attachment(&file.id).unwrap();
    assert!(workspace.drive_upload("old-json").unwrap().record_removed);
    let again = workspace
        .reference_drive_file(CONNECTION, "reserved-file", None, &provider)
        .unwrap();
    assert_eq!(again.id, file.id);
    assert_eq!(workspace.drive_upload("old-json").unwrap(), original);
    assert_eq!(provider.ids.lock().unwrap().len(), 1);
}

#[test]
fn concurrent_process_instances_share_one_remote_effect_and_attachment_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    Workspace::open(&path).unwrap();
    let provider = std::sync::Arc::new(Provider::default());
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let path = path.clone();
            let provider = provider.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut workspace = Workspace::open(path).unwrap();
                barrier.wait();
                workspace
                    .upload_drive_bytes(
                        "concurrent",
                        "trace.log",
                        b"original bytes",
                        &destination(),
                        provider.as_ref(),
                        |_, _| true,
                    )
                    .unwrap()
            })
        })
        .collect();
    let files: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(files[0], files[1]);
    assert_eq!(provider.ids.lock().unwrap().len(), 1);
}

#[test]
fn revised_upload_is_a_new_attachment_and_cannot_reuse_an_ordinary_write_request_id() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let provider = Provider::default();
    let first = workspace
        .upload_drive_bytes(
            "original",
            "trace.log",
            b"original bytes",
            &destination(),
            &provider,
            |_, _| true,
        )
        .unwrap();
    let revision = workspace
        .upload_drive_bytes(
            "revision",
            "trace.log",
            b"revised bytes",
            &destination(),
            &provider,
            |_, _| true,
        )
        .unwrap();
    assert_ne!(first.id, revision.id);
    assert!(
        workspace
            .upload_drive_bytes(
                "original",
                "trace.log",
                b"revised bytes",
                &destination(),
                &provider,
                |_, _| true
            )
            .is_err()
    );
    assert_eq!(first.size_bytes, Some(14));
    assert_eq!(revision.size_bytes, Some(13));
    assert_eq!(
        workspace.drive_reference(&first.id).unwrap().metadata.id,
        "reserved-file"
    );
    assert_eq!(
        workspace.drive_reference(&revision.id).unwrap().metadata.id,
        "reserved-file-1"
    );
    assert!(
        workspace
            .import_attachment_bytes("original", "trace.log", b"original bytes", |_, _| true)
            .is_err()
    );
    workspace
        .import_attachment_bytes("local", "trace.log", b"original bytes", |_, _| true)
        .unwrap();
    assert!(
        workspace
            .upload_drive_bytes(
                "local",
                "trace.log",
                b"original bytes",
                &destination(),
                &provider,
                |_, _| true
            )
            .is_err()
    );
    assert_eq!(provider.ids.lock().unwrap().len(), 2);
}

#[test]
fn allocation_and_identity_commit_failures_send_no_bytes_and_pending_or_uncertain_operations_survive_backup()
 {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let provider = Provider {
        allocation_failed: true,
        ..Default::default()
    };
    assert!(
        workspace
            .upload_drive_bytes(
                "allocation",
                "trace.log",
                b"original bytes",
                &destination(),
                &provider,
                |_, _| true
            )
            .is_err()
    );
    assert_eq!(
        workspace.drive_upload("allocation").unwrap().remote_file_id,
        None
    );
    assert!(provider.ids.lock().unwrap().is_empty());
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TRIGGER fail_id BEFORE UPDATE ON drive_upload_operations BEGIN SELECT RAISE(ABORT,'identity commit failed'); END;").unwrap();
    let provider = Provider::default();
    assert!(
        workspace
            .upload_drive_bytes(
                "identity",
                "trace.log",
                b"original bytes",
                &destination(),
                &provider,
                |_, _| true
            )
            .is_err()
    );
    assert!(provider.ids.lock().unwrap().is_empty());
    faults.execute_batch("DROP TRIGGER fail_id").unwrap();
    let provider = Provider {
        fail_before: true.into(),
        ..Default::default()
    };
    assert!(
        workspace
            .upload_drive_bytes(
                "uncertain",
                "trace.log",
                b"original bytes",
                &destination(),
                &provider,
                |_, _| true
            )
            .is_err()
    );
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let restored = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored, &backup).unwrap();
    let restored = Workspace::open(restored).unwrap();
    assert_eq!(
        restored.drive_uploads().unwrap(),
        workspace.drive_uploads().unwrap()
    );
    assert!(restored.attachments(10, 0).unwrap().is_empty());
    assert_eq!(
        restored
            .drive_upload("uncertain")
            .unwrap()
            .remote_file_id
            .as_deref(),
        Some("reserved-file")
    );
}

#[test]
fn lost_response_before_completion_retries_same_persisted_id_and_input_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("trace.log");
    std::fs::write(&source, b"original bytes").unwrap();
    let provider = Provider {
        fail_before: true.into(),
        database: Some(path.clone()),
        ..Default::default()
    };
    let mut workspace = Workspace::open(&path).unwrap();
    assert!(
        workspace
            .upload_drive_file("retry", &source, &destination(), &provider, |_, _| true)
            .is_err()
    );
    assert_eq!(
        workspace.drive_upload("retry").unwrap().state,
        DriveUploadState::Uncertain
    );
    assert!(workspace.attachments(10, 0).unwrap().is_empty());
    drop(workspace);
    let mut workspace = Workspace::open(path).unwrap();
    std::fs::write(&source, b"revised bytes").unwrap();
    assert!(
        workspace
            .upload_drive_file("retry", &source, &destination(), &provider, |_, _| true)
            .is_err()
    );
    std::fs::write(&source, b"original bytes").unwrap();
    workspace
        .upload_drive_file("retry", &source, &destination(), &provider, |_, _| true)
        .unwrap();
    assert_eq!(
        provider.ids.lock().unwrap().as_slice(),
        ["reserved-file", "reserved-file"]
    );
}

#[test]
fn lost_completion_and_failed_reference_save_keep_the_completed_item_discoverable() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let provider = Provider {
        fail_after: true,
        ..Default::default()
    };
    let file = workspace
        .upload_drive_bytes(
            "lost",
            "trace.log",
            b"original bytes",
            &destination(),
            &provider,
            |_, _| true,
        )
        .unwrap();
    assert!(
        workspace
            .set_ticket_attachment("T-404", &file.id, true)
            .is_err()
    );
    assert_eq!(
        workspace.attachments(10, 0).unwrap(),
        std::slice::from_ref(&file)
    );
    assert!(matches!(
        workspace.attachment_open_target(&file.id).unwrap(),
        ticketd_core::AttachmentOpenTarget::ExternalUrl(_)
    ));
    assert_eq!(provider.ids.lock().unwrap().len(), 1);
}

#[test]
fn status_check_after_failed_local_commit_recovers_without_source_or_second_create() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TRIGGER fail_upload_commit BEFORE INSERT ON drive_references BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
    let provider = Provider::default();
    assert!(
        workspace
            .upload_drive_bytes(
                "commit",
                "trace.log",
                b"original bytes",
                &destination(),
                &provider,
                |_, _| true
            )
            .is_err()
    );
    assert!(workspace.attachments(10, 0).unwrap().is_empty());
    faults
        .execute_batch("DROP TRIGGER fail_upload_commit")
        .unwrap();
    assert_eq!(
        workspace.drive_upload_open_url("commit").unwrap(),
        "https://drive.google.com/file/d/reserved-file/view"
    );
    assert_eq!(
        workspace
            .check_drive_upload("commit", &provider)
            .unwrap()
            .state,
        DriveUploadState::Completed
    );
    assert_eq!(provider.ids.lock().unwrap().len(), 1);
}

#[test]
fn folder_bound_and_verification_failures_cannot_expose_valid_uploads_or_silently_fall_back() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let readonly = Provider {
        readonly: true,
        ..Default::default()
    };
    assert!(
        workspace
            .upload_drive_bytes(
                "readonly",
                "trace.log",
                b"original bytes",
                &destination(),
                &readonly,
                |_, _| true
            )
            .is_err()
    );
    assert!(readonly.ids.lock().unwrap().is_empty());
    workspace.set_attachment_upload_limit(10).unwrap();
    let provider = Provider::default();
    assert!(
        workspace
            .upload_drive_bytes(
                "bound",
                "trace.log",
                b"original bytes",
                &destination(),
                &provider,
                |_, _| true
            )
            .is_err()
    );
    assert!(provider.ids.lock().unwrap().is_empty());
    workspace.set_attachment_upload_limit(100).unwrap();
    let provider = Provider {
        unverified: true,
        ..Default::default()
    };
    assert!(
        workspace
            .upload_drive_bytes(
                "verify",
                "trace.log",
                b"original bytes",
                &destination(),
                &provider,
                |_, _| true
            )
            .is_err()
    );
    assert!(workspace.attachments(10, 0).unwrap().is_empty());
    let mut changed = destination();
    changed.folder_id = "other-folder".into();
    assert!(
        workspace
            .upload_drive_bytes(
                "verify",
                "trace.log",
                b"original bytes",
                &changed,
                &provider,
                |_, _| true
            )
            .is_err()
    );
    assert_eq!(
        workspace
            .drive_upload("verify")
            .unwrap()
            .request
            .destination,
        destination()
    );
}

#[test]
fn cancellation_after_completion_and_explicit_local_fallback_retain_remote_identity_and_metadata_only_backups()
 {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let provider = Provider::default();
    let file = workspace
        .upload_drive_bytes(
            "cancel",
            "trace.log",
            b"original bytes",
            &destination(),
            &provider,
            |copied, _| copied == 0,
        )
        .unwrap();
    assert_eq!(
        workspace.drive_upload("cancel").unwrap().state,
        DriveUploadState::Completed
    );
    let local = workspace
        .import_attachment_bytes("explicit-local", "trace.log", b"original bytes", |_, _| {
            true
        })
        .unwrap();
    assert_ne!(file.id, local.id);
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let content = workspace
        .inspect_backup(&backup)
        .unwrap()
        .attachment_content
        .unwrap();
    assert_eq!(content.remote_references, 1);
    assert_eq!(content.local_snapshots, 1);
    assert_eq!(content.retained_bytes, 14);
    let exported = workspace.export().unwrap().to_string();
    assert!(!exported.contains("refresh_token"));
    assert!(!exported.contains("upload_id="));
    let restored = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored, &backup).unwrap();
    assert_eq!(
        Workspace::open(restored)
            .unwrap()
            .drive_upload("cancel")
            .unwrap(),
        workspace.drive_upload("cancel").unwrap()
    );
}

#[test]
fn uploaded_copy_is_discoverable_and_replays_without_source_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("trace.log");
    std::fs::write(&source, b"original bytes").unwrap();
    let provider = Provider::default();
    let mut workspace = Workspace::open(&path).unwrap();
    let file = workspace
        .upload_drive_file("upload", &source, &destination(), &provider, |_, _| true)
        .unwrap();
    let added = file
        .added_at
        .clone()
        .expect("new uploaded copies record first registration");
    assert!(chrono::DateTime::parse_from_rfc3339(&added).is_ok());
    let provenance = workspace.drive_upload("upload").unwrap();
    assert_eq!(provenance.state, DriveUploadState::Completed);
    assert_eq!(provenance.remote_file_id.as_deref(), Some("reserved-file"));
    let calls = provider.ids.lock().unwrap().clone();
    assert!(
        workspace
            .purge_attachment(&file.id)
            .unwrap_err()
            .to_string()
            .contains("Remote files are never deleted")
    );
    assert_eq!(*provider.ids.lock().unwrap(), calls);
    assert_eq!(
        workspace.drive_reference(&file.id).unwrap().metadata.id,
        "reserved-file"
    );
    assert_eq!(
        workspace.attachments(10, 0).unwrap(),
        std::slice::from_ref(&file)
    );
    assert!(
        workspace
            .export_attachment(&file.id, dir.path().join("original.log"))
            .is_err()
    );
    drop(workspace);
    std::fs::remove_file(&source).unwrap();
    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(
        workspace
            .upload_drive_file("upload", &source, &destination(), &provider, |_, _| true)
            .unwrap(),
        file
    );
    assert_eq!(provider.ids.lock().unwrap().as_slice(), ["reserved-file"]);
    assert_eq!(
        workspace
            .rename_attachment(&file.id, "Uploaded evidence")
            .unwrap()
            .added_at
            .as_deref(),
        Some(added.as_str())
    );
    let backup = dir.path().join("uploaded-copy.sqlite3");
    workspace.backup(&backup).unwrap();
    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, backup).unwrap();
    let restored = Workspace::open(target).unwrap();
    assert_eq!(
        restored.attachment(&file.id).unwrap().added_at.as_deref(),
        Some(added.as_str())
    );
    assert_eq!(
        restored.drive_upload("upload").unwrap(),
        workspace.drive_upload("upload").unwrap()
    );
}
