use ticketd_core::{AttachmentQuery, PreviewStatus, TEXT_EXCERPT_BYTES, Workspace};

const PNG: &[u8] =
    b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89";

#[test]
fn plain_text_previews_as_an_excerpt_and_binary_never_does() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    let notes = workspace
        .import_attachment_bytes("notes", "notes.txt", b"Line one\n\tLine two\n", |_, _| true)
        .unwrap();
    let preview = workspace.attachment_preview(&identity, &notes.id).unwrap();
    assert_eq!(preview.status, PreviewStatus::Unsupported);
    let excerpt = preview.text_excerpt.unwrap();
    assert_eq!(excerpt.text, "Line one\n\tLine two\n");
    assert!(!excerpt.truncated);

    // A long file shows its start, cut on a character boundary.
    let mut long = "é".repeat(40_000).into_bytes();
    long.push(b'\n');
    let long = workspace
        .import_attachment_bytes("long", "long.md", &long, |_, _| true)
        .unwrap();
    let excerpt = workspace
        .attachment_preview(&identity, &long.id)
        .unwrap()
        .text_excerpt
        .unwrap();
    assert!(excerpt.truncated);
    assert_eq!(excerpt.text.len(), TEXT_EXCERPT_BYTES);

    let binary = workspace
        .import_attachment_bytes("blob", "blob.bin", b"PK\x03\x04\0\x01\x02", |_, _| true)
        .unwrap();
    assert!(
        workspace
            .attachment_preview(&identity, &binary.id)
            .unwrap()
            .text_excerpt
            .is_none()
    );
    // Media keeps its own preview, never an excerpt.
    let image = workspace
        .import_attachment_bytes("image", "image.png", PNG, |_, _| true)
        .unwrap();
    assert!(
        workspace
            .attachment_preview(&identity, &image.id)
            .unwrap()
            .text_excerpt
            .is_none()
    );
}

#[test]
fn the_library_flags_a_kept_file_whose_stored_copy_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .import_attachment_bytes("png", "image.png", PNG, |_, _| true)
        .unwrap();
    let missing = |workspace: &Workspace| {
        workspace
            .search_attachments(&AttachmentQuery::default())
            .unwrap()
            .into_iter()
            .find(|row| row.attachment.id == file.id)
            .unwrap()
            .missing
    };
    assert!(!missing(&workspace));
    let stored = dir
        .path()
        .join("workspace.sqlite3.attachments")
        .join(&file.locator);
    std::fs::remove_file(&stored).unwrap();
    assert!(missing(&workspace));
    std::fs::write(&stored, PNG).unwrap();
    assert!(!missing(&workspace));
}
