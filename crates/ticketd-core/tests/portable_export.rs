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
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(export.directory.join("manifest.json")).unwrap())
            .unwrap();
    assert_eq!(
        manifest["directory"], ".",
        "the manifest must remain usable when the bundle moves"
    );
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
    assert_eq!(
        workspace.ticket_export_markdown(&ticket.reference).unwrap(),
        format!(
            "# {} · Share evidence\n\nSee [inline]({a_uri}).",
            ticket.reference
        )
    );
    let export = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Ticket {
                reference: ticket.reference.clone(),
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

#[test]
fn portable_filename_bounds_preserve_the_original_file_extension() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let name = format!("{}.pdf", "long-report-".repeat(12));
    let file = workspace
        .import_attachment_bytes("a", &name, b"sample", |_, _| true)
        .unwrap();
    let export = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Markdown {
                body: format!(
                    "[Long report]({})",
                    workspace.attachment_uri(&file.id).unwrap()
                ),
            },
            dir.path(),
        )
        .unwrap();
    let path = export.attachments[0].path.as_ref().unwrap();
    assert_eq!(std::path::Path::new(path).extension().unwrap(), "pdf");
    assert_eq!(
        std::fs::read(export.directory.join(path)).unwrap(),
        b"sample"
    );
}

#[test]
fn plain_ticket_titles_and_attachment_names_do_not_introduce_markdown_links_or_html() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let direct = workspace
        .import_attachment_bytes("direct", "trace.log", b"requested", |_, _| true)
        .unwrap();
    let other = workspace
        .import_attachment_bytes("other", "private.log", b"not requested", |_, _| true)
        .unwrap();
    let title = format!(
        "Literal [example]({}) <em>title</em>",
        workspace.attachment_uri(&other.id).unwrap()
    );
    let name = "<script>literal</script> [name] `ticks`";
    workspace.rename_attachment(&direct.id, name).unwrap();
    let ticket = workspace.create_ticket(&title).unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &direct.id, true)
        .unwrap();
    let export = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Ticket {
                reference: ticket.reference.clone(),
            },
            dir.path(),
        )
        .unwrap();
    assert_eq!(
        export.attachments.len(),
        1,
        "a plain title is not an authored attachment reference"
    );
    let output = std::fs::read_to_string(export.directory.join("content.md")).unwrap();
    let events: Vec<_> = pulldown_cmark::Parser::new(&output).collect();
    assert!(!events.iter().any(|e| matches!(
        e,
        pulldown_cmark::Event::Html(_) | pulldown_cmark::Event::InlineHtml(_)
    )));
    let text: String = events
        .iter()
        .filter_map(|e| {
            if let pulldown_cmark::Event::Text(text) = e {
                Some(text.as_ref())
            } else {
                None
            }
        })
        .collect();
    assert!(text.contains(&title), "{text}");
    assert!(text.contains(name), "{text}");
    std::fs::remove_file(
        dir.path()
            .join("workspace.sqlite3.attachments")
            .join(&direct.locator),
    )
    .unwrap();
    let missing = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Ticket {
                reference: ticket.reference,
            },
            dir.path(),
        )
        .unwrap();
    assert_eq!(missing.status, ticketd_core::ExportStatus::Partial);
    assert_eq!(missing.attachments.len(), 1);
    let output = std::fs::read_to_string(missing.directory.join("content.md")).unwrap();
    assert!(!pulldown_cmark::Parser::new(&output).any(|e| matches!(
        e,
        pulldown_cmark::Event::Html(_) | pulldown_cmark::Event::InlineHtml(_)
    )));
    assert_eq!(missing.attachments[0].display_name, name);
}

#[test]
fn document_title_and_original_filename_remain_data_while_authored_markdown_stays_authored() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let original = "report [literal] `ticks`.log";
    let file = workspace
        .import_attachment_bytes("file", original, b"requested", |_, _| true)
        .unwrap();
    let other = workspace
        .import_attachment_bytes("other", "private.log", b"not requested", |_, _| true)
        .unwrap();
    let title = format!(
        "Plain [title]({}) <b>example</b>",
        workspace.attachment_uri(&other.id).unwrap()
    );
    let authored = format!(
        "Keep [**authored label**]({}) and `literal code`.",
        workspace.attachment_uri(&file.id).unwrap()
    );
    let document = workspace.create_document(Some(&title), &authored).unwrap();
    let export = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Document {
                id: document.id.clone(),
            },
            dir.path(),
        )
        .unwrap();
    assert_eq!(export.attachments.len(), 1);
    assert_eq!(
        export.attachments[0].original_filename.as_deref(),
        Some(original)
    );
    let output = std::fs::read_to_string(export.directory.join("content.md")).unwrap();
    assert!(output.contains("[**authored label**]"));
    assert!(output.contains("`literal code`"));
    assert!(
        !output.contains(&title),
        "Document export copies its canonical body, not its separate plain title"
    );
    assert_eq!(
        workspace.show_document(&document.id).unwrap().body,
        authored
    );
    let ticket = workspace.create_ticket("Original filename").unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    let direct = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Ticket {
                reference: ticket.reference,
            },
            dir.path(),
        )
        .unwrap();
    let output = std::fs::read_to_string(direct.directory.join("content.md")).unwrap();
    let text: String = pulldown_cmark::Parser::new(&output)
        .filter_map(|e| {
            if let pulldown_cmark::Event::Text(text) = e {
                Some(text.into_string())
            } else {
                None
            }
        })
        .collect();
    assert!(text.contains(original), "{text}");
    assert_eq!(
        std::fs::read(
            direct
                .directory
                .join(direct.attachments[0].path.as_ref().unwrap())
        )
        .unwrap(),
        b"requested"
    );
}

struct ViewerUrlFile;
impl ticketd_core::drive::AttachmentProvider for ViewerUrlFile {
    fn metadata(
        &self,
        id: &str,
        key: Option<&str>,
    ) -> Result<ticketd_core::drive::DriveMetadata, ticketd_core::drive::DriveError> {
        let mut metadata = ticketd_core::drive::AttachmentProvider::metadata(&NativeFile, id, key)?;
        metadata.web_url = "https://docs.google.com/document/d/native/edit?hint=)attack".into();
        Ok(metadata)
    }
}

#[test]
fn provider_viewer_url_remains_one_usable_destination_when_it_contains_markdown_punctuation() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .reference_drive_file(
            &uuid::Uuid::new_v4().to_string(),
            "native",
            None,
            &ViewerUrlFile,
        )
        .unwrap();
    let export = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Markdown {
                body: format!(
                    "Read [my plan]({})",
                    workspace.attachment_uri(&file.id).unwrap()
                ),
            },
            dir.path(),
        )
        .unwrap();
    let output = std::fs::read_to_string(export.directory.join("content.md")).unwrap();
    let destinations: Vec<_> = pulldown_cmark::Parser::new(&output)
        .filter_map(|event| {
            if let pulldown_cmark::Event::Start(pulldown_cmark::Tag::Link { dest_url, .. }) = event
            {
                Some(dest_url.into_string())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        destinations,
        ["https://docs.google.com/document/d/native/edit?hint=%29attack"]
    );
}

#[test]
fn a_documents_summary_leads_its_markdown_export_after_the_heading() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let export = |workspace: &Workspace, id: &str| {
        let bundle = workspace
            .export_markdown_with_files(
                MarkdownExportSource::Document { id: id.into() },
                dir.path(),
            )
            .unwrap();
        std::fs::read_to_string(bundle.directory.join("content.md")).unwrap()
    };
    let headed = workspace
        .create_document_with_summary(None, Some("Shipped in a1b2c3d."), "# Report\n\nBody.")
        .unwrap();
    assert_eq!(
        export(&workspace, &headed.id),
        "# Report\n\nShipped in a1b2c3d.\n\nBody."
    );
    let bare = workspace
        .create_document_with_summary(None, Some("Done."), "Body only.")
        .unwrap();
    assert_eq!(export(&workspace, &bare.id), "Done.\n\nBody only.");
    let none = workspace.create_document(None, "# Plain\n\nBody.").unwrap();
    assert_eq!(export(&workspace, &none.id), "# Plain\n\nBody.");
}
