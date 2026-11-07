use std::{
    io::{Read, Write},
    sync::Mutex,
};
use ticketd_core::{Workspace, drive::*};

const CONNECTION: &str = "81aa7bfb-05c3-4934-a4e7-5c84e2cb83ec";
const DIGEST: &str = "52c3935626c104b2cbc9031291a1c4d56614c38f52072a361d658a58a9c48698";

struct Existing;
impl AttachmentProvider for Existing {
    fn metadata(&self, id: &str, _: Option<&str>) -> Result<DriveMetadata, DriveError> {
        Ok(DriveMetadata {
            id: id.into(),
            name: "Current plan".into(),
            mime_type: "application/vnd.google-apps.document".into(),
            size_bytes: None,
            web_url: format!("https://docs.google.com/document/d/{id}/edit"),
            resource_key: None,
        })
    }
}

#[derive(Default)]
struct Provider {
    uploaded: Mutex<Option<DriveUploadedFile>>,
}
#[allow(clippy::unwrap_used)]
impl DriveUploadProvider for Provider {
    fn folder(&self, _: &str, _: Option<&str>) -> Result<DriveFolder, DriveError> {
        Ok(DriveFolder {
            id: "folder".into(),
            name: "Uploads".into(),
            can_add_children: true,
        })
    }
    fn reserve_file_id(&self) -> Result<String, DriveError> {
        Ok("blob".into())
    }
    fn uploaded_file(&self, _: &str) -> Result<Option<DriveUploadedFile>, DriveError> {
        Ok(self.uploaded.lock().unwrap().clone())
    }
    fn upload_blob(
        &self,
        operation: &DriveUploadOperation,
        input: &mut dyn Read,
        _: &mut dyn FnMut(u64, u64) -> bool,
    ) -> Result<(), DriveError> {
        let mut bytes = Vec::new();
        input.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"original bytes");
        *self.uploaded.lock().unwrap() = Some(DriveUploadedFile {
            metadata: DriveMetadata {
                id: "blob".into(),
                name: "trace.log".into(),
                mime_type: "application/octet-stream".into(),
                size_bytes: Some(14),
                web_url: "https://drive.google.com/file/d/blob/view".into(),
                resource_key: None,
            },
            sha256_checksum: Some(DIGEST.into()),
            version: Some("1".into()),
            operation_id: Some(operation.attachment_id.clone()),
            parent_ids: vec!["folder".into()],
        });
        Ok(())
    }
}
#[allow(clippy::unwrap_used)]
impl DriveCopyProvider for Provider {
    fn inspect(&self, _: &DriveReference) -> Result<DriveCopyMetadata, DriveError> {
        let file = self.uploaded.lock().unwrap().clone().unwrap();
        Ok(DriveCopyMetadata {
            metadata: file.metadata,
            sha256_checksum: file.sha256_checksum,
            version: file.version,
            can_download: Some(true),
        })
    }
    fn download(
        &self,
        _: &DriveReference,
        _: u64,
        output: &mut dyn Write,
    ) -> Result<(), DriveError> {
        output.write_all(b"original bytes").unwrap();
        Ok(())
    }
}
#[allow(clippy::unwrap_used)] // Controlled upload fixture; setup failure must fail the test.
fn upload(w: &mut Workspace, p: &Provider) -> ticketd_core::Attachment {
    w.upload_drive_bytes(
        "upload",
        "trace.log",
        b"original bytes",
        &DriveUploadDestination {
            connection_id: CONNECTION.into(),
            folder_id: "folder".into(),
            resource_key: None,
        },
        p,
        |_, _| true,
    )
    .unwrap()
}

#[test]
fn uploaded_copy_inspection_detects_external_changes_without_overwriting_provenance_or_names() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let p = Provider::default();
    let file = upload(&mut w, &p);
    let preview = w
        .attachment_preview(&w.attachment_workspace_id().unwrap(), &file.id)
        .unwrap();
    assert_eq!(
        serde_json::to_value(preview).unwrap()["uploaded_copy"],
        true
    );
    w.rename_attachment(&file.id, "Authored display name")
        .unwrap();
    let original = w.drive_uploaded_copy(&file.id).unwrap();
    assert_eq!(
        w.inspect_drive_uploaded_copy(&file.id, &p)
            .unwrap()
            .unwrap()
            .status,
        DriveCopyStatus::Unchanged
    );
    {
        let mut changed = p.uploaded.lock().unwrap();
        let changed = changed.as_mut().unwrap();
        changed.version = Some("2".into());
        changed.metadata.name = "Changed remotely".into();
    }
    let inspection = w
        .inspect_drive_uploaded_copy(&file.id, &p)
        .unwrap()
        .unwrap();
    assert_eq!(inspection.status, DriveCopyStatus::Changed);
    assert_eq!(inspection.last_known.name, "trace.log");
    assert_eq!(w.drive_uploaded_copy(&file.id).unwrap(), original);
    assert_eq!(
        w.attachment(&file.id).unwrap().display_name,
        "Authored display name"
    );
}

#[test]
fn portable_export_downloads_only_proven_original_bytes_and_keeps_authored_content() {
    use ticketd_core::{ExportStatus, MarkdownExportSource};
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let p = Provider::default();
    let file = upload(&mut w, &p);
    let body = format!(
        "Use [my literal label]({}).",
        w.attachment_uri(&file.id).unwrap()
    );
    let document = w.create_document(Some("Context"), &body).unwrap();
    let result = w
        .export_markdown_with_files_with_drive(
            MarkdownExportSource::Document {
                id: document.id.clone(),
            },
            dir.path(),
            &p,
        )
        .unwrap();
    assert_eq!(result.status, ExportStatus::Complete);
    let entry = &result.attachments[0];
    assert_eq!(
        entry.kind,
        Some(ticketd_core::ExportAttachmentKind::UploadedCopy)
    );
    assert_eq!(
        std::fs::read(result.directory.join(entry.path.as_ref().unwrap())).unwrap(),
        b"original bytes"
    );
    assert!(entry.omission.is_none());
    assert_eq!(w.show_document(&document.id).unwrap().body, body);
    assert!(
        std::fs::read_to_string(result.directory.join("content.md"))
            .unwrap()
            .starts_with("Use [my literal label](files/")
    );
}

struct Scenario<'a> {
    provider: &'a Provider,
    mode: &'a str,
    inspected: std::cell::Cell<usize>,
    database: std::path::PathBuf,
}
#[allow(clippy::unwrap_used)]
impl DriveCopyProvider for Scenario<'_> {
    fn inspect(&self, r: &DriveReference) -> Result<DriveCopyMetadata, DriveError> {
        self.inspected.set(self.inspected.get() + 1);
        if self.mode == "offline" {
            return Err(DriveError::new(
                DriveErrorKind::Offline,
                "Drive offline; retry",
            ));
        }
        let mut current = self.provider.inspect(r)?;
        match self.mode {
            "changed" => current.sha256_checksum = Some("0".repeat(64)),
            "missing-checksum" => current.sha256_checksum = None,
            "missing-version" => current.version = None,
            "unsupported" => current.can_download = Some(false),
            "race" if self.inspected.get() > 1 => current.version = Some("2".into()),
            _ => {}
        }
        Ok(current)
    }
    fn download(
        &self,
        _: &DriveReference,
        _: u64,
        output: &mut dyn Write,
    ) -> Result<(), DriveError> {
        // A provider wait must leave both SQLite and attachment operations usable.
        let mut other = Workspace::open(&self.database).unwrap();
        other
            .create_ticket("Concurrent write during download")
            .unwrap();
        other
            .import_attachment_bytes("concurrent", "proof.txt", b"safe", |_, _| true)
            .unwrap();
        if self.mode == "download-offline" {
            output.write_all(b"partial").unwrap();
            return Err(DriveError::new(
                DriveErrorKind::Offline,
                "Interrupted download; retry",
            ));
        }
        let bytes = if self.mode == "bytes-changed" {
            &b"modified bytes"[..]
        } else {
            &b"original bytes"[..]
        };
        output.write_all(bytes).unwrap();
        Ok(())
    }
}

#[test]
fn mixed_exports_report_typed_omissions_and_remove_unverified_downloads_including_races() {
    use ticketd_core::{ExportStatus, MarkdownExportSource};
    for (mode, status) in [
        ("changed", "changed"),
        ("missing-checksum", "unknown"),
        ("missing-version", "unknown"),
        ("unsupported", "unsupported"),
        ("offline", "unavailable"),
        ("download-offline", "unavailable"),
        ("bytes-changed", "changed"),
        ("race", "changed"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("workspace.sqlite3");
        let mut w = Workspace::open(&database).unwrap();
        let p = Provider::default();
        let file = upload(&mut w, &p);
        let local = w
            .import_attachment_bytes("local", "trace.log", b"immutable local", |_, _| true)
            .unwrap();
        let remote_uri = w.attachment_uri(&file.id).unwrap();
        let native = w
            .reference_drive_file(CONNECTION, "doc", None, &Existing)
            .unwrap();
        let body = format!(
            "[Uploaded words]({remote_uri}) and [Again]({remote_uri}) and [Local]({}) and [My plan]({})",
            w.attachment_uri(&local.id).unwrap(),
            w.attachment_uri(&native.id).unwrap()
        );
        let original = w.drive_uploaded_copy(&file.id).unwrap();
        let provider = Scenario {
            provider: &p,
            mode,
            inspected: std::cell::Cell::new(0),
            database,
        };
        let export = w
            .export_markdown_with_files_with_drive(
                MarkdownExportSource::Markdown { body: body.clone() },
                dir.path(),
                &provider,
            )
            .unwrap();
        assert_eq!(export.status, ExportStatus::Partial, "{mode}");
        let json = serde_json::to_value(&export).unwrap();
        let omitted = json["attachments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["attachment_id"] == file.id)
            .unwrap();
        assert_eq!(omitted["copy_status"], status, "{mode}");
        assert!(omitted["omission"].as_str().is_some(), "{mode}");
        assert!(omitted["path"].is_null());
        let native_entry = export
            .attachments
            .iter()
            .find(|e| e.attachment_id.as_deref() == Some(native.id.as_str()))
            .unwrap();
        assert_eq!(
            native_entry.external_url.as_deref(),
            Some("https://docs.google.com/document/d/doc/edit")
        );
        assert!(native_entry.omission.is_none());
        assert_eq!(
            std::fs::read_dir(export.directory.join("files"))
                .unwrap()
                .count(),
            1,
            "{mode}"
        );
        assert!(
            std::fs::read_to_string(export.directory.join("content.md"))
                .unwrap()
                .contains("[Uploaded words](ticketd://")
        );
        assert_eq!(w.drive_uploaded_copy(&file.id).unwrap(), original);
    }
}

#[test]
fn single_copy_export_is_explicit_verified_and_never_replaces_existing_output() {
    let dir = tempfile::tempdir().unwrap();
    let database = dir.path().join("workspace.sqlite3");
    let mut w = Workspace::open(&database).unwrap();
    let p = Provider::default();
    let file = upload(&mut w, &p);
    let output = dir.path().join("export.log");
    let result = w.export_drive_uploaded_copy(&file.id, &output, &p).unwrap();
    assert_eq!(result.status, DriveCopyStatus::Unchanged);
    assert_eq!(std::fs::read(&output).unwrap(), b"original bytes");
    assert!(w.export_drive_uploaded_copy(&file.id, &output, &p).is_err());
    let changed = Scenario {
        provider: &p,
        mode: "changed",
        inspected: std::cell::Cell::new(0),
        database,
    };
    let refused = dir.path().join("changed.log");
    assert_eq!(
        w.export_drive_uploaded_copy(&file.id, &refused, &changed)
            .unwrap()
            .status,
        DriveCopyStatus::Changed
    );
    assert!(!refused.exists());
}
