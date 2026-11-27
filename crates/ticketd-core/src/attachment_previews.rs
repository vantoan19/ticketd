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
/// A text file up to this size is shown whole in the viewer (it crosses to the WebView as one
/// binary IPC response); a larger one shows only its last `TEXT_TAIL_BYTES`, because logs are
/// read from the end.
pub const TEXT_WHOLE_BYTES: u64 = 20 * 1024 * 1024;
/// How much of the end of a text file larger than `TEXT_WHOLE_BYTES` the viewer shows.
pub const TEXT_TAIL_BYTES: u64 = 5 * 1024 * 1024;
/// A tail may begin mid-line; it starts after the next line break only when one is this close.
const TEXT_LINE_START_WINDOW: usize = 64 * 1024;
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
    /// A plain-text file (a log, notes) the viewer reads with `attachment_text`, whole up to
    /// `TEXT_WHOLE_BYTES` and otherwise its end. Never media or HTML.
    pub text: Option<TextScope>,
}

/// How much of a text file the viewer shows, so it can say so when it is only the end.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TextScope {
    /// The size of the stored file.
    pub total_bytes: u64,
    /// What the viewer shows: the whole file, or the nominal tail when `partial`. A tail
    /// starts at a line start when one is near, so it can be a little shorter.
    pub shown_bytes: u64,
    /// The viewer shows only the end of the file.
    pub partial: bool,
}

impl TextScope {
    fn of(total_bytes: u64) -> Self {
        let partial = total_bytes > TEXT_WHOLE_BYTES;
        Self {
            total_bytes,
            shown_bytes: if partial {
                TEXT_TAIL_BYTES
            } else {
                total_bytes
            },
            partial,
        }
    }
}

/// The first bytes of a UTF-8 text file, cut on a character boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TextExcerpt {
    pub text: String,
    /// The file continues past the excerpt.
    pub truncated: bool,
    /// Invalid bytes were replaced to read it as text: a log still shows, but it is not
    /// the valid UTF-8 a report needs.
    #[serde(skip)]
    pub(crate) lossy: bool,
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
        // A log over the media limit is still a text file: its end shows, so it gets the
        // text check too. Anything else that is too large stays too large.
        let text_excerpt = if matches!(status, PreviewStatus::Unsupported | PreviewStatus::TooLarge)
            && attachment.kind == AttachmentKind::LocalSnapshot
        {
            self.text_excerpt(&attachment)
        } else {
            None
        };
        if status == PreviewStatus::TooLarge && text_excerpt.is_some() {
            status = PreviewStatus::Unsupported;
            message = None;
        }
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
                html = text_excerpt.as_ref().is_some_and(|excerpt| !excerpt.lossy);
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
        let text = (status == PreviewStatus::Unsupported && !html && text_excerpt.is_some())
            .then(|| TextScope::of(attachment.size_bytes.unwrap_or(0)));
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
            text,
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

    /// The text of a stored plain-text file for the viewer: the whole file up to
    /// `TEXT_WHOLE_BYTES`, otherwise its last `TEXT_TAIL_BYTES`. It reads through the checked
    /// snapshot (never a path), only a file that reads as text, and returns the display text:
    /// terminal escape sequences are removed and a stray control character becomes U+FFFD.
    pub fn attachment_text(&self, workspace: &str, id: &str) -> Result<String, Error> {
        let attachment = self.preview_attachment(workspace, id)?;
        if self.text_excerpt(&attachment).is_none() {
            return Err(Error::Attachment("This file is not plain text.".into()));
        }
        let (_, file) = open_snapshot(&self.connection, &attachment)
            .map_err(|failure| Error::Attachment(failure.message))?;
        read_text_window(file, TEXT_WHOLE_BYTES, TEXT_TAIL_BYTES)
    }

    /// The number of the first line `attachment_text` returns: 1 when it is the whole file,
    /// otherwise the count of lines cut from its start, plus one, so the viewer can number a
    /// log's end as the file does.
    pub fn attachment_text_first_line(&self, workspace: &str, id: &str) -> Result<u64, Error> {
        let attachment = self.preview_attachment(workspace, id)?;
        if self.text_excerpt(&attachment).is_none() {
            return Err(Error::Attachment("This file is not plain text.".into()));
        }
        let (_, file) = open_snapshot(&self.connection, &attachment)
            .map_err(|failure| Error::Attachment(failure.message))?;
        text_window_first_line(file, TEXT_WHOLE_BYTES, TEXT_TAIL_BYTES)
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
        let lossy = match std::str::from_utf8(&bytes) {
            Ok(_) => false,
            Err(error) => !(truncated && error.error_len().is_none()),
        };
        text_of(&bytes, truncated).map(|text| TextExcerpt {
            text,
            truncated,
            lossy,
        })
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

/// Text when the bytes read as UTF-8 without NUL or control characters other than
/// tab, line breaks and form feed. A few invalid bytes (one in a log) are replaced
/// by U+FFFD so they never hide it; a file with many is binary. A cut at the end of
/// a truncated excerpt may split one character; that partial character is dropped.
/// Terminal escape sequences (a coloured log) are not control characters here: they
/// are removed.
fn text_of(bytes: &[u8], truncated: bool) -> Option<String> {
    let bytes = match std::str::from_utf8(bytes) {
        Err(error) if truncated && error.error_len().is_none() => &bytes[..error.valid_up_to()],
        _ => bytes,
    };
    let text = String::from_utf8_lossy(bytes);
    let invalid = text.chars().filter(|c| *c == '\u{fffd}').count();
    if invalid > 1 + text.len() / INVALID_BYTES_PER_TEXT {
        return None;
    }
    let text = strip_terminal_escapes(&text);
    if text.chars().any(is_stray_control) {
        return None;
    }
    Some(text)
}

/// A file is text while at most one invalid byte in this many (plus one) is replaced.
const INVALID_BYTES_PER_TEXT: usize = 100;

fn is_stray_control(c: char) -> bool {
    c.is_control() && !matches!(c, '\t' | '\n' | '\r' | '\u{c}')
}

/// Reads a text file for display: all of it up to `whole`, otherwise its last `tail` bytes
/// (cut on a character boundary, and after the next line break when one is near). Invalid
/// UTF-8 and stray control characters become U+FFFD, so one bad byte never hides a log.
fn read_text_window(mut file: File, whole: u64, tail: u64) -> Result<String, Error> {
    let length = file.metadata()?.len();
    let start = if length > whole { length - tail } else { 0 };
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(length - start).read_to_end(&mut bytes)?;
    let from = if start > 0 { window_skip(&bytes) } else { 0 };
    let text = String::from_utf8_lossy(&bytes[from..]);
    let text = strip_terminal_escapes(&text);
    Ok(if text.chars().any(is_stray_control) {
        text.chars()
            .map(|c| if is_stray_control(c) { '\u{fffd}' } else { c })
            .collect()
    } else {
        text
    })
}

/// The longest a string sequence (OSC, DCS and the like) may run without its terminator
/// before it is taken for stray text rather than a title or a link.
const ESCAPE_STRING_LIMIT: usize = 4096;

/// How many bytes of a tail window to skip so it starts on a character boundary and, when
/// a line break is near, at the start of the next line.
fn window_skip(bytes: &[u8]) -> usize {
    let mut from = 0;
    while bytes.get(from).is_some_and(|b| b & 0xc0 == 0x80) {
        from += 1;
    }
    let near = &bytes[from..bytes.len().min(from + TEXT_LINE_START_WINDOW)];
    if let Some(line_break) = near.iter().position(|b| *b == b'\n') {
        from += line_break + 1;
    }
    from
}

/// The number of the first line `read_text_window` shows: 1 for a whole file, otherwise the
/// lines before the tail plus one, so a log's end keeps the file's own line numbers.
fn text_window_first_line(mut file: File, whole: u64, tail: u64) -> Result<u64, Error> {
    let length = file.metadata()?.len();
    if length <= whole {
        return Ok(1);
    }
    let start = length - tail;
    file.seek(SeekFrom::Start(start))?;
    let mut head = Vec::new();
    (&mut file)
        .take(4 + TEXT_LINE_START_WINDOW as u64)
        .read_to_end(&mut head)?;
    let shown_from = start + window_skip(&head) as u64;
    file.seek(SeekFrom::Start(0))?;
    let mut remaining = shown_from;
    let mut breaks = 0u64;
    let mut after_cr = false;
    let mut buffer = vec![0u8; 1 << 20];
    while remaining > 0 {
        let want = buffer.len().min(remaining as usize);
        let read = file.read(&mut buffer[..want])?;
        if read == 0 {
            break;
        }
        // A line ends at \n, \r\n or a lone \r, as the viewer splits it.
        for byte in &buffer[..read] {
            breaks += match byte {
                b'\n' => u64::from(!after_cr),
                b'\r' => 1,
                _ => 0,
            };
            after_cr = *byte == b'\r';
        }
        remaining -= read as u64;
    }
    Ok(breaks + 1)
}

/// Removes ANSI/VT escape sequences (colours, cursor moves, titles) and the bell and
/// backspace, so a coloured log reads as plain text. A sequence that is cut short (it
/// meets a line break, a byte that cannot belong to it, or runs past
/// `ESCAPE_STRING_LIMIT`) ends there and the text after it is kept.
fn strip_terminal_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{7}' | '\u{8}' => {}
            '\u{1b}' => match chars.next() {
                // CSI: parameters (0 to ?) and intermediates (space to /), then one final
                // byte (@ to ~). Anything else, a line break included, ends it unread.
                Some('[') => {
                    while chars.next_if(|c| (' '..='?').contains(c)).is_some() {}
                    chars.next_if(|c| ('\u{40}'..='\u{7e}').contains(c));
                }
                // OSC, DCS, SOS, PM and APC strings end at BEL or ST (ESC \), or, when
                // they never do, at the next line break.
                Some(']' | 'P' | 'X' | '^' | '_') => {
                    let mut length = 0;
                    while let Some(c) = chars.next_if(|c| *c != '\n') {
                        length += 1;
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                        if length >= ESCAPE_STRING_LIMIT {
                            break;
                        }
                    }
                }
                // A character-set or similar sequence: intermediates, then a final byte.
                Some(' '..='/') => {
                    while chars.next_if(|c| (' '..='/').contains(c)).is_some() {}
                    chars.next_if(|c| ('0'..='~').contains(c));
                }
                // An escape at the end of a line keeps its line break.
                Some('\n') => out.push('\n'),
                // Any other two-character sequence (ESC c, ESC 7).
                Some(_) | None => {}
            },
            c => out.push(c),
        }
    }
    out
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

    #[test]
    fn terminal_escapes_are_removed_and_other_controls_are_not_text() {
        let coloured =
            "\u{1b}[1;31merror\u{1b}[0m: \u{1b}]0;title\u{7}disk \u{1b}(Bfull\u{1b}[2K\u{1b}c";
        assert_eq!(strip_terminal_escapes(coloured), "error: disk full");
        // A sequence cut off by the end of an excerpt is dropped, not shown.
        assert_eq!(strip_terminal_escapes("ok\u{1b}[3"), "ok");
        assert_eq!(
            text_of(coloured.as_bytes(), false).unwrap(),
            "error: disk full"
        );
        assert!(text_of(b"a\0b", false).is_none());
        assert!(text_of(b"a\x01b", false).is_none());
    }

    #[test]
    fn one_invalid_byte_does_not_hide_a_log_but_a_binary_file_stays_hidden() {
        assert_eq!(
            text_of(b"ok\nbad \xff byte\nend\n", false).unwrap(),
            "ok\nbad \u{fffd} byte\nend\n"
        );
        // A character cut at the end of an excerpt is dropped, not shown as a bad byte.
        assert_eq!(text_of(b"ok \xc3", true).unwrap(), "ok ");
        assert!(text_of(&[0x80, 0xff, 0xfe, 0xfd, b'a', 0x90], false).is_none());
        assert!(text_of(b"a\0b", false).is_none());
    }

    #[test]
    fn a_tail_is_numbered_by_the_lines_the_viewer_splits() {
        let dir = tempfile::tempdir().unwrap();
        let first_line = |content: &[u8], whole, tail| {
            let path = dir.path().join("log");
            fs::write(&path, content).unwrap();
            text_window_first_line(File::open(path).unwrap(), whole, tail).unwrap()
        };
        // Lone CRs end lines: the tail begins on line 5, not 1.
        assert_eq!(first_line(b"a\rb\rc\rd\rtail", 11, 4), 5);
        // \r\n is one break, and \n alone still counts.
        assert_eq!(first_line(b"a\r\nb\r\nc\nd\n", 8, 4), 4);
        // A whole file starts at line 1.
        assert_eq!(first_line(b"a\rb\rc\r", 100, 4), 1);
    }

    #[test]
    fn a_long_file_shows_its_end_from_a_line_start_on_a_character_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let read = |content: &[u8], whole, tail| {
            let path = dir.path().join("log");
            fs::write(&path, content).unwrap();
            read_text_window(File::open(path).unwrap(), whole, tail).unwrap()
        };
        let log = "first\nsecond\nthird\nfourth\n";
        assert_eq!(read(log.as_bytes(), 100, 10), log);
        // 26 bytes over a limit of 20: the last 10 bytes begin mid-line, so the cut moves on.
        assert_eq!(read(log.as_bytes(), 20, 10), "fourth\n");
        // A cut inside a multi-byte character skips its trailing bytes.
        let accents = "é".repeat(20) + "\nend\n";
        assert_eq!(read(accents.as_bytes(), 20, 7), "end\n");
        // No line break in reach: only the character boundary is honoured.
        assert_eq!(read("é".repeat(20).as_bytes(), 20, 7), "ééé");
        // Invalid bytes never hide the log.
        assert_eq!(read(b"a\xffb\x01c", 100, 10), "a\u{fffd}b\u{fffd}c");
    }
}
