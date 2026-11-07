use super::provider::{invalid_response, metadata_error, parse_metadata};
use super::{
    CredentialStore, DriveCopyMetadata, DriveCopyProvider, DriveError, DriveErrorKind,
    DriveReference, DriveRequest, DriveTransport, GoogleDrive, valid_file_id,
};
use serde::Deserialize;
use std::io::Write;

/// Multi-account reads for a single export; credentials stay in the OS vault.
pub struct GoogleDriveCopies<'a> {
    vault: &'a dyn CredentialStore,
    transport: &'a dyn DriveTransport,
}
impl<'a> GoogleDriveCopies<'a> {
    pub fn new(vault: &'a dyn CredentialStore, transport: &'a dyn DriveTransport) -> Self {
        Self { vault, transport }
    }
    fn headers(&self, reference: &DriveReference) -> Result<Vec<(String, String)>, DriveError> {
        if !valid_file_id(&reference.metadata.id)
            || reference
                .metadata
                .resource_key
                .as_deref()
                .is_some_and(|k| !valid_file_id(k))
        {
            return Err(invalid_response());
        }
        let mut headers = GoogleDrive::new(&reference.connection_id, self.vault, self.transport)
            .authorization()?;
        if let Some(key) = &reference.metadata.resource_key {
            headers.push((
                "X-Goog-Drive-Resource-Keys".into(),
                format!("{}/{key}", reference.metadata.id),
            ));
        }
        Ok(headers)
    }
}
impl DriveCopyProvider for GoogleDriveCopies<'_> {
    fn inspect(&self, reference: &DriveReference) -> Result<DriveCopyMetadata, DriveError> {
        let headers = self.headers(reference)?;
        let id = &reference.metadata.id;
        let response=self.transport.send(DriveRequest { method:"GET", url:format!("https://www.googleapis.com/drive/v3/files/{id}?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,resourceKey,trashed,isAppAuthorized,sha256Checksum,version,capabilities(canDownload)"),headers,body:vec![] })?;
        if response.status != 200 {
            return Err(metadata_error(&response));
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
        let headers = self.headers(reference)?;
        let mut offset = 0;
        loop {
            let length = (size - offset).min(256 * 1024);
            let mut headers = headers.clone();
            if length > 0 {
                headers.push((
                    "Range".into(),
                    format!("bytes={offset}-{}", offset + length - 1),
                ));
            }
            let response = self.transport.send(DriveRequest {
                method: "GET",
                url: format!(
                    "https://www.googleapis.com/drive/v3/files/{}?alt=media&supportsAllDrives=true",
                    reference.metadata.id
                ),
                headers,
                body: vec![],
            })?;
            match response.status {
                206 => {
                    let expected = format!(
                        "bytes {offset}-{}/{size}",
                        offset + length.saturating_sub(1)
                    );
                    if length == 0
                        || !response
                            .headers
                            .iter()
                            .any(|(k, v)| k.eq_ignore_ascii_case("content-range") && v == &expected)
                    {
                        return Err(invalid_response());
                    }
                }
                200 if offset == 0 && size <= 256 * 1024 => {}
                200 => {
                    return Err(DriveError::new(
                        DriveErrorKind::Unsupported,
                        "Drive did not honor bounded download ranges; original bytes were not exported",
                    ));
                }
                _ => return Err(metadata_error(&response)),
            }
            if response.body.len() as u64 != length {
                return Err(DriveError::new(
                    DriveErrorKind::InvalidResponse,
                    "Drive returned incomplete or changed download bytes; retry",
                ));
            }
            output.write_all(&response.body).map_err(|_| {
                DriveError::new(
                    DriveErrorKind::InvalidResponse,
                    "Could not write verified export bytes; check disk space and retry",
                )
            })?;
            offset += length;
            if offset == size {
                return Ok(());
            }
        }
    }
}
