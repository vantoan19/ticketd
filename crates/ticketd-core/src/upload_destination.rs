use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{
    Error, Workspace,
    drive::{DriveUploadDestination, DriveUploadProvider},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttachmentUploadDestination {
    Local,
    GoogleDrive {
        destination: DriveUploadDestination,
        folder_name: String,
    },
}

pub(crate) fn migrate(tx: &Connection) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS attachment_upload_destination (id INTEGER PRIMARY KEY CHECK(id=1), destination TEXT NOT NULL);
        INSERT OR IGNORE INTO attachment_upload_destination VALUES (1, '{\"kind\":\"local\"}');
        CREATE TABLE IF NOT EXISTS attachment_upload_destinations (request_id TEXT PRIMARY KEY, destination TEXT NOT NULL);")?;
    crate::change_token::migrate(tx)?;
    tx.pragma_update(None, "user_version", 55)?;
    Ok(())
}

impl Workspace {
    /// Freeze destination before any upload effect. A retry without an override
    /// returns its original choice, including operations created before schema55.
    pub fn begin_attachment_upload(
        &mut self,
        request_id: &str,
        explicit: Option<AttachmentUploadDestination>,
    ) -> Result<AttachmentUploadDestination, Error> {
        if request_id.trim().is_empty() {
            return Err(Error::Attachment(
                "supply a nonempty upload request ID for safe retry".into(),
            ));
        }
        if let Some(AttachmentUploadDestination::GoogleDrive { destination, .. }) = &explicit
            && (uuid::Uuid::parse_str(&destination.connection_id).is_err()
                || !crate::drive::valid_file_id(&destination.folder_id)
                || destination
                    .resource_key
                    .as_deref()
                    .is_some_and(|key| !crate::drive::valid_file_id(key)))
        {
            return Err(Error::Attachment(
                "select a valid Drive account and upload folder".into(),
            ));
        }
        self.recover_uploads()?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let saved: Option<String> = tx
            .query_row(
                "SELECT destination FROM attachment_upload_destinations WHERE request_id=?1",
                [request_id],
                |r| r.get(0),
            )
            .optional()?;
        let drive: Option<String> = tx
            .query_row(
                "SELECT operation FROM drive_upload_operations WHERE request_id=?1",
                [request_id],
                |r| r.get(0),
            )
            .optional()?;
        let local: Option<String> = tx
            .query_row(
                "SELECT request FROM request_outcomes WHERE id=?1",
                [request_id],
                |r| r.get(0),
            )
            .optional()?;
        let previous = if let Some(value) = saved {
            Some(serde_json::from_str(&value)?)
        } else if let Some(value) = drive {
            let operation: crate::drive::DriveUploadOperation = serde_json::from_str(&value)?;
            Some(AttachmentUploadDestination::GoogleDrive {
                folder_name: operation.request.destination.folder_id.clone(),
                destination: operation.request.destination,
            })
        } else if let Some(value) = local {
            let request: serde_json::Value = serde_json::from_str(&value)?;
            if request["operation"] != "import_attachment"
                && request["operation"] != "capture_attachment"
            {
                return Err(Error::RequestConflict(request_id.into()));
            }
            Some(AttachmentUploadDestination::Local)
        } else {
            None
        };
        if let (Some(previous), Some(explicit)) = (&previous, &explicit) {
            let same = match (previous, explicit) {
                (AttachmentUploadDestination::Local, AttachmentUploadDestination::Local) => true,
                (
                    AttachmentUploadDestination::GoogleDrive { destination: a, .. },
                    AttachmentUploadDestination::GoogleDrive { destination: b, .. },
                ) => a == b,
                _ => false,
            };
            if !same {
                return Err(Error::RequestConflict(request_id.into()));
            }
        }
        let choice = match previous.or(explicit) {
            Some(choice) => choice,
            None => {
                let value: String = tx.query_row(
                    "SELECT destination FROM attachment_upload_destination WHERE id=1",
                    [],
                    |r| r.get(0),
                )?;
                serde_json::from_str(&value)?
            }
        };
        tx.execute(
            "INSERT OR IGNORE INTO attachment_upload_destinations VALUES (?1,?2)",
            params![request_id, serde_json::to_string(&choice)?],
        )?;
        tx.commit()?;
        Ok(choice)
    }
    /// Last explicitly validated preference; reading never requires provider access.
    pub fn attachment_upload_destination(&self) -> Result<AttachmentUploadDestination, Error> {
        let value: String = self.connection.query_row(
            "SELECT destination FROM attachment_upload_destination WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&value)?)
    }

    pub fn set_local_upload_destination(&mut self) -> Result<AttachmentUploadDestination, Error> {
        self.save_upload_destination(AttachmentUploadDestination::Local)
    }

    pub fn set_drive_upload_destination(
        &mut self,
        destination: &DriveUploadDestination,
        provider: &dyn DriveUploadProvider,
    ) -> Result<AttachmentUploadDestination, Error> {
        // No database write until current provider evidence establishes writability.
        let folder = self.validate_drive_upload_destination(destination, provider)?;
        self.save_upload_destination(AttachmentUploadDestination::GoogleDrive {
            destination: destination.clone(),
            folder_name: folder.name,
        })
    }

    fn save_upload_destination(
        &mut self,
        destination: AttachmentUploadDestination,
    ) -> Result<AttachmentUploadDestination, Error> {
        self.connection.execute(
            "UPDATE attachment_upload_destination SET destination=?1 WHERE id=1",
            params![serde_json::to_string(&destination)?],
        )?;
        Ok(destination)
    }
}
