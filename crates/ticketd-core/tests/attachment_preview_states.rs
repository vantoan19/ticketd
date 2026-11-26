use ticketd_core::{
    AttachmentQuery, HTML_PREVIEW_BYTES, PDF_PREVIEW_BYTES, PreviewStatus, TEXT_EXCERPT_BYTES,
    TEXT_TAIL_BYTES, TEXT_WHOLE_BYTES, Workspace,
};

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

#[test]
fn an_html_report_reads_whole_for_the_viewer_and_never_as_media() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    let report = "<!doctype html><title>Run</title><style>td{color:red}</style><table><tr><td>é</td></tr></table>";
    let mut bytes = b"\xef\xbb\xbf".to_vec();
    bytes.extend_from_slice(report.as_bytes());
    let file = workspace
        .import_attachment_bytes("report", "Report.HTML", &bytes, |_, _| true)
        .unwrap();
    let preview = workspace.attachment_preview(&identity, &file.id).unwrap();
    assert!(preview.html);
    // Never media: the passive-media protocol keeps refusing it.
    assert_eq!(preview.status, PreviewStatus::Unsupported);
    assert!(preview.media_type.is_none());
    assert!(workspace.attachment_media(&identity, &file.id).is_err());
    assert_eq!(
        workspace.attachment_html(&identity, &file.id).unwrap(),
        report
    );

    // Only an HTML file, and only under this workspace's identity.
    let notes = workspace
        .import_attachment_bytes("notes", "notes.txt", b"<p>hi</p>", |_, _| true)
        .unwrap();
    assert!(
        !workspace
            .attachment_preview(&identity, &notes.id)
            .unwrap()
            .html
    );
    assert!(workspace.attachment_html(&identity, &notes.id).is_err());
    assert!(workspace.attachment_html("other", &file.id).is_err());

    // A report that is not UTF-8 text has no rendered preview.
    let latin = workspace
        .import_attachment_bytes("latin", "latin.htm", b"<p>caf\xe9</p>", |_, _| true)
        .unwrap();
    assert!(
        !workspace
            .attachment_preview(&identity, &latin.id)
            .unwrap()
            .html
    );
    assert!(workspace.attachment_html(&identity, &latin.id).is_err());

    // A missing stored copy falls back, with no path in the failure.
    std::fs::remove_file(
        dir.path()
            .join("workspace.sqlite3.attachments")
            .join(&file.locator),
    )
    .unwrap();
    let failure = workspace
        .attachment_html(&identity, &file.id)
        .unwrap_err()
        .to_string();
    assert!(!failure.contains(dir.path().to_str().unwrap()));
    assert!(
        !workspace
            .attachment_preview(&identity, &file.id)
            .unwrap()
            .html
    );
}

#[test]
fn a_report_over_the_limit_is_too_large_to_preview() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    let mut big = b"<p>".to_vec();
    big.resize(HTML_PREVIEW_BYTES as usize + 1, b'a');
    let file = workspace
        .import_attachment_bytes("big", "big.html", &big, |_, _| true)
        .unwrap();
    let preview = workspace.attachment_preview(&identity, &file.id).unwrap();
    assert_eq!(preview.status, PreviewStatus::TooLarge);
    assert!(!preview.html);
    assert!(workspace.attachment_html(&identity, &file.id).is_err());
}

#[test]
fn a_pdf_reads_whole_for_the_viewer_by_its_header_and_never_as_media() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    let pdf = b"%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n";
    // The header decides, not the name; stray leading bytes are allowed.
    let mut padded = b"\r\n\r\n".to_vec();
    padded.extend_from_slice(pdf);
    for (name, bytes) in [("plan.pdf", pdf.to_vec()), ("scan", padded)] {
        let file = workspace
            .import_attachment_bytes(name, name, &bytes, |_, _| true)
            .unwrap();
        let preview = workspace.attachment_preview(&identity, &file.id).unwrap();
        assert!(preview.pdf);
        assert!(!preview.html);
        // Never media: the passive-media protocol keeps refusing it.
        assert_eq!(preview.status, PreviewStatus::Unsupported);
        assert!(preview.media_type.is_none());
        assert!(workspace.attachment_media(&identity, &file.id).is_err());
        assert_eq!(
            workspace.attachment_pdf(&identity, &file.id).unwrap(),
            bytes
        );
        assert!(workspace.attachment_pdf("other", &file.id).is_err());
    }

    // A file named .pdf that is not one has no PDF preview and cannot be read as one.
    let fake = workspace
        .import_attachment_bytes("fake", "fake.pdf", b"<html>not a pdf</html>", |_, _| true)
        .unwrap();
    assert!(
        !workspace
            .attachment_preview(&identity, &fake.id)
            .unwrap()
            .pdf
    );
    assert!(workspace.attachment_pdf(&identity, &fake.id).is_err());

    // A missing stored copy falls back, with no path in the failure.
    let gone = workspace
        .import_attachment_bytes("gone", "gone.pdf", pdf, |_, _| true)
        .unwrap();
    std::fs::remove_file(
        dir.path()
            .join("workspace.sqlite3.attachments")
            .join(&gone.locator),
    )
    .unwrap();
    let failure = workspace
        .attachment_pdf(&identity, &gone.id)
        .unwrap_err()
        .to_string();
    assert!(!failure.contains(dir.path().to_str().unwrap()));
    assert!(
        !workspace
            .attachment_preview(&identity, &gone.id)
            .unwrap()
            .pdf
    );
}

#[test]
fn a_pdf_over_the_limit_is_too_large_to_preview() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    let mut big = b"%PDF-1.7\n".to_vec();
    big.resize(PDF_PREVIEW_BYTES as usize + 1, b'a');
    let file = workspace
        .import_attachment_bytes("big", "big.pdf", &big, |_, _| true)
        .unwrap();
    let preview = workspace.attachment_preview(&identity, &file.id).unwrap();
    assert_eq!(preview.status, PreviewStatus::TooLarge);
    assert!(!preview.pdf);
    assert!(workspace.attachment_pdf(&identity, &file.id).is_err());
}

#[test]
fn a_log_reads_whole_with_its_colours_removed_and_never_as_media_or_html() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    let coloured = "\u{1b}[31mFAIL\u{1b}[0m  checkout  timeout after 30s\nnext line\n".repeat(3);
    let log = workspace
        .import_attachment_bytes("run", "run.log", coloured.as_bytes(), |_, _| true)
        .unwrap();
    let preview = workspace.attachment_preview(&identity, &log.id).unwrap();
    assert_eq!(preview.status, PreviewStatus::Unsupported);
    assert!(preview.media_type.is_none() && !preview.html && !preview.pdf);
    let scope = preview.text.unwrap();
    assert!(!scope.partial);
    assert_eq!(scope.total_bytes, coloured.len() as u64);
    assert_eq!(scope.shown_bytes, scope.total_bytes);
    // The excerpt for other callers is readable now too, without the escapes.
    let excerpt = preview.text_excerpt.unwrap();
    assert!(excerpt.text.starts_with("FAIL  checkout"));
    let text = workspace.attachment_text(&identity, &log.id).unwrap();
    assert_eq!(
        text,
        "FAIL  checkout  timeout after 30s\nnext line\n".repeat(3)
    );
    assert!(workspace.attachment_text("other", &log.id).is_err());

    // Binary and HTML files have no text read.
    for (name, bytes) in [
        ("blob.bin", b"PK\x03\x04\0\x01".to_vec()),
        ("report.html", b"<p>hi</p>".to_vec()),
    ] {
        let file = workspace
            .import_attachment_bytes(name, name, &bytes, |_, _| true)
            .unwrap();
        assert!(
            workspace
                .attachment_preview(&identity, &file.id)
                .unwrap()
                .text
                .is_none()
        );
    }
}

#[test]
fn a_log_over_the_limit_shows_its_last_five_megabytes_from_a_line_start() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let identity = workspace.attachment_workspace_id().unwrap();
    let line = "2026-11-26 12:00:00 INFO request done in 12ms\n";
    let mut big = line
        .repeat(TEXT_WHOLE_BYTES as usize / line.len() + 2)
        .into_bytes();
    big.extend_from_slice(b"the last line\n");
    let file = workspace
        .import_attachment_bytes("big", "big.log", &big, |_, _| true)
        .unwrap();
    let scope = workspace
        .attachment_preview(&identity, &file.id)
        .unwrap()
        .text
        .unwrap();
    assert!(scope.partial);
    assert_eq!(scope.total_bytes, big.len() as u64);
    assert_eq!(scope.shown_bytes, TEXT_TAIL_BYTES);
    let text = workspace.attachment_text(&identity, &file.id).unwrap();
    assert!(text.len() as u64 <= TEXT_TAIL_BYTES);
    assert!(text.len() as u64 > TEXT_TAIL_BYTES - 200);
    assert!(text.starts_with("2026-11-26 12:00:00 INFO request done"));
    assert!(text.ends_with("the last line\n"));
    // The tail keeps the file's own numbering: its first line follows the dropped ones.
    let newlines = |bytes: &[u8]| bytes.iter().filter(|b| **b == b'\n').count() as u64;
    assert_eq!(
        workspace
            .attachment_text_first_line(&identity, &file.id)
            .unwrap(),
        newlines(&big) - newlines(text.as_bytes()) + 1
    );
    assert!(
        workspace
            .attachment_text_first_line("other", &file.id)
            .is_err()
    );

    // Exactly at the limit it is still whole.
    let at_limit = "x\n".repeat(TEXT_WHOLE_BYTES as usize / 2);
    let file = workspace
        .import_attachment_bytes("edge", "edge.txt", at_limit.as_bytes(), |_, _| true)
        .unwrap();
    assert!(
        !workspace
            .attachment_preview(&identity, &file.id)
            .unwrap()
            .text
            .unwrap()
            .partial
    );
    assert_eq!(
        workspace
            .attachment_text(&identity, &file.id)
            .unwrap()
            .len(),
        at_limit.len()
    );
    // A whole file starts at line 1.
    assert_eq!(
        workspace
            .attachment_text_first_line(&identity, &file.id)
            .unwrap(),
        1
    );
}
