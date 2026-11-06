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
    drop(workspace);
    let ticket = run(dir.path(), &["create", "Reuse current content"]);
    let reference = ticket["reference"].as_str().unwrap();
    run(dir.path(), &["attachment", "link", &file.id, reference]);
    assert_eq!(
        run(dir.path(), &["attachment", "drive-info", &file.id])["metadata"]["mime_type"],
        "application/vnd.google-apps.spreadsheet"
    );
    assert_eq!(
        run(dir.path(), &["attachment", "inspect", &file.id])["kind"],
        "external_reference"
    );
    assert_eq!(
        run(dir.path(), &["attachment", "list", "--ticket", reference])[0]["id"],
        file.id
    );
    assert!(
        run(dir.path(), &["attachment", "uri", &file.id])
            .as_str()
            .unwrap()
            .starts_with("ticketd://attachment/")
    );
    run(dir.path(), &["attachment", "detach", &file.id, reference]);
    assert_eq!(
        run(dir.path(), &["attachment", "inspect", &file.id])["id"],
        file.id
    );
}
