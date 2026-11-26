use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{
    Error, Workspace,
    drive::{DriveUploadDestination, DriveUploadProvider, SyncUploadsFolder},
    sync::SyncProvider,
};

/// The Google sign-in of this computer, which Files and Workspace sync share.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoogleSignIn {
    /// Where the credential is kept; the same account always has the same one.
    pub connection_id: String,
    /// The account's email address, when it is known.
    pub account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttachmentUploadDestination {
    Local,
    GoogleDrive {
        destination: DriveUploadDestination,
        folder_name: String,
        /// The Google account the folder was chosen with, when it is known. Workspace
        /// sync's sign-in is the same one while it uses this connection.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account: Option<String>,
        /// The Workspace folder this destination's Uploads folder sits inside, while it is
        /// the Uploads folder of Workspace sync's folder on Google Drive.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sync_folder: Option<String>,
    },
}

pub(crate) fn migrate(tx: &Connection) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS attachment_upload_destination (id INTEGER PRIMARY KEY CHECK(id=1), destination TEXT NOT NULL);
        INSERT OR IGNORE INTO attachment_upload_destination VALUES (1, '{\"kind\":\"local\"}');
        CREATE TABLE IF NOT EXISTS attachment_upload_destinations (request_id TEXT PRIMARY KEY, destination TEXT NOT NULL);")?;
    crate::change_token::migrate(tx)?;
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
                account: None,
                sync_folder: None,
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
        self.set_drive_upload_destination_for(destination, None, provider)
    }

    /// Like [`Workspace::set_drive_upload_destination`], remembering the Google account the
    /// folder was chosen with, so Settings can name it and Workspace sync can use the same
    /// sign-in. Files and Workspace sync share one Google sign-in: a folder in another
    /// account than the one sync is signed in with is refused.
    pub fn set_drive_upload_destination_for(
        &mut self,
        destination: &DriveUploadDestination,
        account: Option<&str>,
        provider: &dyn DriveUploadProvider,
    ) -> Result<AttachmentUploadDestination, Error> {
        self.refuse_other_google_sign_in(&destination.connection_id)?;
        // No database write until current provider evidence establishes writability.
        let folder = self.validate_drive_upload_destination(destination, provider)?;
        self.save_upload_destination(AttachmentUploadDestination::GoogleDrive {
            destination: destination.clone(),
            folder_name: folder.name,
            account: account.map(str::to_owned),
            sync_folder: None,
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

    /// The Google sign-in Files and Workspace sync share: the one sync is signed in with,
    /// otherwise the one the upload folder was chosen with.
    pub fn google_sign_in(&self) -> Result<Option<GoogleSignIn>, Error> {
        if let Some((connection_id, account)) = self.sync_google_sign_in()? {
            return Ok(Some(GoogleSignIn {
                connection_id,
                account,
            }));
        }
        Ok(match self.attachment_upload_destination()? {
            AttachmentUploadDestination::GoogleDrive {
                destination,
                account,
                ..
            } => Some(GoogleSignIn {
                connection_id: destination.connection_id,
                account,
            }),
            AttachmentUploadDestination::Local => None,
        })
    }

    /// Files and Workspace sync use one Google account. While sync is signed in to Google
    /// Drive, a folder in another account is refused.
    pub(crate) fn refuse_other_google_sign_in(&self, connection_id: &str) -> Result<(), Error> {
        match self.sync_google_sign_in()? {
            Some((sync, _)) if sync != connection_id => Err(Error::Attachment(
                "Workspace sync is signed in to another Google account; choose a folder in that account, or use another account for both"
                    .into(),
            )),
            _ => Ok(()),
        }
    }

    /// Send new files to the Uploads folder inside the folder Workspace sync uses on Google
    /// Drive, with the sign-in sync already holds. The folder is found or made through
    /// `uploads`. Files already uploaded stay where they are.
    pub fn use_sync_uploads_folder(
        &mut self,
        uploads: &dyn SyncUploadsFolder,
    ) -> Result<AttachmentUploadDestination, Error> {
        let binding = self
            .sync_binding()?
            .filter(|binding| binding.provider == SyncProvider::GoogleDrive);
        let Some((binding, connection_id)) =
            binding.and_then(|binding| Some((binding.clone(), binding.connection_id?)))
        else {
            return Err(Error::Attachment(
                "Workspace sync is not on Google Drive, so there is no sync folder to keep uploads in"
                    .into(),
            ));
        };
        let account = self.sync_google_sign_in()?.and_then(|(_, account)| account);
        let folder = uploads
            .uploads_folder(&binding.folder_id)
            .map_err(|error| Error::Sync(error.to_string()))?;
        if !crate::drive::valid_file_id(&folder.id) || !folder.can_add_children {
            return Err(Error::Attachment(
                "the Uploads folder in Google Drive cannot receive files".into(),
            ));
        }
        self.save_upload_destination(AttachmentUploadDestination::GoogleDrive {
            destination: DriveUploadDestination {
                connection_id,
                folder_id: folder.id,
                resource_key: None,
            },
            folder_name: folder.name,
            account,
            sync_folder: Some(binding.folder_id),
        })
    }

    /// Keep uploads in step with Workspace sync: a Google Drive destination that is not the
    /// Uploads folder of the folder sync uses now (a folder chosen before sync was set up,
    /// or the Uploads folder of a folder sync no longer uses) moves there. Returns whether
    /// it did. A destination on this computer, or sync off or on S3, is left as it is.
    pub fn follow_sync_uploads(&mut self, uploads: &dyn SyncUploadsFolder) -> Result<bool, Error> {
        let AttachmentUploadDestination::GoogleDrive { sync_folder, .. } =
            self.attachment_upload_destination()?
        else {
            return Ok(false);
        };
        let Some(binding) = self
            .sync_binding()?
            .filter(|binding| binding.provider == SyncProvider::GoogleDrive)
        else {
            return Ok(false);
        };
        if sync_folder.as_deref() == Some(binding.folder_id.as_str()) {
            return Ok(false);
        }
        self.use_sync_uploads_folder(uploads)?;
        Ok(true)
    }

    /// Use the Google account that has just signed in, for Files and Workspace sync both.
    /// Sync, if it is signed in to Google Drive, stops syncing here (what it held stays in
    /// Drive and on this computer) and waits at its choice of Workspace for the new
    /// account. A Drive folder chosen for new files belongs to the old account, so new
    /// files are kept on this computer until Google Drive is chosen again. The same
    /// account again changes nothing but the address shown.
    pub fn switch_google_account(
        &mut self,
        connection_id: &str,
        account: &str,
    ) -> Result<(), Error> {
        if let Some((current, _)) = self.sync_google_sign_in()? {
            if current != connection_id && self.sync_binding()?.is_some() {
                self.sync_disconnect()?;
            }
            self.sync_connect(connection_id, account)?;
        }
        if let AttachmentUploadDestination::GoogleDrive {
            destination,
            folder_name,
            sync_folder,
            ..
        } = self.attachment_upload_destination()?
        {
            if destination.connection_id == connection_id {
                self.save_upload_destination(AttachmentUploadDestination::GoogleDrive {
                    destination,
                    folder_name,
                    account: Some(account.to_owned()),
                    sync_folder,
                })?;
            } else {
                self.save_upload_destination(AttachmentUploadDestination::Local)?;
            }
        }
        Ok(())
    }
}
