use std::{path::Path, process::Command};

#[allow(clippy::unwrap_used)]
fn run(dir: &Path, args: &[&str]) -> serde_json::Value {
    let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .env("TICKETD_TEST_WORKSPACE", dir.join("workspace.sqlite3"))
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn cli_reviews_quarantines_restores_and_replays_without_a_desktop() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("trace.txt");
    std::fs::write(&source, b"CLI recovery").unwrap();
    let file = run(dir.path(), &["attachment", "add", source.to_str().unwrap()]);
    let id = file["id"].as_str().unwrap();
    let review = run(dir.path(), &["attachment", "cleanup-review", id]);
    assert_eq!(review["eligible"], true);
    let quarantined = run(
        dir.path(),
        &["attachment", "quarantine", id, "--request-id", "cleanup"],
    );
    assert_eq!(quarantined["quarantined"], true);
    let results = run(
        dir.path(),
        &["attachment", "search", "", "--state", "quarantined"],
    );
    assert_eq!(results[0]["attachment"]["id"], id);
    let restored = run(
        dir.path(),
        &["attachment", "restore", id, "--request-id", "restore"],
    );
    assert_eq!(restored["quarantined"], false);
    // Lost-response replay returns its original outcome without moving bytes again.
    assert_eq!(
        run(
            dir.path(),
            &["attachment", "quarantine", id, "--request-id", "cleanup"]
        ),
        quarantined
    );
    assert_eq!(
        run(dir.path(), &["attachment", "inspect", id])["quarantined"],
        false
    );
    let output = dir.path().join("out.txt");
    run(
        dir.path(),
        &["attachment", "export", id, output.to_str().unwrap()],
    );
    assert_eq!(std::fs::read(output).unwrap(), b"CLI recovery");
}

#[test]
fn cli_permanent_purge_requires_confirmation_and_reports_unavailable_identity() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("trace.txt");
    std::fs::write(&source, b"explicit CLI purge").unwrap();
    let file = run(
        dir.path(),
        &[
            "attachment",
            "add",
            source.to_str().unwrap(),
            "--request-id",
            "upload",
        ],
    );
    let id = file["id"].as_str().unwrap();
    run(dir.path(), &["attachment", "quarantine", id]);
    let unconfirmed = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .env(
            "TICKETD_TEST_WORKSPACE",
            dir.path().join("workspace.sqlite3"),
        )
        .args(["attachment", "purge", id])
        .output()
        .unwrap();
    assert!(!unconfirmed.status.success());
    assert!(String::from_utf8_lossy(&unconfirmed.stderr).contains("--confirm"));
    assert_eq!(
        run(dir.path(), &["attachment", "inspect", id])["purge_state"],
        "retained"
    );
    assert_eq!(
        run(dir.path(), &["attachment", "purge", id, "--confirm"])["purge_state"],
        "purged"
    );
    assert_eq!(
        run(dir.path(), &["attachment", "purge", id, "--confirm"])["purge_state"],
        "purged"
    );
    assert_eq!(
        run(
            dir.path(),
            &[
                "attachment",
                "add",
                source.to_str().unwrap(),
                "--request-id",
                "upload"
            ]
        )["purge_state"],
        "purged"
    );
    let restore = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .env(
            "TICKETD_TEST_WORKSPACE",
            dir.path().join("workspace.sqlite3"),
        )
        .args(["attachment", "restore", id])
        .output()
        .unwrap();
    assert!(!restore.status.success());
    let error = String::from_utf8_lossy(&restore.stderr);
    assert!(
        error.contains("purged") && error.contains("backup"),
        "{error}"
    );
}

#[test]
fn portable_markdown_exports_ticket_document_and_selected_input_without_desktop() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("trace.log");
    std::fs::write(&source, b"portable evidence").unwrap();
    let ticket = run(dir.path(), &["create", "Share evidence"]);
    let file = run(
        dir.path(),
        &[
            "attachment",
            "add",
            source.to_str().unwrap(),
            "--ticket",
            ticket["reference"].as_str().unwrap(),
        ],
    );
    let result = run(
        dir.path(),
        &[
            "export-markdown",
            "--ticket",
            "T-1",
            "--output",
            dir.path().to_str().unwrap(),
        ],
    );
    assert_eq!(result["status"], "complete");
    assert_eq!(result["attachments"][0]["attachment_id"], file["id"]);
    let folder = Path::new(result["directory"].as_str().unwrap());
    assert_eq!(
        std::fs::read(folder.join(result["attachments"][0]["path"].as_str().unwrap())).unwrap(),
        b"portable evidence"
    );
    let uri = run(
        dir.path(),
        &["attachment", "uri", file["id"].as_str().unwrap()],
    );
    let markdown = format!("[Selected]({})", uri.as_str().unwrap());
    let document = run(dir.path(), &["document", "create", "--body", &markdown]);
    let result = run(
        dir.path(),
        &[
            "export-markdown",
            "--document",
            document["id"].as_str().unwrap(),
            "--output",
            dir.path().to_str().unwrap(),
        ],
    );
    assert_eq!(result["status"], "complete");
    std::fs::write(&source, "[Missing](ticketd://attachment/foreign/absent)").unwrap();
    let result = run(
        dir.path(),
        &[
            "export-markdown",
            "--markdown-file",
            source.to_str().unwrap(),
            "--output",
            dir.path().to_str().unwrap(),
        ],
    );
    assert_eq!(result["status"], "partial");
    assert!(result["attachments"][0]["omission"].is_string());
}

#[test]
fn cli_searches_usage_and_renames_without_changing_inline_labels_or_reuploading() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("original.txt");
    std::fs::write(&path, b"stored bytes").unwrap();
    let file = run(dir.path(), &["attachment", "add", path.to_str().unwrap()]);
    let id = file["id"].as_str().unwrap();
    let renamed = run(
        dir.path(),
        &[
            "attachment",
            "rename",
            id,
            "Readable name",
            "--request-id",
            "rename-cli",
        ],
    );
    assert_eq!(renamed["original_filename"], "original.txt");
    assert_eq!(renamed["id"], id);
    let results = run(
        dir.path(),
        &[
            "attachment",
            "search",
            "readable",
            "--state",
            "unused",
            "--limit",
            "1",
        ],
    );
    assert_eq!(results[0]["attachment"], renamed);
    assert_eq!(results[0]["usage"]["protections"], serde_json::json!([]));
    assert_eq!(
        run(
            dir.path(),
            &["attachment", "search", "readable", "--offset", "1"]
        ),
        serde_json::json!([])
    );
    let ticket = run(dir.path(), &["create", "Reuse"]);
    let reference = ticket["reference"].as_str().unwrap();
    run(dir.path(), &["attachment", "link", id, reference]);
    assert_eq!(
        run(
            dir.path(),
            &["attachment", "search", "original", "--state", "in-use"]
        )[0]["usage"]["protections"][0]["kind"],
        "ticket_attachment"
    );
    assert_eq!(
        run(
            dir.path(),
            &["attachment", "list", "--ticket", reference, "--limit", "0"]
        ),
        serde_json::json!([])
    );
}

#[test]
fn cli_explains_and_changes_the_shared_workspace_upload_limit() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        run(dir.path(), &["attachment", "limit"])["limit_bytes"],
        104857600
    );
    assert_eq!(
        run(dir.path(), &["attachment", "limit", "--bytes", "4"])["limit_bytes"],
        4
    );
    let source = dir.path().join("large.bin");
    std::fs::write(&source, b"12345").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .env(
            "TICKETD_TEST_WORKSPACE",
            dir.path().join("workspace.sqlite3"),
        )
        .args(["attachment", "add", source.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("4 bytes"), "{error}");
    assert!(error.contains("attachment limit --bytes"), "{error}");
    assert_eq!(
        run(dir.path(), &["attachment", "list"]),
        serde_json::json!([])
    );
}

#[test]
fn cli_exposes_upload_recovery_without_desktop_or_credentials() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        run(dir.path(), &["attachment", "drive-uploads"]),
        serde_json::json!([])
    );
    let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .env(
            "TICKETD_TEST_WORKSPACE",
            dir.path().join("workspace.sqlite3"),
        )
        .args(["attachment", "drive-upload-status", "unknown"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("operation not found"));
    let help = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .args(["attachment", "drive-upload", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    let text = String::from_utf8_lossy(&help.stdout);
    assert!(text.contains("--folder"));
    assert!(text.contains("--request-id"));
}

#[test]
fn cli_replays_a_completed_drive_upload_with_the_source_and_desktop_absent() {
    use ticketd_core::drive::*;
    struct Provider(std::sync::Mutex<Option<DriveUploadedFile>>);
    #[allow(clippy::unwrap_used)] // Deterministic external provider fixture.
    impl DriveUploadProvider for Provider {
        fn folder(&self, id: &str, _: Option<&str>) -> Result<DriveFolder, DriveError> {
            Ok(DriveFolder {
                id: id.into(),
                name: "Uploads".into(),
                can_add_children: true,
            })
        }
        fn reserve_file_id(&self) -> Result<String, DriveError> {
            Ok("blob-id".into())
        }
        fn uploaded_file(&self, _: &str) -> Result<Option<DriveUploadedFile>, DriveError> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn upload_blob(
            &self,
            operation: &DriveUploadOperation,
            _: &mut dyn std::io::Read,
            _: &mut dyn FnMut(u64, u64) -> bool,
        ) -> Result<(), DriveError> {
            *self.0.lock().unwrap() = Some(DriveUploadedFile {
                metadata: DriveMetadata {
                    id: "blob-id".into(),
                    name: "trace.log".into(),
                    mime_type: "application/octet-stream".into(),
                    size_bytes: Some(14),
                    web_url: "https://drive.google.com/file/d/blob-id/view".into(),
                    resource_key: None,
                },
                sha256_checksum: Some(
                    "52c3935626c104b2cbc9031291a1c4d56614c38f52072a361d658a58a9c48698".into(),
                ),
                version: Some("7".into()),
                operation_id: Some(operation.attachment_id.clone()),
                parent_ids: vec!["folder".into()],
            });
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = ticketd_core::Workspace::open(&path).unwrap();
    let destination = DriveUploadDestination {
        connection_id: "81aa7bfb-05c3-4934-a4e7-5c84e2cb83ec".into(),
        folder_id: "folder".into(),
        resource_key: None,
    };
    let file = workspace
        .upload_drive_bytes(
            "completed",
            "trace.log",
            b"original bytes",
            &destination,
            &Provider(Default::default()),
            |_, _| true,
        )
        .unwrap();
    drop(workspace);
    assert_eq!(
        run(
            dir.path(),
            &[
                "attachment",
                "drive-upload",
                dir.path().join("trace.log").to_str().unwrap(),
                "--connection",
                &destination.connection_id,
                "--folder",
                "folder",
                "--request-id",
                "completed"
            ]
        ),
        serde_json::to_value(&file).unwrap()
    );
    assert_eq!(
        run(
            dir.path(),
            &["attachment", "drive-upload-status", "completed", "--check"]
        )["state"],
        "completed"
    );
    assert_eq!(
        run(dir.path(), &["attachment", "drive-uploads"])[0]["attachment_id"],
        file.id
    );
}

#[test]
fn independent_cli_processes_add_inspect_reuse_export_and_detach_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let ticket = run(dir.path(), &["create", "Investigate"]);
    let reference = ticket["reference"].as_str().unwrap();
    let source = dir.path().join("trace.bin");
    std::fs::write(&source, [0, 255, 10, 13]).unwrap();
    let file = run(
        dir.path(),
        &[
            "attachment",
            "add",
            source.to_str().unwrap(),
            "--ticket",
            reference,
            "--request-id",
            "cli-upload",
        ],
    );
    let id = file["id"].as_str().unwrap();
    std::fs::remove_file(&source).unwrap();
    assert_eq!(run(dir.path(), &["attachment", "inspect", id]), file);
    assert_eq!(
        run(
            dir.path(),
            &[
                "attachment",
                "add",
                source.to_str().unwrap(),
                "--ticket",
                reference,
                "--request-id",
                "cli-upload"
            ]
        ),
        file
    );
    assert_eq!(
        run(dir.path(), &["attachment", "list", "--ticket", reference]),
        serde_json::json!([file.clone()])
    );
    run(dir.path(), &["attachment", "detach", id, reference]);
    assert_eq!(
        run(dir.path(), &["attachment", "list", "--ticket", reference]),
        serde_json::json!([])
    );
    run(dir.path(), &["attachment", "link", id, reference]);
    let output = dir.path().join("output.bin");
    run(
        dir.path(),
        &["attachment", "export", id, output.to_str().unwrap()],
    );
    assert_eq!(std::fs::read(output).unwrap(), [0, 255, 10, 13]);
    assert_eq!(
        run(dir.path(), &["attachment", "list"]),
        serde_json::json!([file])
    );
}

#[test]
fn cli_authored_markdown_tracks_workspace_scoped_inline_references() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("trace.txt");
    std::fs::write(&source, b"trace").unwrap();
    let file = run(dir.path(), &["attachment", "add", source.to_str().unwrap()]);
    let id = file["id"].as_str().unwrap();
    let uri = run(dir.path(), &["attachment", "uri", id]);
    let uri = uri.as_str().unwrap();
    assert!(uri.starts_with("ticketd://attachment/"));
    assert!(!uri.contains("trace.txt"));
    let body = format!("Keep [My authored label]({uri}) here.");
    let document = run(dir.path(), &["document", "create", "--body", &body]);
    let document_id = document["id"].as_str().unwrap();
    let workspace = ticketd_core::Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    assert_eq!(workspace.show_document(document_id).unwrap().body, body);
    assert_eq!(
        workspace.embedded_attachments(document_id).unwrap()[0].id,
        id
    );
}

#[test]
fn independent_cli_reuses_authorized_drive_identity_without_desktop_or_snapshot_bytes() {
    use ticketd_core::drive::{AttachmentProvider, DriveError, DriveMetadata};
    struct Provider;
    impl AttachmentProvider for Provider {
        fn metadata(&self, id: &str, _: Option<&str>) -> Result<DriveMetadata, DriveError> {
            Ok(DriveMetadata {
                id: id.into(),
                name: "Current sheet".into(),
                mime_type: "application/vnd.google-apps.spreadsheet".into(),
                size_bytes: None,
                web_url: format!("https://docs.google.com/spreadsheets/d/{id}/edit"),
                resource_key: None,
            })
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mut workspace =
        ticketd_core::Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let connection = "a6172e56-e552-4002-af87-ac647ea703d9";
    let file = workspace
        .reference_drive_file(connection, "sheet-123", None, &Provider)
        .unwrap();
    let local = workspace
        .import_attachment_bytes("local", "trace.log", b"retained bytes", |_, _| true)
        .unwrap();
    drop(workspace);
    let ticket = run(dir.path(), &["create", "Reuse current content"]);
    let reference = ticket["reference"].as_str().unwrap();
    run(dir.path(), &["attachment", "link", &file.id, reference]);
    run(dir.path(), &["attachment", "link", &local.id, reference]);
    assert_eq!(
        run(dir.path(), &["attachment", "drive-info", &file.id])["metadata"]["mime_type"],
        "application/vnd.google-apps.spreadsheet"
    );
    let status = run(dir.path(), &["attachment", "drive-status", &file.id]);
    assert_eq!(status["reference"]["metadata"]["id"], "sheet-123");
    assert_eq!(status["failure"]["kind"], "reauthorize");
    let failure = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .env(
            "TICKETD_TEST_WORKSPACE",
            dir.path().join("workspace.sqlite3"),
        )
        .args(["attachment", "drive-resolve", &file.id])
        .output()
        .unwrap();
    assert!(!failure.status.success());
    let message = String::from_utf8_lossy(&failure.stderr);
    assert!(message.contains("reauthorize"));
    assert!(message.contains(&format!("drive-authorize {}", file.id)));
    assert!(message.contains("https://docs.google.com/spreadsheets/d/sheet-123/edit"));
    let authorize = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .env(
            "TICKETD_TEST_WORKSPACE",
            dir.path().join("workspace.sqlite3"),
        )
        .env_remove("TICKETD_GOOGLE_OAUTH_CLIENT_FILE")
        .args(["attachment", "drive-authorize", &file.id])
        .output()
        .unwrap();
    assert!(!authorize.status.success());
    assert!(
        String::from_utf8_lossy(&authorize.stderr).contains("TICKETD_GOOGLE_OAUTH_CLIENT_FILE")
    );
    assert_eq!(
        run(dir.path(), &["attachment", "inspect", &file.id])["kind"],
        "external_reference"
    );
    assert_eq!(
        run(dir.path(), &["attachment", "list", "--ticket", reference])
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == file.id)
            .unwrap()["id"],
        file.id,
    );
    assert!(
        run(dir.path(), &["attachment", "uri", &file.id])
            .as_str()
            .unwrap()
            .starts_with("ticketd://attachment/")
    );
    let exported = run(
        dir.path(),
        &[
            "export-markdown",
            "--ticket",
            reference,
            "--output",
            dir.path().to_str().unwrap(),
        ],
    );
    assert_eq!(exported["status"], "complete");
    let external = exported["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["attachment_id"] == file.id)
        .unwrap();
    assert_eq!(external["kind"], "external_reference");
    assert_eq!(
        external["external_url"],
        "https://docs.google.com/spreadsheets/d/sheet-123/edit"
    );
    assert!(external["path"].is_null());
    let backup = dir.path().join("backup.sqlite3");
    let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .env(
            "TICKETD_TEST_WORKSPACE",
            dir.path().join("workspace.sqlite3"),
        )
        .args(["backup", backup.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let inspection = run(dir.path(), &["inspect-backup", backup.to_str().unwrap()]);
    assert_eq!(inspection["check"]["status"], "valid");
    assert_eq!(inspection["attachment_content"]["local_snapshots"], 1);
    assert_eq!(inspection["attachment_content"]["remote_references"], 1);
    assert_eq!(
        inspection["attachment_content"]["remote_bytes_included"],
        false
    );
    assert_eq!(
        inspection["attachment_content"]["remote_access_verified"],
        false
    );
    run(dir.path(), &["attachment", "detach", &file.id, reference]);
    assert_eq!(
        run(dir.path(), &["attachment", "inspect", &file.id])["id"],
        file.id
    );
}

#[test]
fn cli_reports_protected_unpublished_drafts_without_a_desktop_process() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("draft.txt");
    std::fs::write(&source, b"unpublished").unwrap();
    let file = run(dir.path(), &["attachment", "add", source.to_str().unwrap()]);
    let id = file["id"].as_str().unwrap();
    let mut workspace =
        ticketd_core::Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let body = format!("[Draft]({})", workspace.attachment_uri(id).unwrap());
    workspace
        .retain_draft(&ticketd_core::DraftRetention {
            owner: "activity:T-1".into(),
            kind: "draft".into(),
            revision: 0,
            payload: Some(serde_json::json!({"brief": body})),
            markdown: vec![body],
        })
        .unwrap();
    drop(workspace);
    let usage = run(dir.path(), &["attachment", "usage", id]);
    assert_eq!(usage["eligible"], false);
    assert_eq!(usage["protections"][0]["owner"], "activity:T-1");
    assert_eq!(usage["protections"][0]["kind"], "draft");
    let recovery = run(dir.path(), &["attachment", "recovery-drafts"]);
    assert_eq!(recovery[0]["owner"], "activity:T-1");
    assert!(
        recovery[0]["payload"]["brief"]
            .as_str()
            .unwrap()
            .contains("ticketd://attachment/")
    );
    let completed = run(
        dir.path(),
        &[
            "attachment",
            "complete-draft-migration",
            "--all-profiles-reviewed",
        ],
    );
    assert_eq!(completed["legacy_drafts_pending"], false);
    // Acknowledgement never releases an actual protected draft.
    assert_eq!(
        run(dir.path(), &["attachment", "usage", id])["eligible"],
        false
    );
    run(
        dir.path(),
        &[
            "attachment",
            "release-recovery",
            "activity:T-1",
            "--revision",
            "1",
            "--discard-recovery",
        ],
    );
    assert_eq!(
        run(dir.path(), &["attachment", "usage", id])["eligible"],
        true
    );
    let exported = dir.path().join("reviewed.txt");
    run(
        dir.path(),
        &["attachment", "export", id, exported.to_str().unwrap()],
    );
    assert_eq!(std::fs::read(exported).unwrap(), b"unpublished");
}
