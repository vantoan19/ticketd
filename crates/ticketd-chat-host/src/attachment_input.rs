use std::io::{self, Write};
use std::path::{Path, PathBuf};

use ticketd_core::ChatAttachmentContent;

/// Readable handoff copies. The adapter holds this through its harness's use of
/// the paths. A new attempt can make fresh copies from the saved Chat snapshots.
pub(crate) struct AttachmentFiles(tempfile::TempDir);

impl AttachmentFiles {
    pub(crate) fn new() -> io::Result<Self> {
        let temp = std::path::absolute(std::env::temp_dir())?;
        Ok(Self(
            tempfile::Builder::new()
                .prefix("ticketd-chat-")
                .tempdir_in(temp)?,
        ))
    }

    pub(crate) fn materialize(&self, attachment: &ChatAttachmentContent) -> io::Result<PathBuf> {
        // Generate the filename so a supplied name cannot address a device, path
        // or another file. A simple extension still helps readers recognize its type.
        let extension = Path::new(attachment.name())
            .extension()
            .and_then(|extension| extension.to_str())
            .filter(|extension| {
                extension.len() <= 16 && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
            });
        let suffix = extension
            .map(|extension| format!(".{extension}"))
            .unwrap_or_default();
        let mut file = tempfile::Builder::new()
            .prefix("attachment-")
            .suffix(&suffix)
            .tempfile_in(self.0.path())?;
        file.write_all(attachment.bytes())?;
        let (_, path) = file.keep().map_err(|error| error.error)?;
        Ok(path)
    }
}
