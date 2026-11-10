use super::{DriveError, DriveErrorKind, DriveMetadata, DriveReference, DriveUploadOperation};
use crate::{Error, Workspace};
use serde::{Deserialize, Serialize};
use std::io::Write;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveCopyMetadata {
    pub metadata: DriveMetadata,
    pub sha256_checksum: Option<String>,
    pub version: Option<String>,
    pub can_download: Option<bool>,
}

/// Read-only blob inspection/download. No conversion, revision pinning or mutation.
pub trait DriveCopyProvider {
    fn inspect(&self, reference: &DriveReference) -> Result<DriveCopyMetadata, DriveError>;
    fn download(
        &self,
        reference: &DriveReference,
        size: u64,
        output: &mut dyn Write,
    ) -> Result<(), DriveError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriveCopyStatus {
    Unchanged,
    Changed,
    Unknown,
    Unsupported,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveCopyInspection {
    pub status: DriveCopyStatus,
    pub message: String,
    pub last_known: DriveMetadata,
    pub current: Option<DriveCopyMetadata>,
    pub error_kind: Option<DriveErrorKind>,
}

impl Workspace {
    /// Explicit byte export only; staging is deleted on failed comparison and never cached.
    pub fn export_drive_uploaded_copy(
        &self,
        id: &str,
        destination: impl AsRef<std::path::Path>,
        provider: &dyn DriveCopyProvider,
    ) -> Result<DriveCopyInspection, Error> {
        let destination = destination.as_ref();
        if destination.try_exists()? {
            return Err(Error::FileExists(destination.to_owned()));
        }
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(std::path::Path::new("."));
        let operation=self.drive_uploaded_copy(id)?.ok_or_else(||Error::Attachment("This attachment is not an uploaded copy; existing Drive references export as current-source links.".into()))?;
        let reference = self.drive_reference(id)?;
        let stage = tempfile::Builder::new()
            .prefix("ticketd-copy-export-")
            .tempdir_in(parent)?;
        let bytes = stage.path().join("bytes");
        let result = export_copy(&operation, &reference, provider, &bytes)?;
        if result.status == DriveCopyStatus::Unchanged {
            tempfile::TempPath::try_from_path(bytes)?
                .persist_noclobber(destination)
                .map_err(|e| match e.error.kind() {
                    std::io::ErrorKind::AlreadyExists => Error::FileExists(destination.into()),
                    _ => Error::from(e.error),
                })?;
            crate::attachments::sync_directory(parent)?;
        }
        Ok(result)
    }

    /// Metadata comparison only; an unchanged observation does not verify downloaded bytes.
    pub fn inspect_drive_uploaded_copy(
        &self,
        id: &str,
        provider: &dyn DriveCopyProvider,
    ) -> Result<Option<DriveCopyInspection>, Error> {
        let Some(operation) = self.drive_uploaded_copy(id)? else {
            return Ok(None);
        };
        let reference = self.drive_reference(id)?;
        Ok(Some(inspect(&operation, &reference, provider)))
    }
}

pub(crate) fn inspect(
    operation: &DriveUploadOperation,
    reference: &DriveReference,
    provider: &dyn DriveCopyProvider,
) -> DriveCopyInspection {
    let mut result = DriveCopyInspection {
        status: DriveCopyStatus::Unknown,
        message: String::new(),
        last_known: reference.metadata.clone(),
        current: None,
        error_kind: None,
    };
    let current = match provider.inspect(reference) {
        Ok(current) => current,
        Err(error) => {
            result.status = if error.kind == DriveErrorKind::Unsupported {
                DriveCopyStatus::Unsupported
            } else {
                DriveCopyStatus::Unavailable
            };
            result.message = error.message;
            result.error_kind = Some(error.kind);
            return result;
        }
    };
    if super::validate_metadata(&reference.metadata.id, &current.metadata).is_err() {
        result.status = DriveCopyStatus::Unavailable;
        result.error_kind = Some(DriveErrorKind::InvalidResponse);
        result.message =
            "Drive returned inconsistent file metadata; retry. Last-known details are preserved."
                .into();
        return result;
    }
    let recorded = operation.provenance.as_ref();
    let version = recorded
        .and_then(|file| file.version.as_deref())
        .filter(|v| !v.is_empty());
    let checksum = current
        .sha256_checksum
        .as_deref()
        .filter(|v| valid_checksum(v));
    let changed = current
        .metadata
        .size_bytes
        .is_some_and(|size| size != operation.request.size_bytes)
        || checksum.is_some_and(|digest| !digest.eq_ignore_ascii_case(&operation.request.sha256));
    // Drive versions include metadata-only changes. Export compares observations
    // around the download and hashes the actual bytes against the original upload.
    (result.status, result.message) = if changed {
        (DriveCopyStatus::Changed,"Drive reports different content from the original upload; this copy cannot be exported as the original upload.".into())
    } else if current
        .metadata
        .mime_type
        .starts_with("application/vnd.google-apps.")
        || current.can_download == Some(false)
    {
        (DriveCopyStatus::Unsupported,"Drive does not support downloading original bytes for this copy. Open in Drive; conversion is not performed.".into())
    } else if checksum.is_none()
        || version.is_none()
        || current.version.as_deref().is_none_or(str::is_empty)
        || current.metadata.size_bytes.is_none()
        || current.can_download.is_none()
    {
        (DriveCopyStatus::Unknown,"Original-upload comparison is unknown: Drive checksum, version, size or download capability is unavailable. Retry or inspect the current file in Drive.".into())
    } else {
        (DriveCopyStatus::Unchanged,"Drive reports the same checksum and size as the recorded upload. Export downloads and verifies the actual bytes again.".into())
    };
    result.current = Some(current);
    result
}

fn valid_checksum(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn export_copy(
    operation: &DriveUploadOperation,
    reference: &DriveReference,
    provider: &dyn DriveCopyProvider,
    path: &std::path::Path,
) -> Result<DriveCopyInspection, Error> {
    use sha2::{Digest, Sha256};
    let before = inspect(operation, reference, provider);
    if before.status != DriveCopyStatus::Unchanged {
        return Ok(before);
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    struct CheckedWriter<'a> {
        file: &'a mut std::fs::File,
        hash: Sha256,
        count: u64,
        limit: u64,
    }
    impl Write for CheckedWriter<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() as u64 > self.limit.saturating_sub(self.count) {
                return Err(std::io::Error::other(
                    "download exceeds recorded upload size",
                ));
            }
            let count = self.file.write(bytes)?;
            self.hash.update(&bytes[..count]);
            self.count += count as u64;
            Ok(count)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.file.flush()
        }
    }
    let mut writer = CheckedWriter {
        file: &mut file,
        hash: Sha256::new(),
        count: 0,
        limit: operation.request.size_bytes,
    };
    let downloaded = provider.download(reference, operation.request.size_bytes, &mut writer);
    let matches = writer.count == operation.request.size_bytes
        && format!("{:x}", writer.hash.finalize()) == operation.request.sha256;
    let result = match downloaded {
        Err(error) => DriveCopyInspection {
            status: if error.kind == DriveErrorKind::Unsupported {
                DriveCopyStatus::Unsupported
            } else {
                DriveCopyStatus::Unavailable
            },
            message: error.message,
            error_kind: Some(error.kind),
            ..before
        },
        Ok(()) if !matches => DriveCopyInspection {
            status: DriveCopyStatus::Changed,
            message: "Downloaded bytes no longer match the original upload; no bytes were exported. Open in Drive or retry.".into(),
            ..before
        },
        Ok(()) => {
            let after = inspect(operation, reference, provider);
            if after.status == DriveCopyStatus::Unchanged && before.current != after.current {
                DriveCopyInspection {
                    status: DriveCopyStatus::Unknown,
                    message: "Drive metadata changed during export; no original-byte claim can be made. Retry.".into(),
                    ..after
                }
            } else {
                after
            }
        }
    };
    if result.status == DriveCopyStatus::Unchanged {
        file.sync_all()?;
    }
    drop(file);
    if result.status != DriveCopyStatus::Unchanged {
        std::fs::remove_file(path)?;
    }
    Ok(result)
}
