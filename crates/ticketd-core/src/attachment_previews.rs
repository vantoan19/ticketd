use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use rusqlite::OptionalExtension;
use serde::Serialize;
use uuid::Uuid;

use crate::{Attachment, AttachmentKind, Error, Workspace};

/// Independent of a configurable upload limit: WebViews buffer protocol responses.
pub const MAX_PREVIEW_BYTES: u64 = 100 * 1024 * 1024;
/// The most of a plain-text file a preview shows: the start, never the whole file.
pub const TEXT_EXCERPT_BYTES: usize = 64 * 1024;
/// The most of one HTML report the viewer reads whole. It crosses to the WebView as
/// one string, so this stays well under the media limit.
pub const HTML_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;
/// The most of one PDF the viewer reads whole. It crosses to the WebView as one binary
/// IPC response and is parsed in memory there, so this stays well under the media limit.
pub const PDF_PREVIEW_BYTES: u64 = 32 * 1024 * 1024;
/// A PDF's `%PDF-` marker may follow stray bytes, but only within this many.
const PDF_MARKER_WINDOW: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewStatus {
    Available,
    Unsupported,
    Missing,
    Incomplete,
    Unavailable,
    TooLarge,
}

#[derive(Debug, Clone, Serialize)]
pub struct AttachmentPreview {
    pub attachment: Attachment,
    pub uploaded_copy: bool,
    pub status: PreviewStatus,
    pub media_type: Option<String>,
    pub message: Option<String>,
    pub can_open: bool,
    pub usage: PreviewUsage,
    /// The start of a plain-text file that is not media, shown as text.
    pub text_excerpt: Option<TextExcerpt>,
    /// A UTF-8 HTML report small enough to read whole with `attachment_html`. The
    /// viewer shows it read-only in an isolated frame; it is never media.
    pub html: bool,
    /// A stored PDF (by its `%PDF-` header, not its name) small enough to read whole
    /// with `attachment_pdf`. The viewer renders its pages in the WebView; it is never
    /// media.
    pub pdf: bool,
}

/// The first bytes of a UTF-8 text file, cut on a character boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TextExcerpt {
    pub text: String,
    /// The file continues past the excerpt.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewUsage {
    pub total: usize,
    pub entries: Vec<PreviewUse>,
    pub legacy_drafts_pending: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewUse {
    pub kind: String,
    pub owner: String,
    pub label: String,
    pub trashed: bool,
    pub target: Option<PreviewUseTarget>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum PreviewUseTarget {
    Ticket(String),
    Document(String),
}

/// An authorized handle, never a path exposed to the WebView. All reads use this handle.
#[derive(Debug)]
pub struct AttachmentMedia {
    file: File,
    media_type: &'static str,
    length: u64,
}

impl AttachmentMedia {
    pub fn media_type(&self) -> &'static str {
        self.media_type
    }
    pub fn len(&self) -> u64 {
        self.length
    }
    pub fn is_empty(&self) -> bool {
        self.length == 0
    }
    pub fn read(&mut self, start: u64, length: u64) -> Result<Vec<u8>, Error> {
        if length > MAX_PREVIEW_BYTES
            || start
                .checked_add(length)
                .is_none_or(|end| end > self.length)
        {
            return Err(Error::Attachment("invalid media byte range".into()));
        }
        self.file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; length as usize];
        self.file.read_exact(&mut bytes)?;
        Ok(bytes)
    }
}

impl Workspace {
    fn preview_attachment(&self, workspace: &str, id: &str) -> Result<Attachment, Error> {
        if workspace != self.attachment_workspace_id()? || Uuid::parse_str(id).is_err() {
            return Err(Error::Attachment(
                "this attachment identity does not belong to this workspace".into(),
            ));
        }
        crate::attachments::read_attachment(&self.connection, id)
    }

    pub fn attachment_preview(
        &self,
        workspace: &str,
        id: &str,
    ) -> Result<AttachmentPreview, Error> {
        let attachment = self.preview_attachment(workspace, id)?;
        let (mut status, media_type, mut message) = match self.open_media(&attachment) {
            Ok(media) => (
                PreviewStatus::Available,
                Some(media.media_type.into()),
                None,
            ),
            Err(error) => (error.status, None, Some(error.message)),
        };
        let can_open = self.attachment_open_target(id).is_ok();
        let text_excerpt = if status == PreviewStatus::Unsupported
            && attachment.kind == AttachmentKind::LocalSnapshot
        {
            self.text_excerpt(&attachment)
        } else {
            None
        };
        let mut html = false;
        if status == PreviewStatus::Unsupported
            && attachment.kind == AttachmentKind::LocalSnapshot
            && is_html_name(&attachment.original_filename)
        {
            if attachment
                .size_bytes
                .is_some_and(|size| size > HTML_PREVIEW_BYTES)
            {
                status = PreviewStatus::TooLarge;
                message = Some(
                    "This report is larger than the 8 MiB preview limit. Open it in its app."
                        .into(),
                );
            } else {
                html = text_excerpt.is_some();
            }
        }
        let mut pdf = false;
        if status == PreviewStatus::Unsupported
            && !html
            && attachment.kind == AttachmentKind::LocalSnapshot
            && self.is_pdf(&attachment)
        {
            if attachment
                .size_bytes
                .is_some_and(|size| size > PDF_PREVIEW_BYTES)
            {
                status = PreviewStatus::TooLarge;
                message = Some(
                    "This PDF is larger than the 32 MiB preview limit. Open it in its app.".into(),
                );
            } else {
                pdf = true;
            }
        }
        Ok(AttachmentPreview {
            uploaded_copy: self.drive_uploaded_copy(id)?.is_some(),
            attachment,
            status,
            media_type,
            message,
            can_open,
            usage: self.preview_usage(id)?,
            text_excerpt,
            html,
            pdf,
        })
    }

    /// The bytes of a stored PDF, for the viewer to render page by page. It reads through
    /// the checked snapshot (never a path), only a file that starts like a PDF, and only up
    /// to `PDF_PREVIEW_BYTES`.
    pub fn attachment_pdf(&self, workspace: &str, id: &str) -> Result<Vec<u8>, Error> {
        let attachment = self.preview_attachment(workspace, id)?;
        let (_, file) = open_snapshot(&self.connection, &attachment)
            .map_err(|failure| Error::Attachment(failure.message))?;
        if file.metadata()?.len() > PDF_PREVIEW_BYTES {
            return Err(Error::Attachment(
                "This PDF is larger than the 32 MiB preview limit. Open it in its app.".into(),
            ));
        }
        let mut bytes = Vec::new();
        file.take(PDF_PREVIEW_BYTES).read_to_end(&mut bytes)?;
        if !has_pdf_marker(&bytes) {
            return Err(Error::Attachment("This file is not a PDF.".into()));
        }
        Ok(bytes)
    }

    /// Whether a stored local file starts like a PDF. A file that cannot be read is not.
    fn is_pdf(&self, attachment: &Attachment) -> bool {
        let Ok((_, file)) = open_snapshot(&self.connection, attachment) else {
            return false;
        };
        let mut head = Vec::new();
        file.take(PDF_MARKER_WINDOW as u64 + 5)
            .read_to_end(&mut head)
            .is_ok()
            && has_pdf_marker(&head)
    }

    /// The whole text of a stored HTML report, for the viewer to render in an isolated,
    /// read-only frame. It reads through the checked snapshot (never a path) and only a
    /// `.html` or `.htm` file up to `HTML_PREVIEW_BYTES` that is valid UTF-8.
    pub fn attachment_html(&self, workspace: &str, id: &str) -> Result<String, Error> {
        let attachment = self.preview_attachment(workspace, id)?;
        if !is_html_name(&attachment.original_filename) {
            return Err(Error::Attachment("This file is not an HTML report.".into()));
        }
        let (_, file) = open_snapshot(&self.connection, &attachment)
            .map_err(|failure| Error::Attachment(failure.message))?;
        if file.metadata()?.len() > HTML_PREVIEW_BYTES {
            return Err(Error::Attachment(
                "This report is larger than the 8 MiB preview limit. Open it in its app.".into(),
            ));
        }
        let mut bytes = Vec::new();
        file.take(HTML_PREVIEW_BYTES).read_to_end(&mut bytes)?;
        let text = String::from_utf8(bytes).map_err(|_| {
            Error::Attachment("This report is not UTF-8 text. Open it in its app.".into())
        })?;
        Ok(match text.strip_prefix('\u{feff}') {
            Some(rest) => rest.to_owned(),
            None => text,
        })
    }

    /// The start of a stored file when it reads as text; None for anything else,
    /// including a file that cannot be read now.
    fn text_excerpt(&self, attachment: &Attachment) -> Option<TextExcerpt> {
        let (_, file) = open_snapshot(&self.connection, attachment).ok()?;
        let length = file.metadata().ok()?.len();
        let mut bytes = Vec::new();
        file.take(TEXT_EXCERPT_BYTES as u64)
            .read_to_end(&mut bytes)
            .ok()?;
        let truncated = length > bytes.len() as u64;
        text_of(&bytes, truncated).map(|text| TextExcerpt { text, truncated })
    }

    /// Whether a kept local file's stored copy is gone or cut short on this
    /// computer. Quarantined and deleted files, and Drive references, never are.
    pub(crate) fn snapshot_missing(&self, attachment: &Attachment) -> bool {
        if attachment.kind != AttachmentKind::LocalSnapshot
            || attachment.quarantined
            || attachment.purge_state != crate::AttachmentPurgeState::Retained
        {
            return false;
        }
        matches!(
            open_snapshot(&self.connection, attachment),
            Err(SnapshotFailure {
                status: PreviewStatus::Missing | PreviewStatus::Incomplete,
                ..
            })
        )
    }

    fn preview_usage(&self, id: &str) -> Result<PreviewUsage, Error> {
        // Reuse the authoritative accounting; this is only a bounded display projection.
        let usage = self.attachment_usage(id)?;
        let total = usage.protections.len();
        let mut entries = Vec::new();
        for protection in usage.protections.into_iter().take(20) {
            let target = if protection.kind == "document_body" {
                Some(PreviewUseTarget::Document(protection.owner.clone()))
            } else if let Some(ticket_id) = &protection.ticket_id {
                self.connection
                    .query_row(
                        "SELECT reference FROM tickets WHERE id=?1",
                        [ticket_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .map(PreviewUseTarget::Ticket)
            } else {
                None
            };
            let label = if let Some(ticket_id) = &protection.ticket_id {
                self.connection
                    .query_row(
                        "SELECT reference || ' · ' || substr(title,1,200) FROM tickets WHERE id=?1",
                        [ticket_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .unwrap_or_else(|| "Ticket context".into())
            } else if protection.kind == "document_body" {
                self.connection
                    .query_row(
                        &format!(
                            "SELECT {} FROM documents d WHERE id=?1",
                            crate::documents::HEADING
                        ),
                        [&protection.owner],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .unwrap_or_else(|| "Document context".into())
            } else if protection.kind == "undo" {
                "Undo history".into()
            } else {
                "Recoverable draft".into()
            };
            entries.push(PreviewUse {
                kind: protection.kind,
                owner: protection.owner,
                label,
                trashed: protection.trashed,
                target,
            });
        }
        Ok(PreviewUsage {
            total,
            entries,
            legacy_drafts_pending: usage.legacy_drafts_pending,
        })
    }

    pub fn attachment_media(&self, workspace: &str, id: &str) -> Result<AttachmentMedia, Error> {
        let attachment = self.preview_attachment(workspace, id)?;
        self.open_media(&attachment)
            .map_err(|error| Error::Attachment(error.message))
    }

    fn open_media(&self, attachment: &Attachment) -> Result<AttachmentMedia, SnapshotFailure> {
        let (_, mut file) = open_snapshot(&self.connection, attachment)?;
        let length = file.metadata().map_err(snapshot_io)?.len();
        if length > MAX_PREVIEW_BYTES {
            return Err(SnapshotFailure::new(
                PreviewStatus::TooLarge,
                "This file exceeds the 100 MiB preview limit. Export it or open it explicitly.",
            ));
        }
        let mut header = Vec::new();
        file.by_ref()
            .take(64 * 1024)
            .read_to_end(&mut header)
            .map_err(snapshot_io)?;
        let media_type = classify(&header).ok_or_else(|| {
            SnapshotFailure::new(
                PreviewStatus::Unsupported,
                "Preview unavailable for this format. Export the file or open it explicitly.",
            )
        })?;
        if media_type.starts_with("image/") {
            let dimensions = image_dimensions(&header, media_type);
            if dimensions.is_none_or(|(width, height)| {
                width == 0
                    || height == 0
                    || width > 16_384
                    || height > 16_384
                    || u64::from(width) * u64::from(height) > 40_000_000
            }) {
                return Err(SnapshotFailure::new(
                    PreviewStatus::TooLarge,
                    "Image dimensions exceed preview limits or could not be checked safely. Export it or open it explicitly.",
                ));
            }
        }
        Ok(AttachmentMedia {
            file,
            media_type,
            length,
        })
    }
}

/// `%PDF-` within the first kilobyte, which is where readers look for it.
fn has_pdf_marker(bytes: &[u8]) -> bool {
    let window = &bytes[..bytes.len().min(PDF_MARKER_WINDOW + 5)];
    window.windows(5).any(|w| w == b"%PDF-")
}

fn is_html_name(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, extension)| {
        extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
    })
}

/// Text when the bytes are UTF-8 without NUL or control characters other than
/// tab, line breaks and form feed. A cut at the end of a truncated excerpt may
/// split one character; that partial character is dropped.
fn text_of(bytes: &[u8], truncated: bool) -> Option<String> {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) if truncated && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).ok()?
        }
        Err(_) => return None,
    };
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r' | '\u{c}'))
    {
        return None;
    }
    Some(text.to_owned())
}

// Only passive media containers with header evidence. This is not a codec guarantee.
fn classify(header: &[u8]) -> Option<&'static str> {
    if header.starts_with(b"\x89PNG\r\n\x1a\n") && header.get(12..16) == Some(b"IHDR") {
        return Some("image/png");
    }
    if header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if header.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if header.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if header.starts_with(b"RIFF") {
        if header.get(8..12) == Some(b"WEBP") {
            return Some("image/webp");
        }
        if header.get(8..16) == Some(b"WAVEfmt ") {
            return Some("audio/wav");
        }
    }
    if header.starts_with(b"OggS\0") {
        if header.windows(8).any(|w| w == b"OpusHead")
            || header.windows(7).any(|w| w == b"\x01vorbis")
        {
            return Some("audio/ogg");
        }
        if header.windows(7).any(|w| w == b"\x80theora") {
            return Some("video/ogg");
        }
    }
    if header.starts_with(b"\x1a\x45\xdf\xa3")
        && header.windows(7).any(|w| w == b"\x42\x82\x84webm")
    {
        return Some("video/webm");
    }
    if header.len() >= 16 && header.get(4..8) == Some(b"ftyp") {
        let size = u32::from_be_bytes(header.get(..4)?.try_into().ok()?) as usize;
        if size >= 16
            && size <= header.len()
            && matches!(
                header.get(8..12)?,
                b"isom" | b"iso2" | b"mp41" | b"mp42" | b"avc1" | b"M4V " | b"M4A "
            )
        {
            return Some(if header.get(8..12) == Some(b"M4A ") {
                "audio/mp4"
            } else {
                "video/mp4"
            });
        }
    }
    let frames = if header.starts_with(b"ID3")
        && header.len() >= 10
        && header[6..10].iter().all(|byte| *byte < 128)
    {
        let size = header[6..10]
            .iter()
            .fold(0_usize, |value, byte| (value << 7) | usize::from(*byte));
        header.get(10 + size..)?
    } else {
        header
    };
    if frames.len() >= 4
        && frames[0] == 0xff
        && frames[1] & 0xe0 == 0xe0
        && frames[1] & 0x18 != 0x08
        && frames[1] & 0x06 != 0
        && !matches!(frames[2] >> 4, 0 | 15)
        && frames[2] & 0x0c != 0x0c
    {
        return Some("audio/mpeg");
    }
    None
}

fn image_dimensions(header: &[u8], mime: &str) -> Option<(u32, u32)> {
    let be32 = |offset| {
        Some(u32::from_be_bytes(
            header.get(offset..offset + 4)?.try_into().ok()?,
        ))
    };
    let le32 = |offset| {
        Some(u32::from_le_bytes(
            header.get(offset..offset + 4)?.try_into().ok()?,
        ))
    };
    let le16 = |offset| {
        Some(u32::from(u16::from_le_bytes(
            header.get(offset..offset + 2)?.try_into().ok()?,
        )))
    };
    match mime {
        "image/png" => Some((be32(16)?, be32(20)?)),
        "image/gif" => Some((le16(6)?, le16(8)?)),
        "image/bmp" if le32(14)? == 12 => Some((le16(18)?, le16(20)?)),
        "image/bmp" => Some((le32(18)?, (le32(22)? as i32).unsigned_abs())),
        "image/webp" => match header.get(12..16)? {
            b"VP8X" => {
                let h = header.get(24..30)?;
                Some((
                    1 + u32::from_le_bytes([h[0], h[1], h[2], 0]),
                    1 + u32::from_le_bytes([h[3], h[4], h[5], 0]),
                ))
            }
            b"VP8 " if header.get(23..26) == Some(b"\x9d\x01\x2a") => {
                Some((le16(26)? & 0x3fff, le16(28)? & 0x3fff))
            }
            b"VP8L" if header.get(20) == Some(&0x2f) => {
                let bits = le32(21)?;
                Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            _ => None,
        },
        "image/jpeg" => {
            let mut offset = 2;
            while offset + 4 <= header.len() {
                if header[offset] != 0xff {
                    return None;
                }
                let marker = header[offset + 1];
                if marker == 0xff {
                    offset += 1;
                    continue;
                }
                let length = usize::from(u16::from_be_bytes(
                    header.get(offset + 2..offset + 4)?.try_into().ok()?,
                ));
                if length < 2 {
                    return None;
                }
                if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
                    let size = header.get(offset + 5..offset + 9)?;
                    return Some((
                        u32::from(u16::from_be_bytes([size[2], size[3]])),
                        u32::from(u16::from_be_bytes([size[0], size[1]])),
                    ));
                }
                offset = offset.checked_add(2 + length)?;
            }
            None
        }
        _ => None,
    }
}

pub(crate) struct SnapshotFailure {
    pub status: PreviewStatus,
    pub message: String,
    windows_access_denied: bool,
}

impl SnapshotFailure {
    fn new(status: PreviewStatus, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            windows_access_denied: false,
        }
    }
}

const WINDOWS_ACCESS_DENIED: i32 = 5;

fn snapshot_io(error: std::io::Error) -> SnapshotFailure {
    if error.kind() == std::io::ErrorKind::NotFound {
        return SnapshotFailure::new(
            PreviewStatus::Missing,
            "Stored bytes are missing. Restore the snapshot and retry, or choose a replacement for this reference.",
        );
    }
    SnapshotFailure {
        windows_access_denied: cfg!(windows) && error.raw_os_error() == Some(WINDOWS_ACCESS_DENIED),
        ..SnapshotFailure::new(
            PreviewStatus::Unavailable,
            format!(
                "Cannot read stored bytes: {error}. Restore the snapshot and retry, or choose a replacement for this reference."
            ),
        )
    }
}

pub(crate) fn open_snapshot(
    connection: &rusqlite::Connection,
    attachment: &Attachment,
) -> Result<(PathBuf, File), SnapshotFailure> {
    let current = crate::attachments::read_attachment(connection, &attachment.id)
        .map_err(|error| SnapshotFailure::new(PreviewStatus::Unavailable, error.to_string()))?;
    if current.purge_state != crate::AttachmentPurgeState::Retained {
        return Err(SnapshotFailure::new(
            PreviewStatus::Unavailable,
            crate::attachment_cleanup::purge_unavailable(&current),
        ));
    }
    if attachment.kind != AttachmentKind::LocalSnapshot {
        return Err(SnapshotFailure::new(
            PreviewStatus::Unsupported,
            "Current source content · No local snapshot. Open this external reference in Drive.",
        ));
    }

    let invalid = || {
        SnapshotFailure::new(
            PreviewStatus::Unavailable,
            "Invalid managed snapshot locator or filesystem link; preserve the file and repair its metadata.",
        )
    };
    if Uuid::parse_str(&attachment.id).is_err()
        || attachment
            .original_filename
            .contains(['/', '\\', ':', '\0'])
        || matches!(attachment.original_filename.as_str(), "" | "." | "..")
        || attachment.locator != format!("{}/bytes/{}", attachment.id, attachment.original_filename)
    {
        return Err(invalid());
    }
    let root = crate::attachments::attachment_directory(connection)
        .map_err(|error| SnapshotFailure::new(PreviewStatus::Unavailable, error.to_string()))?;
    // Reject links/reparse points in every managed component, including the root.
    let mut path = root.clone();
    reject_link(&path)?;
    path.push(&attachment.id);
    reject_link(&path)?;
    let canonical_root = fs::canonicalize(&root).map_err(snapshot_io)?;
    let open_at = |directory: &str| {
        let mut candidate = path.clone();
        for component in [directory, &attachment.original_filename] {
            candidate.push(component);
            reject_link(&candidate)?;
        }
        let canonical_path = fs::canonicalize(&candidate).map_err(snapshot_io)?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err(invalid());
        }
        // Reject special files before open (a pipe can block), then verify the actual handle too.
        if !fs::metadata(&canonical_path)
            .map_err(snapshot_io)?
            .is_file()
        {
            return Err(SnapshotFailure::new(
                PreviewStatus::Incomplete,
                "Stored bytes are not a regular file. Restore the snapshot and retry, or choose a replacement for this reference.",
            ));
        }
        let file = File::open(&canonical_path).map_err(snapshot_io)?;
        let metadata = file.metadata().map_err(snapshot_io)?;
        if !metadata.is_file() || Some(metadata.len()) != attachment.size_bytes {
            return Err(SnapshotFailure::new(
                PreviewStatus::Incomplete,
                "Stored bytes are incomplete. Restore the snapshot and retry, or choose a replacement for this reference.",
            ));
        }
        Ok((canonical_path, file))
    };
    open_retained_location(open_at)
}

fn open_retained_location<T>(
    mut open_at: impl FnMut(&str) -> Result<T, SnapshotFailure>,
) -> Result<T, SnapshotFailure> {
    // Undo can move quarantine to bytes while a reader holds the upload lock.
    // Windows can deny an open during the move. Keep that error if no path resolves.
    let mut access_denied = None;
    for directory in ["bytes", "quarantine"] {
        match open_at(directory) {
            Err(error) if error.status == PreviewStatus::Missing => {}
            Err(error) if error.windows_access_denied => access_denied = Some(error),
            result => return result,
        }
    }
    match open_at("bytes") {
        Err(error) if error.status == PreviewStatus::Missing => Err(access_denied.unwrap_or(error)),
        result => result,
    }
}

pub(crate) fn reject_link(path: &Path) -> Result<(), SnapshotFailure> {
    let metadata = fs::symlink_metadata(path).map_err(snapshot_io)?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if metadata.file_type().is_symlink() || reparse {
        return Err(SnapshotFailure::new(
            PreviewStatus::Unavailable,
            "Managed snapshot uses a filesystem link; restore it inside this workspace before retrying.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[test]
    fn a_windows_denial_can_resolve_at_the_restored_location() {
        let mut attempts = Vec::new();
        let result = open_retained_location(|directory| {
            attempts.push(directory.to_owned());
            match attempts.len() {
                1 => Err(snapshot_io(Error::from(ErrorKind::NotFound))),
                2 => Err(snapshot_io(Error::from_raw_os_error(WINDOWS_ACCESS_DENIED))),
                _ => Ok(()),
            }
        });
        if cfg!(windows) {
            assert!(result.is_ok());
            assert_eq!(attempts, ["bytes", "quarantine", "bytes"]);
        } else {
            assert!(result.is_err());
            assert_eq!(attempts, ["bytes", "quarantine"]);
        }
    }

    #[test]
    fn a_windows_denial_is_preserved_when_the_other_location_is_missing() {
        let result = open_retained_location(|directory| {
            if directory == "quarantine" {
                Err::<(), _>(snapshot_io(Error::from_raw_os_error(WINDOWS_ACCESS_DENIED)))
            } else {
                Err(snapshot_io(Error::from(ErrorKind::NotFound)))
            }
        });
        assert!(matches!(result, Err(error) if error.status == PreviewStatus::Unavailable));
    }
}
