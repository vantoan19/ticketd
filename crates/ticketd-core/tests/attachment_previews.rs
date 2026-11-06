use ticketd_core::{PreviewStatus, Workspace};

const PNG: &[u8] =
    b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89";

#[test]
fn preview_names_shared_usage_without_flattening_documents_drafts_or_trash() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .import_attachment_bytes("image", "image.png", PNG, |_, _| true)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let ticket = workspace.create_ticket("Investigate screenshot").unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            ticketd_core::TicketPatch {
                body: Some(format!("[Inline]({uri})")),
                ..Default::default()
            },
        )
        .unwrap();
    let document = workspace
        .create_document(Some("Incident analysis"), &format!("[Evidence]({uri})"))
        .unwrap();
    workspace.set_document_trashed(&document.id, true).unwrap();
    workspace
        .retain_draft(&ticketd_core::DraftRetention {
            owner: "unpublished-description".into(),
            kind: "draft".into(),
            revision: 0,
            payload: Some(serde_json::json!({"body":uri})),
            markdown: vec![format!("[Draft]({uri})")],
        })
        .unwrap();
    let preview = workspace
        .attachment_preview(&workspace.attachment_workspace_id().unwrap(), &file.id)
        .unwrap();
    assert_eq!(preview.usage.total, 4);
    assert!(
        preview
            .usage
            .entries
            .iter()
            .any(|usage| usage.label == "T-1 · Investigate screenshot"
                && usage.kind == "ticket_body")
    );
    assert!(
        preview
            .usage
            .entries
            .iter()
            .any(|usage| usage.label == "Incident analysis" && usage.trashed)
    );
    assert!(
        preview
            .usage
            .entries
            .iter()
            .any(|usage| usage.kind == "draft")
    );
    assert_eq!(
        workspace.ticket_attachments(&ticket.reference).unwrap(),
        [file]
    );
}

#[test]
fn replacing_one_direct_association_is_atomic_replayable_and_retains_other_uses() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let old = workspace
        .import_attachment_bytes("old", "old.png", PNG, |_, _| true)
        .unwrap();
    let new = workspace
        .import_attachment_bytes("new", "new.png", PNG, |_, _| true)
        .unwrap();
    let first = workspace.create_ticket("First").unwrap();
    let second = workspace.create_ticket("Second").unwrap();
    workspace
        .set_ticket_attachment(&first.reference, &old.id, true)
        .unwrap();
    workspace
        .set_ticket_attachment(&second.reference, &old.id, true)
        .unwrap();
    let request = || ticketd_core::WriteRequest::ReplaceTicketAttachment {
        reference: first.reference.clone(),
        previous_id: old.id.clone(),
        replacement_id: new.id.clone(),
    };
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TRIGGER fail_replacement BEFORE DELETE ON ticket_attachments BEGIN SELECT RAISE(ABORT, 'association failed'); END;").unwrap();
    assert!(workspace.write(Some("replace"), request()).is_err());
    assert_eq!(
        workspace.ticket_attachments(&first.reference).unwrap(),
        std::slice::from_ref(&old)
    );
    faults
        .execute_batch("DROP TRIGGER fail_replacement;")
        .unwrap();
    let outcome = workspace.write(Some("replace"), request()).unwrap();
    assert_eq!(
        workspace.write(Some("replace"), request()).unwrap(),
        outcome
    );
    assert_eq!(
        workspace.ticket_attachments(&first.reference).unwrap(),
        [new]
    );
    assert_eq!(
        workspace.ticket_attachments(&second.reference).unwrap(),
        std::slice::from_ref(&old)
    );
    let destination = dir.path().join("old-export.png");
    workspace.export_attachment(&old.id, &destination).unwrap();
    assert_eq!(std::fs::read(destination).unwrap(), PNG);
}

#[test]
fn preview_uses_stored_content_and_workspace_identity_without_trusting_the_filename() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .import_attachment_bytes("png", "Screenshot 空白.txt", PNG, |_, _| true)
        .unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    let preview = workspace.attachment_preview(&identity, &file.id).unwrap();
    assert_eq!(preview.attachment, file);
    assert_eq!(preview.status, PreviewStatus::Available);
    assert_eq!(preview.media_type.as_deref(), Some("image/png"));
    let mut media = workspace.attachment_media(&identity, &file.id).unwrap();
    assert_eq!(media.read(0, PNG.len() as u64).unwrap(), PNG);
    assert!(
        workspace
            .attachment_media("other-workspace", &file.id)
            .is_err()
    );
    assert!(
        workspace
            .attachment_media(&identity, "../../escape")
            .is_err()
    );
    assert!(
        workspace
            .attachment_media(&identity, &format!("{}?path=elsewhere", file.id))
            .is_err()
    );
}

#[test]
fn missing_and_incomplete_bytes_keep_metadata_and_retry_observes_restoration() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .import_attachment_bytes("png", "image.png", PNG, |_, _| true)
        .unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    let stored = dir
        .path()
        .join("workspace.sqlite3.attachments")
        .join(&file.locator);
    std::fs::remove_file(&stored).unwrap();
    let preview = workspace.attachment_preview(&identity, &file.id).unwrap();
    assert_eq!(preview.attachment, file);
    assert_eq!(preview.status, PreviewStatus::Missing);
    assert!(!preview.can_open);
    std::fs::write(&stored, b"partial").unwrap();
    assert_eq!(
        workspace
            .attachment_preview(&identity, &file.id)
            .unwrap()
            .status,
        PreviewStatus::Incomplete
    );
    std::fs::write(&stored, PNG).unwrap();
    assert_eq!(
        workspace
            .attachment_preview(&identity, &file.id)
            .unwrap()
            .status,
        PreviewStatus::Available
    );
}

#[test]
fn media_allowlist_rejects_active_content_and_bounds_preview_resources() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    for (request, bytes, expected) in [
        (
            "gif",
            b"GIF89a\x02\0\x03\0\0\0\0".as_slice(),
            Some("image/gif"),
        ),
        (
            "jpeg",
            b"\xff\xd8\xff\xc0\0\x11\x08\0\x02\0\x03\x03\x01\x11\0\x02\x11\0\x03\x11\0".as_slice(),
            Some("image/jpeg"),
        ),
        (
            "webp",
            b"RIFF\x16\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0\x01\0\0\x02\0\0".as_slice(),
            Some("image/webp"),
        ),
        (
            "wav",
            b"RIFF\x24\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0".as_slice(),
            Some("audio/wav"),
        ),
        (
            "mp3",
            b"\xff\xfb\x90\x64\0\0\0\0".as_slice(),
            Some("audio/mpeg"),
        ),
        (
            "ogg",
            b"OggS\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\x01\x08OpusHead".as_slice(),
            Some("audio/ogg"),
        ),
        (
            "mp4",
            b"\0\0\0\x18ftypisom\0\0\0\0isommp42".as_slice(),
            Some("video/mp4"),
        ),
        (
            "webm",
            b"\x1a\x45\xdf\xa3\x87\x42\x82\x84webm".as_slice(),
            Some("video/webm"),
        ),
        (
            "html-png",
            b"<!doctype html><script>alert(1)</script>".as_slice(),
            None,
        ),
        (
            "svg",
            b"<svg xmlns='http://www.w3.org/2000/svg'/>".as_slice(),
            None,
        ),
        ("pdf", b"%PDF-1.7\n".as_slice(), None),
        (
            "playlist",
            b"#EXTM3U\nhttps://example.com/remote.mp4".as_slice(),
            None,
        ),
        ("empty", b"".as_slice(), None),
    ] {
        let file = workspace
            .import_attachment_bytes(request, &format!("{request}.png"), bytes, |_, _| true)
            .unwrap();
        let preview = workspace.attachment_preview(&identity, &file.id).unwrap();
        assert_eq!(preview.media_type.as_deref(), expected, "{request}");
        assert_eq!(
            workspace.attachment_media(&identity, &file.id).is_ok(),
            expected.is_some(),
            "{request}"
        );
    }
    let mut huge = PNG.to_vec();
    huge[16..20].copy_from_slice(&100_000_u32.to_be_bytes());
    huge[20..24].copy_from_slice(&100_000_u32.to_be_bytes());
    let file = workspace
        .import_attachment_bytes("bomb", "tiny.png", &huge, |_, _| true)
        .unwrap();
    assert_eq!(
        workspace
            .attachment_preview(&identity, &file.id)
            .unwrap()
            .status,
        PreviewStatus::TooLarge
    );
    assert!(workspace.attachment_media(&identity, &file.id).is_err());
}

#[test]
fn managed_directory_links_cannot_serve_or_export_bytes_outside_the_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .import_attachment_bytes("png", "image.png", PNG, |_, _| true)
        .unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    let bytes_directory = dir
        .path()
        .join("workspace.sqlite3.attachments")
        .join(&file.id)
        .join("bytes");
    let outside = dir.path().join("outside");
    std::fs::rename(&bytes_directory, &outside).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &bytes_directory).unwrap();
    #[cfg(windows)]
    assert!(
        std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&bytes_directory)
            .arg(&outside)
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(
        workspace
            .attachment_preview(&identity, &file.id)
            .unwrap()
            .status,
        PreviewStatus::Unavailable
    );
    assert!(workspace.attachment_media(&identity, &file.id).is_err());
    assert!(
        workspace
            .export_attachment(&file.id, dir.path().join("export.png"))
            .is_err()
    );
    assert!(workspace.attachment_open_path(&file.id).is_err());
    assert_eq!(workspace.attachment(&file.id).unwrap(), file);
}

#[test]
fn replacing_snapshot_bytes_with_a_directory_keeps_metadata_and_never_opens_it_as_media() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .import_attachment_bytes("image", "image.png", PNG, |_, _| true)
        .unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    let stored = dir
        .path()
        .join("workspace.sqlite3.attachments")
        .join(&file.locator);
    std::fs::remove_file(&stored).unwrap();
    std::fs::create_dir(&stored).unwrap();
    let preview = workspace.attachment_preview(&identity, &file.id).unwrap();
    assert_eq!(preview.status, PreviewStatus::Incomplete);
    assert_eq!(preview.attachment, file);
    assert!(workspace.attachment_media(&identity, &file.id).is_err());
}
