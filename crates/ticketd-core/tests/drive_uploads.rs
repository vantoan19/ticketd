use std::{io::Read, sync::Mutex};
use ticketd_core::{Workspace, drive::*};

const CONNECTION: &str = "81aa7bfb-05c3-4934-a4e7-5c84e2cb83ec";

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
    unverified: bool,
    database: Option<std::path::PathBuf>,
    allocation_failed: bool,
    reserved: std::sync::atomic::AtomicUsize,
}
#[allow(clippy::unwrap_used)] // Fixture failures must fail the test, never become provider errors.
impl DriveUploadProvider for Provider {
    fn folder(&self, id: &str, _: Option<&str>) -> Result<DriveFolder, DriveError> {
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
            sha256_checksum: (!self.unverified).then(|| operation.request.sha256.clone()),
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
    let provenance = workspace.drive_upload("upload").unwrap();
    assert_eq!(provenance.state, DriveUploadState::Completed);
    assert_eq!(provenance.remote_file_id.as_deref(), Some("reserved-file"));
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
    let mut workspace = Workspace::open(path).unwrap();
    assert_eq!(
        workspace
            .upload_drive_file("upload", &source, &destination(), &provider, |_, _| true)
            .unwrap(),
        file
    );
    assert_eq!(provider.ids.lock().unwrap().as_slice(), ["reserved-file"]);
}
