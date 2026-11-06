use ticketd_core::{MarkdownExportSource, Workspace};

#[test]
fn exports_repeated_snapshot_once_and_leaves_canonical_document_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = dir.path().join("trace.log");
    std::fs::write(&source, b"diagnostic bytes").unwrap();
    let file = workspace
        .import_attachment("upload", &source, None)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let markdown = format!("Read [custom label]({uri}) and ![image]({uri}).\n\n`[example]({uri})`");
    let document = workspace.create_document(None, &markdown).unwrap();
    std::fs::remove_file(source).unwrap();
    let export = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Document {
                id: document.id.clone(),
            },
            dir.path(),
        )
        .unwrap();
    assert_eq!(serde_json::to_value(&export).unwrap()["status"], "complete");
    assert_eq!(export.attachments.len(), 1);
    let copied = export.attachments[0].path.as_ref().unwrap();
    assert_eq!(
        std::fs::read(export.directory.join(copied)).unwrap(),
        b"diagnostic bytes"
    );
    let output = std::fs::read_to_string(export.directory.join("content.md")).unwrap();
    assert!(
        output.contains(&format!("[custom label]({copied})")),
        "{output}"
    );
    assert!(output.contains(&format!("![image]({copied})")));
    assert!(output.contains(&format!("`[example]({uri})`")));
    assert_eq!(
        workspace.show_document(&document.id).unwrap().body,
        markdown
    );
    assert!(export.directory.join("manifest.json").is_file());
}

#[test]
fn selection_rewrites_reference_definitions_and_scheme_casing_without_touching_code() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .import_attachment_bytes("upload", "same name.txt", b"selected", |_, _| true)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let upper = uri.replacen("ticketd", "TICKETD", 1);
    let body = format!(
        "[custom][file]\n\n[file]: <{uri}> \"title\"\n\n[upper]({upper})\n\n```md\n[code]({uri})\n```\n"
    );
    let export = workspace
        .export_markdown_with_files(MarkdownExportSource::Markdown { body }, dir.path())
        .unwrap();
    let output = std::fs::read_to_string(export.directory.join("content.md")).unwrap();
    assert!(!output.contains(&format!("[upper]({upper})")), "{output}");
    assert_eq!(
        std::fs::read_dir(export.directory.join("files"))
            .unwrap()
            .count(),
        1
    );
    assert!(output.contains("[custom][file]"));
    assert!(output.contains("\"title\""));
    assert!(output.contains(&format!("[code]({uri})")));
}

#[test]
fn ticket_exports_direct_and_inline_colliding_names_without_flattening_linked_documents() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let a = workspace
        .import_attachment_bytes("a", "same.txt", b"first", |_, _| true)
        .unwrap();
    let b = workspace
        .import_attachment_bytes("b", "same.txt", b"second", |_, _| true)
        .unwrap();
    let indirect = workspace
        .import_attachment_bytes("c", "indirect.txt", b"document only", |_, _| true)
        .unwrap();
    let a_uri = workspace.attachment_uri(&a.id).unwrap();
    let document = workspace
        .create_document(
            None,
            &format!(
                "[indirect]({})",
                workspace.attachment_uri(&indirect.id).unwrap()
            ),
        )
        .unwrap();
    let ticket = workspace.create_ticket("Share evidence").unwrap();
    workspace
        .change_ticket(
            &ticket.reference,
            ticketd_core::TicketPatch {
                body: Some(format!("See [inline]({a_uri}).")),
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &a.id, true)
        .unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &b.id, true)
        .unwrap();
    workspace
        .set_ticket_document(&ticket.reference, &document.id, true)
        .unwrap();
    let export = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Ticket {
                reference: ticket.reference,
            },
            dir.path(),
        )
        .unwrap();
    assert_eq!(export.attachments.len(), 2);
    let first = export
        .attachments
        .iter()
        .find(|e| e.attachment_id.as_deref() == Some(&a.id))
        .unwrap()
        .path
        .as_ref()
        .unwrap();
    let second = export
        .attachments
        .iter()
        .find(|e| e.attachment_id.as_deref() == Some(&b.id))
        .unwrap()
        .path
        .as_ref()
        .unwrap();
    assert_ne!(first.to_lowercase(), second.to_lowercase());
    assert_eq!(
        std::fs::read(export.directory.join(first)).unwrap(),
        b"first"
    );
    assert_eq!(
        std::fs::read(export.directory.join(second)).unwrap(),
        b"second"
    );
    let output = std::fs::read_to_string(export.directory.join("content.md")).unwrap();
    assert!(output.contains("## Direct attachments"));
    assert!(!output.contains("indirect.txt"));
    assert_eq!(
        std::fs::read_dir(export.directory.join("files"))
            .unwrap()
            .count(),
        2
    );
}

#[test]
fn missing_and_foreign_files_keep_readable_links_and_explicit_partial_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&db).unwrap();
    let file = workspace
        .import_attachment_bytes("a", "lost.txt", b"lost", |_, _| true)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let foreign = format!("ticketd://attachment/{}/{}", uuid::Uuid::new_v4(), file.id);
    let body = format!("[Lost report]({uri}) and [Other workspace]({foreign})");
    std::fs::remove_file(
        std::path::PathBuf::from(format!("{}.attachments", db.display())).join(&file.locator),
    )
    .unwrap();
    let export = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Markdown { body: body.clone() },
            dir.path(),
        )
        .unwrap();
    assert_eq!(export.status, ticketd_core::ExportStatus::Partial);
    assert_eq!(
        std::fs::read_to_string(export.directory.join("content.md")).unwrap(),
        body
    );
    assert!(
        export
            .attachments
            .iter()
            .all(|e| e.omission.is_some() && e.path.is_none())
    );
    assert!(
        export
            .attachments
            .iter()
            .any(|e| e.display_name == "lost.txt")
    );
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(export.directory.join("manifest.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["status"], "partial");
    assert_eq!(
        std::fs::read_dir(export.directory.join("files"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn output_folder_is_required_and_repeated_exports_never_overwrite_previous_results() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = MarkdownExportSource::Markdown {
        body: "original".into(),
    };
    assert!(
        workspace
            .export_markdown_with_files(source.clone(), dir.path().join("absent"))
            .is_err()
    );
    let first = workspace
        .export_markdown_with_files(source.clone(), dir.path())
        .unwrap();
    std::fs::write(first.directory.join("content.md"), b"keep my edits").unwrap();
    let second = workspace
        .export_markdown_with_files(source, dir.path())
        .unwrap();
    assert_ne!(first.directory, second.directory);
    assert_eq!(
        std::fs::read(first.directory.join("content.md")).unwrap(),
        b"keep my edits"
    );
}

struct NativeFile;
impl ticketd_core::drive::AttachmentProvider for NativeFile {
    fn metadata(
        &self,
        id: &str,
        _: Option<&str>,
    ) -> Result<ticketd_core::drive::DriveMetadata, ticketd_core::drive::DriveError> {
        Ok(ticketd_core::drive::DriveMetadata {
            id: id.into(),
            name: "Current plan".into(),
            mime_type: "application/vnd.google-apps.document".into(),
            size_bytes: None,
            web_url: "https://docs.google.com/document/d/native/edit".into(),
            resource_key: None,
        })
    }
}

#[test]
fn external_native_reference_exports_provider_link_without_download_or_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let connection = uuid::Uuid::new_v4().to_string();
    let file = workspace
        .reference_drive_file(&connection, "native", None, &NativeFile)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let export = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Markdown {
                body: format!("Read [my plan]({uri})"),
            },
            dir.path(),
        )
        .unwrap();
    assert_eq!(export.status, ticketd_core::ExportStatus::Complete);
    assert_eq!(
        export.attachments[0].external_url.as_deref(),
        Some("https://docs.google.com/document/d/native/edit")
    );
    assert!(export.attachments[0].path.is_none());
    assert_eq!(
        std::fs::read_to_string(export.directory.join("content.md")).unwrap(),
        "Read [my plan](https://docs.google.com/document/d/native/edit)"
    );
    let manifest = std::fs::read_to_string(export.directory.join("manifest.json")).unwrap();
    assert!(!manifest.contains(&connection));
}

#[test]
fn link_titles_and_html_fallbacks_do_not_leave_silent_internal_destinations() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .import_attachment_bytes("a", "file.txt", b"portable", |_, _| true)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let export = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Markdown {
                body: format!(
                    "[custom]({uri} \"title ](example\")\n\n<a href=\"{uri}\">HTML label</a>"
                ),
            },
            dir.path(),
        )
        .unwrap();
    let output = std::fs::read_to_string(export.directory.join("content.md")).unwrap();
    assert!(!output.contains(&uri), "{output}");
    assert!(output.contains("\"title ](example\""));
    assert!(output.contains("HTML label</a>"));
    assert_eq!(export.status, ticketd_core::ExportStatus::Complete);
}

#[test]
fn foreign_reference_never_copies_a_present_local_identity_with_the_same_attachment_id() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .import_attachment_bytes("a", "private.txt", b"local private bytes", |_, _| true)
        .unwrap();
    let foreign = format!("ticketd://attachment/{}/{}", uuid::Uuid::new_v4(), file.id);
    let export = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Markdown {
                body: format!("[Foreign report]({foreign})"),
            },
            dir.path(),
        )
        .unwrap();
    assert_eq!(export.status, ticketd_core::ExportStatus::Partial);
    assert!(export.attachments[0].path.is_none());
    assert_eq!(export.attachments[0].display_name, foreign);
    assert_eq!(
        std::fs::read_dir(export.directory.join("files"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn source_selection_carries_used_reference_definitions_without_exporting_unselected_content() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .import_attachment_bytes("a", "selected.txt", b"selected bytes", |_, _| true)
        .unwrap();
    let uri = workspace.attachment_uri(&file.id).unwrap();
    let context = format!(
        "Private unselected prose\n\nRead [chosen][file].\n\n[file]: {uri} \"custom title\"\n\n[unselected]: https://example.com/private"
    );
    let export = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Selection {
                body: "Read [chosen][file].".into(),
                context,
            },
            dir.path(),
        )
        .unwrap();
    assert_eq!(export.status, ticketd_core::ExportStatus::Complete);
    assert_eq!(export.attachments.len(), 1);
    let output = std::fs::read_to_string(export.directory.join("content.md")).unwrap();
    assert!(output.contains("Read [chosen][file]."));
    assert!(output.contains("\"custom title\""));
    assert!(!output.contains("ticketd://"));
    assert!(!output.contains("Private unselected prose"));
    assert!(!output.contains("example.com/private"));
}
