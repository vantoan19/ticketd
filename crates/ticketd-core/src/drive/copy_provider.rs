use super::client::{ClientError, DriveClient, ReadError, Retry, invalid_response, response_error};
use super::provider::parse_metadata;
use super::{
    CredentialStore, DriveCopyMetadata, DriveCopyProvider, DriveError, DriveErrorKind,
    DriveReference, DriveTransport, valid_file_id,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex, PoisonError};

/// Multi-account reads for a single export; credentials stay in the OS vault.
/// Each account has one client, so its access token serves every read.
pub struct GoogleDriveCopies<'a> {
    vault: &'a dyn CredentialStore,
    transport: &'a dyn DriveTransport,
    clients: Mutex<HashMap<String, Arc<DriveClient<'a>>>>,
}
impl<'a> GoogleDriveCopies<'a> {
    pub fn new(vault: &'a dyn CredentialStore, transport: &'a dyn DriveTransport) -> Self {
        Self {
            vault,
            transport,
            clients: Mutex::new(HashMap::new()),
        }
    }
    fn client(&self, connection_id: &str) -> Arc<DriveClient<'a>> {
        let mut clients = self.clients.lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(clients.entry(connection_id.to_owned()).or_insert_with(|| {
            Arc::new(DriveClient::new(connection_id, self.vault, self.transport))
        }))
    }
    /// The resource-key header a read of this reference needs, if any.
    fn headers(reference: &DriveReference) -> Result<Vec<(String, String)>, DriveError> {
        if !valid_file_id(&reference.metadata.id)
            || reference
                .metadata
                .resource_key
                .as_deref()
                .is_some_and(|k| !valid_file_id(k))
        {
            return Err(invalid_response());
        }
        Ok(reference
            .metadata
            .resource_key
            .iter()
            .map(|key| {
                (
                    "X-Goog-Drive-Resource-Keys".into(),
                    format!("{}/{key}", reference.metadata.id),
                )
            })
            .collect())
    }
}
impl DriveCopyProvider for GoogleDriveCopies<'_> {
    fn inspect(&self, reference: &DriveReference) -> Result<DriveCopyMetadata, DriveError> {
        let headers = Self::headers(reference)?;
        let id = &reference.metadata.id;
        let response = self.client(&reference.connection_id).send("GET", &format!("https://www.googleapis.com/drive/v3/files/{id}?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,resourceKey,trashed,isAppAuthorized,sha256Checksum,version,capabilities(canDownload)"), &headers, &[], Retry::Never)?;
        if response.status != 200 {
            return Err(response_error(&response));
        }
        let metadata = parse_metadata(
            id,
            reference.metadata.resource_key.as_deref(),
            &response.body,
        )?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Observation {
            sha256_checksum: Option<String>,
            version: Option<String>,
            capabilities: Option<Capabilities>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Capabilities {
            can_download: Option<bool>,
        }
        let observation: Observation =
            serde_json::from_slice(&response.body).map_err(|_| invalid_response())?;
        Ok(DriveCopyMetadata {
            metadata,
            sha256_checksum: observation.sha256_checksum,
            version: observation.version,
            can_download: observation.capabilities.and_then(|c| c.can_download),
        })
    }
    fn download(
        &self,
        reference: &DriveReference,
        size: u64,
        output: &mut dyn Write,
    ) -> Result<(), DriveError> {
        if reference
            .metadata
            .mime_type
            .starts_with("application/vnd.google-apps.")
        {
            return Err(DriveError::new(
                DriveErrorKind::Unsupported,
                "Google-native content opens in Drive; original-byte download and conversion are unsupported",
            ));
        }
        let headers = Self::headers(reference)?;
        self.client(&reference.connection_id)
            .read_ranges(
                &format!(
                    "https://www.googleapis.com/drive/v3/files/{}?alt=media&supportsAllDrives=true",
                    reference.metadata.id
                ),
                &headers,
                size,
                Retry::Never,
                output,
            )
            .map_err(export_error)
    }
}

fn export_error(error: ReadError) -> DriveError {
    match error {
        ReadError::Client(error) => ClientError::into_drive_error(error),
        ReadError::ContentRange => invalid_response(),
        ReadError::Length => DriveError::new(
            DriveErrorKind::InvalidResponse,
            "Drive returned incomplete or changed download bytes; retry",
        ),
        ReadError::NotRanged => DriveError::new(
            DriveErrorKind::Unsupported,
            "Drive did not honor bounded download ranges; original bytes were not exported",
        ),
        ReadError::Output => DriveError::new(
            DriveErrorKind::InvalidResponse,
            "Could not write verified export bytes; check disk space and retry",
        ),
    }
}
