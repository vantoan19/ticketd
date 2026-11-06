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
}
