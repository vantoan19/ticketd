use std::fmt;
use std::io::Write;
use std::path::Path;

use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{Error, Workspace, attachment_previews, attachments};

use super::invalid;

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_attachments (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            media_type TEXT NOT NULL,
            bytes BLOB NOT NULL,
            UNIQUE(message_id, position)
        );",
    )?;
    Ok(())
}

/// History lists metadata. Snapshot bytes are read separately, within the owning Chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatAttachment {
    pub id: String,
    pub name: String,
    pub media_type: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ChatAttachmentContent {
    name: String,
    media_type: String,
    bytes: Vec<u8>,
}

impl fmt::Debug for ChatAttachmentContent {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("ChatAttachmentContent")
            .field("media_type", &self.media_type)
            .field("size_bytes", &self.bytes.len())
            .finish()
    }
}

impl ChatAttachmentContent {
    pub fn from_image_data_url(name: &str, data_url: &str) -> Result<Self, Error> {
        let content = Self::from_data_url(name, data_url, u64::MAX)?;
        if !content.is_image() {
            return Err(invalid("The clipboard did not provide a readable image."));
        }
        Ok(content)
    }

    /// Takes ownership of the PNG snapshot read by the platform's clipboard adapter.
    pub fn from_clipboard_png(bytes: Vec<u8>, limit: u64) -> Result<Self, Error> {
        Self::from_bytes("Screenshot.png", "image/png", bytes, limit)
    }

    /// Takes the byte snapshot supplied by the composer, without opening any source path.
    pub fn from_data_url(name: &str, data_url: &str, limit: u64) -> Result<Self, Error> {
        if !attachments::valid_filename(name) {
            return Err(invalid("The attachment has an invalid file name."));
        }
        let (claimed_type, encoded) = data_url
            .strip_prefix("data:")
            .and_then(|value| value.split_once(";base64,"))
            .filter(|(media_type, _)| media_type.len() <= 128)
            .ok_or_else(|| invalid("The attachment could not be read."))?;
        if encoded.len() as u64 > limit.div_ceil(3).saturating_mul(4) {
            return Err(Error::UploadLimit { limit });
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| invalid("The attachment could not be read."))?;
        let claimed_type = claimed_type.split(';').next().unwrap_or_default();
        Self::from_bytes(name, claimed_type, bytes, limit)
    }

    fn from_bytes(
        name: &str,
        claimed_type: &str,
        bytes: Vec<u8>,
        limit: u64,
    ) -> Result<Self, Error> {
        let image_type = attachment_previews::classify(&bytes[..bytes.len().min(16)])
            .filter(|media_type| supported_image(media_type));
        if claimed_type.starts_with("image/") && image_type != Some(claimed_type) {
            return Err(invalid(
                "The file bytes do not match a supported PNG, JPEG, WebP, or GIF image.",
            ));
        }
        let media_type = image_type.unwrap_or(if claimed_type.is_empty() {
            "application/octet-stream"
        } else {
            claimed_type
        });
        let content = Self {
            name: name.to_owned(),
            media_type: media_type.to_owned(),
            bytes,
        };
        content.ensure_fits(limit)?;
        Ok(content)
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn media_type(&self) -> &str {
        &self.media_type
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn is_image(&self) -> bool {
        supported_image(&self.media_type)
    }

    pub fn image_data_url(&self) -> Option<String> {
        self.is_image().then(|| self.data_url())
    }

    /// Sends the saved snapshot back to the composer when reopening a queued draft.
    pub fn data_url(&self) -> String {
        format!(
            "data:{};base64,{}",
            self.media_type,
            STANDARD.encode(&self.bytes)
        )
    }

    pub(super) fn ensure_fits(&self, limit: u64) -> Result<(), Error> {
        if self.bytes.len() as u64 > limit {
            return Err(Error::UploadLimit { limit });
        }
        Ok(())
    }

    pub(super) fn identity(&self) -> Value {
        json!({
            "name": self.name,
            "media_type": self.media_type,
            "sha256": format!("{:x}", Sha256::digest(&self.bytes)),
        })
    }
}

fn supported_image(media_type: &str) -> bool {
    matches!(
        media_type,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    )
}

pub(super) fn save(
    connection: &Connection,
    message_id: &str,
    content: &[ChatAttachmentContent],
) -> Result<(), Error> {
    let mut insert = connection.prepare(
        "INSERT INTO chat_attachments (id, message_id, position, name, media_type, bytes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for (position, file) in content.iter().enumerate() {
        insert.execute(params![
            Uuid::new_v4().to_string(),
            message_id,
            position,
            file.name,
            file.media_type,
            file.bytes
        ])?;
    }
    Ok(())
}

pub(super) fn list(
    connection: &Connection,
    message_id: &str,
) -> Result<Vec<ChatAttachment>, Error> {
    let mut read = connection.prepare(
        "SELECT id, name, media_type FROM chat_attachments WHERE message_id = ?1 ORDER BY position",
    )?;
    let files = read.query_map([message_id], |row| {
        Ok(ChatAttachment {
            id: row.get(0)?,
            name: row.get(1)?,
            media_type: row.get(2)?,
        })
    })?;
    Ok(files.collect::<Result<_, _>>()?)
}

impl Workspace {
    /// Ordered snapshots for one saved message, ready for the Chat host to deliver.
    pub fn chat_message_attachment_contents(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> Result<Vec<ChatAttachmentContent>, Error> {
        let mut statement = self.connection.prepare(
            "SELECT a.name, a.media_type, a.bytes FROM chat_attachments a
             JOIN chat_messages m ON m.id = a.message_id
             WHERE m.chat_id = ?1 AND m.id = ?2 ORDER BY a.position",
        )?;
        let attachments = statement.query_map(params![chat_id, message_id], read_content)?;
        Ok(attachments.collect::<Result<_, _>>()?)
    }

    /// Read the original bytes of an attachment from its own Chat.
    pub fn chat_attachment_content(
        &self,
        chat_id: &str,
        id: &str,
    ) -> Result<ChatAttachmentContent, Error> {
        self.connection
            .query_row(
                "SELECT a.name, a.media_type, a.bytes FROM chat_attachments a
                 JOIN chat_messages m ON m.id = a.message_id
                 WHERE m.chat_id = ?1 AND a.id = ?2",
                params![chat_id, id],
                read_content,
            )
            .optional()?
            .ok_or_else(|| invalid("This attachment could not be found in the Chat."))
    }

    pub fn export_chat_attachment(
        &self,
        chat_id: &str,
        id: &str,
        destination: &Path,
    ) -> Result<(), Error> {
        let snapshot = self.chat_attachment_content(chat_id, id)?;
        let parent = destination
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut output = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| crate::path_error("destination folder", parent, error))?;
        output.write_all(&snapshot.bytes)?;
        output.as_file().sync_all()?;
        output.persist_noclobber(destination).map_err(|error| {
            if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                Error::FileExists(destination.into())
            } else {
                Error::from(error.error)
            }
        })?;
        attachments::sync_directory(parent)
    }
}

fn read_content(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatAttachmentContent> {
    Ok(ChatAttachmentContent {
        name: row.get(0)?,
        media_type: row.get(1)?,
        bytes: row.get(2)?,
    })
}
