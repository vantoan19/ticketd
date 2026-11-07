use ticketd_core::{
    AttachmentKind, ExportStatus, MarkdownExportSource, Workspace,
    drive::{AttachmentProvider, DriveError, DriveMetadata},
};

struct NativeFile;
impl AttachmentProvider for NativeFile {
    fn metadata(&self, id: &str, _: Option<&str>) -> Result<DriveMetadata, DriveError> {
        let (name, mime, path) = match id {
            "doc" => ("Current plan", "document", "document"),
            "sheet" => ("Budget", "spreadsheet", "spreadsheets"),
            "slides" => ("Review", "presentation", "presentation"),
            _ => unreachable!("fixture file"),
        };
        Ok(DriveMetadata {
            id: id.into(),
            name: name.into(),
            mime_type: format!("application/vnd.google-apps.{mime}"),
            size_bytes: None,
            web_url: format!("https://docs.google.com/{path}/d/{id}/edit"),
            resource_key: Some("retained-resource-key".into()),
        })
    }
}

#[test]
fn mixed_export_keeps_native_files_as_named_current_source_links_and_copies_local_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let local = workspace
        .import_attachment_bytes("local", "trace.log", b"original bytes", |_, _| true)
        .unwrap();
    let ticket = workspace.create_ticket("Share context").unwrap();
    workspace
        .set_ticket_attachment(&ticket.reference, &local.id, true)
        .unwrap();
    let connection = uuid::Uuid::new_v4().to_string();
    for id in ["doc", "sheet", "slides"] {
        let file = workspace
            .reference_drive_file(&connection, id, None, &NativeFile)
            .unwrap();
        workspace
            .set_ticket_attachment(&ticket.reference, &file.id, true)
            .unwrap();
    }
    let result = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Ticket {
                reference: ticket.reference,
            },
            dir.path(),
        )
        .unwrap();
    assert_eq!(result.status, ExportStatus::Complete);
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(result.directory.join("manifest.json")).unwrap())
            .unwrap();
    let entries = manifest["attachments"].as_array().unwrap();
    let local_entry = entries
        .iter()
        .find(|entry| entry["attachment_id"] == local.id)
        .unwrap();
    assert_eq!(local_entry["kind"], "local_snapshot");
    assert_eq!(
        std::fs::read(result.directory.join(local_entry["path"].as_str().unwrap())).unwrap(),
        b"original bytes"
    );
    let body = std::fs::read_to_string(result.directory.join("content.md")).unwrap();
    for (name, url) in [
        (
            "Current plan",
            "https://docs.google.com/document/d/doc/edit",
        ),
        (
            "Budget",
            "https://docs.google.com/spreadsheets/d/sheet/edit",
        ),
        (
            "Review",
            "https://docs.google.com/presentation/d/slides/edit",
        ),
    ] {
        let entry = entries
            .iter()
            .find(|entry| entry["display_name"] == name)
            .unwrap();
        assert_eq!(entry["kind"], "external_reference");
        assert_eq!(entry["external_url"], url);
        assert!(entry["path"].is_null());
        assert!(entry["omission"].is_null());
        assert!(body.contains(&format!("[{name}]({url})")), "{body}");
    }
    assert_eq!(
        std::fs::read_dir(result.directory.join("files"))
            .unwrap()
            .count(),
        1
    );
    assert!(!manifest.to_string().contains(&connection));
    assert_eq!(
        workspace.attachment(&local.id).unwrap().kind,
        AttachmentKind::LocalSnapshot
    );
}

#[test]
fn mixed_backup_restores_last_known_references_without_promising_remote_bytes_or_access() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let local = workspace
        .import_attachment_bytes("local", "trace.log", b"retained", |_, _| true)
        .unwrap();
    let remote = workspace
        .reference_drive_file(&uuid::Uuid::new_v4().to_string(), "doc", None, &NativeFile)
        .unwrap();
    let reference = workspace.drive_reference(&remote.id).unwrap();
    let uri = workspace.attachment_uri(&remote.id).unwrap();
    let document = workspace
        .create_document(Some("Context"), &format!("See [my plan]({uri})."))
        .unwrap();
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let inspection = workspace.inspect_backup(&backup).unwrap();
    let content = serde_json::to_value(inspection.attachment_content.unwrap()).unwrap();
    assert_eq!(content["local_snapshots"], 1);
    assert_eq!(content["retained_files"], 1);
    assert_eq!(content["retained_bytes"], 8);
    assert_eq!(content["remote_references"], 1);
    assert_eq!(content["remote_bytes_included"], false);
    assert_eq!(content["remote_access_verified"], false);
    let restored_path = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored_path, &backup).unwrap();
    let restored = Workspace::open(restored_path).unwrap();
    assert_eq!(restored.resolve_attachment_uri(&uri).unwrap(), remote);
    assert_eq!(restored.drive_reference(&remote.id).unwrap(), reference);
    assert_eq!(restored.show_document(&document.id).unwrap(), document);
    let bytes = dir.path().join("restored.log");
    restored.export_attachment(&local.id, &bytes).unwrap();
    assert_eq!(std::fs::read(bytes).unwrap(), b"retained");
    assert!(
        restored
            .export_attachment(&remote.id, dir.path().join("plan.docx"))
            .is_err()
    );

    // Remote references must not relax the retained local-file requirement.
    let damaged = dir.path().join("damaged.sqlite3");
    std::fs::copy(&backup, &damaged).unwrap();
    rusqlite::Connection::open(&damaged)
        .unwrap()
        .execute(
            "DELETE FROM ticketd_backup_files WHERE path NOT LIKE '%/.ticketd-upload.json'",
            [],
        )
        .unwrap();
    assert!(matches!(
        workspace.inspect_backup(&damaged).unwrap().check,
        ticketd_core::BackupCheck::Damaged { .. }
    ));
    assert!(Workspace::restore(dir.path().join("refused.sqlite3"), &damaged).is_err());
}

#[test]
fn generated_native_autolink_labels_use_readable_names_without_rewriting_authored_labels() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let remote = workspace
        .reference_drive_file(&uuid::Uuid::new_v4().to_string(), "doc", None, &NativeFile)
        .unwrap();
    workspace
        .rename_attachment(&remote.id, "Plan [review] <v2>")
        .unwrap();
    let uri = workspace.attachment_uri(&remote.id).unwrap();
    let result = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Markdown {
                body: format!("<{uri}> and [my words]({uri})"),
            },
            dir.path(),
        )
        .unwrap();
    let body = std::fs::read_to_string(result.directory.join("content.md")).unwrap();
    assert_eq!(
        body,
        r"[Plan \[review\] \<v2\>](https://docs.google.com/document/d/doc/edit) and [my words](https://docs.google.com/document/d/doc/edit)"
    );
}

#[test]
fn provider_links_cannot_persist_temporary_authorization_in_workspace_or_portable_outputs() {
    struct Link(String);
    impl AttachmentProvider for Link {
        fn metadata(&self, id: &str, key: Option<&str>) -> Result<DriveMetadata, DriveError> {
            let mut metadata = NativeFile.metadata(id, key)?;
            metadata.web_url.clone_from(&self.0);
            Ok(metadata)
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let connection = uuid::Uuid::new_v4().to_string();
    for suffix in [
        "?access%5Ftoken=temporary-secret",
        "#code=temporary-secret",
        "?refresh_token=temporary-secret",
        "?client_secret=temporary-secret",
    ] {
        let error = workspace
            .reference_drive_file(
                &connection,
                "doc",
                None,
                &Link(format!(
                    "https://docs.google.com/document/d/doc/edit{suffix}"
                )),
            )
            .unwrap_err();
        assert!(!error.to_string().contains("temporary-secret"));
    }
    assert!(workspace.attachments(10, 0).unwrap().is_empty());
    let url = "https://docs.google.com/document/d/doc/edit?resourcekey=retained-key&authuser=1&usp=sharing#heading=h.abc";
    let file = workspace
        .reference_drive_file(&connection, "doc", None, &Link(url.into()))
        .unwrap();
    let result = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Markdown {
                body: format!(
                    "[Plan]({0})\n\n<a href=\"{0}\">HTML label</a>",
                    workspace.attachment_uri(&file.id).unwrap()
                ),
            },
            dir.path(),
        )
        .unwrap();
    assert_eq!(result.attachments[0].external_url.as_deref(), Some(url));
    let body = std::fs::read_to_string(result.directory.join("content.md")).unwrap();
    assert!(
        body.contains(&format!(
            "<a href=\"{}\">HTML label</a>",
            url.replace('&', "&amp;")
        )),
        "{body}"
    );
}

#[test]
fn native_files_in_image_syntax_export_as_readable_provider_links_without_conversion() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let remote = workspace
        .reference_drive_file(&uuid::Uuid::new_v4().to_string(), "doc", None, &NativeFile)
        .unwrap();
    let uri = workspace.attachment_uri(&remote.id).unwrap();
    let source = format!("See ![my plan]({uri}) and ![budget][native].\n\n[native]: {uri}");
    let document = workspace.create_document(None, &source).unwrap();
    let result = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Document {
                id: document.id.clone(),
            },
            dir.path(),
        )
        .unwrap();
    let body = std::fs::read_to_string(result.directory.join("content.md")).unwrap();
    assert_eq!(
        body,
        "See [my plan](https://docs.google.com/document/d/doc/edit) and [budget][native].\n\n[native]: https://docs.google.com/document/d/doc/edit"
    );
    assert_eq!(workspace.show_document(&document.id).unwrap().body, source);
}

#[test]
fn html_images_of_drive_files_export_readable_links_while_local_images_remain_images() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let remote = workspace
        .reference_drive_file(&uuid::Uuid::new_v4().to_string(), "doc", None, &NativeFile)
        .unwrap();
    let local = workspace
        .import_attachment_bytes("local", "image.png", b"retained image", |_, _| true)
        .unwrap();
    let remote_uri = workspace.attachment_uri(&remote.id).unwrap();
    let local_uri = workspace.attachment_uri(&local.id).unwrap();
    let source = format!(
        "Before <img alt='my &amp; <readable> plan' src=\"{remote_uri}\"> after.\n\n<div>\n<IMG SRC='{remote_uri}' />\n<img src=\"{local_uri}\" alt=\"local\">\n<span title='<img src=\"{remote_uri}\">'>keep literal</span>\n</div>"
    );
    let document = workspace.create_document(None, &source).unwrap();
    let result = workspace
        .export_markdown_with_files(
            MarkdownExportSource::Document {
                id: document.id.clone(),
            },
            dir.path(),
        )
        .unwrap();
    let body = std::fs::read_to_string(result.directory.join("content.md")).unwrap();
    assert!(body.contains("Before <a href=\"https://docs.google.com/document/d/doc/edit\">my &amp; &lt;readable&gt; plan</a> after."), "{body}");
    assert!(
        body.contains("<a href=\"https://docs.google.com/document/d/doc/edit\">Current plan</a>"),
        "{body}"
    );
    let local_path = result
        .attachments
        .iter()
        .find(|entry| entry.attachment_id.as_deref() == Some(local.id.as_str()))
        .unwrap()
        .path
        .as_deref()
        .unwrap();
    assert!(
        body.contains(&format!("<img src=\"{local_path}\" alt=\"local\">")),
        "{body}"
    );
    assert!(body.contains("<span title='<img src=\"https://docs.google.com/document/d/doc/edit\">'>keep literal</span>"), "{body}");
    assert_eq!(workspace.show_document(&document.id).unwrap().body, source);
}

#[test]
fn uploaded_copies_keep_provenance_after_restore_and_are_partial_until_bytes_are_verified() {
    use ticketd_core::drive::{
        DriveFolder, DriveUploadDestination, DriveUploadOperation, DriveUploadProvider,
        DriveUploadedFile,
    };
    #[derive(Default)]
    struct Upload(std::sync::Mutex<Option<DriveUploadedFile>>);
    #[allow(clippy::unwrap_used)] // Deterministic external upload fixture.
    impl DriveUploadProvider for Upload {
        fn folder(&self, id: &str, _: Option<&str>) -> Result<DriveFolder, DriveError> {
            Ok(DriveFolder {
                id: id.into(),
                name: "Uploads".into(),
                can_add_children: true,
            })
        }
        fn reserve_file_id(&self) -> Result<String, DriveError> {
            Ok("uploaded-file".into())
        }
        fn uploaded_file(&self, _: &str) -> Result<Option<DriveUploadedFile>, DriveError> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn upload_blob(
            &self,
            operation: &DriveUploadOperation,
            input: &mut dyn std::io::Read,
            _: &mut dyn FnMut(u64, u64) -> bool,
        ) -> Result<(), DriveError> {
            let mut bytes = Vec::new();
            input.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, b"original bytes");
            *self.0.lock().unwrap() = Some(DriveUploadedFile {
                metadata: DriveMetadata {
                    id: "uploaded-file".into(),
                    name: "upload.log".into(),
                    mime_type: "text/plain".into(),
                    size_bytes: Some(14),
                    web_url: "https://drive.google.com/file/d/uploaded-file/view".into(),
                    resource_key: None,
                },
                sha256_checksum: Some(
                    "52c3935626c104b2cbc9031291a1c4d56614c38f52072a361d658a58a9c48698".into(),
                ),
                version: Some("1".into()),
                operation_id: Some(operation.attachment_id.clone()),
                parent_ids: vec!["folder".into()],
            });
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let connection = uuid::Uuid::new_v4().to_string();
    let uploaded = workspace
        .upload_drive_bytes(
            "upload",
            "upload.log",
            b"original bytes",
            &DriveUploadDestination {
                connection_id: connection.clone(),
                folder_id: "folder".into(),
                resource_key: None,
            },
            &Upload::default(),
            |_, _| true,
        )
        .unwrap();
    let native = workspace
        .reference_drive_file(&connection, "doc", None, &NativeFile)
        .unwrap();
    let uri = workspace.attachment_uri(&uploaded.id).unwrap();
    let upper = uri.replacen("ticketd", "TICKETD", 1);
    let body = format!(
        "[Copy]({uri}) and [again]({upper}) and [Current plan]({})",
        workspace.attachment_uri(&native.id).unwrap()
    );
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let restored_path = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored_path, &backup).unwrap();
    let restored = Workspace::open(restored_path).unwrap();
    assert_eq!(
        restored.drive_uploaded_copy(&uploaded.id).unwrap(),
        workspace.drive_uploaded_copy(&uploaded.id).unwrap()
    );
    let result = restored
        .export_markdown_with_files(MarkdownExportSource::Markdown { body }, dir.path())
        .unwrap();
    assert_eq!(result.status, ExportStatus::Partial);
    let json = serde_json::to_value(&result).unwrap();
    let copies: Vec<_> = json["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["attachment_id"] == uploaded.id)
        .collect();
    assert_eq!(copies.len(), 2);
    for entry in copies {
        assert_eq!(entry["kind"], "uploaded_copy");
        assert!(entry["omission"].as_str().unwrap().contains("verified"));
        assert!(entry["external_url"].is_null());
        assert!(entry["path"].is_null());
    }
    let entry = result
        .attachments
        .iter()
        .find(|entry| entry.attachment_id.as_deref() == Some(native.id.as_str()))
        .unwrap();
    assert!(entry.external_url.is_some());
    assert!(entry.omission.is_none());
    assert_eq!(
        std::fs::read_dir(result.directory.join("files"))
            .unwrap()
            .count(),
        0
    );
}
