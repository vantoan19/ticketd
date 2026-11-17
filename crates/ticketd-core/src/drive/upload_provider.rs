//! Uploaded copies through the shared Drive client. A copy is created under
//! its reserved file ID and never retried automatically: the Workspace records
//! it as uncertain before any bytes are sent and reconciles by that ID.
use super::client::{ClientError, Retry, invalid_response, response_error};
use super::provider::parse_metadata;
use super::{
    DriveError, DriveErrorKind, DriveFolder, DriveUploadOperation, DriveUploadProvider,
    DriveUploadedFile, GoogleDrive, valid_file_id,
};
use serde::Deserialize;
use std::io::Read;

const UPLOAD_URL: &str =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true";

impl DriveUploadProvider for GoogleDrive<'_> {
    fn folder(&self, id: &str, resource_key: Option<&str>) -> Result<DriveFolder, DriveError> {
        if !valid_file_id(id) || resource_key.is_some_and(|k| !valid_file_id(k)) {
            return Err(invalid_response());
        }
        let headers = resource_key
            .map(|k| vec![("X-Goog-Drive-Resource-Keys".into(), format!("{id}/{k}"))])
            .unwrap_or_default();
        let response=self.client.send("GET",&format!("https://www.googleapis.com/drive/v3/files/{id}?supportsAllDrives=true&fields=id,name,mimeType,trashed,capabilities(canAddChildren)"),&headers,&[],Retry::Never)?;
        if response.status != 200 {
            return Err(response_error(&response));
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Folder {
            id: String,
            name: String,
            mime_type: String,
            trashed: Option<bool>,
            capabilities: Capabilities,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Capabilities {
            can_add_children: Option<bool>,
        }
        let folder: Folder =
            serde_json::from_slice(&response.body).map_err(|_| invalid_response())?;
        if folder.id != id
            || folder.mime_type != "application/vnd.google-apps.folder"
            || folder.trashed == Some(true)
        {
            return Err(DriveError::new(
                DriveErrorKind::Unsupported,
                "choose an existing writable Drive folder",
            ));
        }
        Ok(DriveFolder {
            id: folder.id,
            name: folder.name,
            can_add_children: folder.capabilities.can_add_children == Some(true),
        })
    }
    fn reserve_file_id(&self) -> Result<String, DriveError> {
        self.client
            .reserve_id(Retry::Never)
            .map_err(ClientError::into_drive_error)
    }
    fn uploaded_file(&self, id: &str) -> Result<Option<DriveUploadedFile>, DriveError> {
        if !valid_file_id(id) {
            return Err(invalid_response());
        }
        let response=self.client.send("GET",&format!("https://www.googleapis.com/drive/v3/files/{id}?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,resourceKey,trashed,isAppAuthorized,sha256Checksum,version,appProperties,parents"),&[],&[],Retry::Never)?;
        if response.status == 404 {
            return Ok(None);
        }
        if response.status != 200 {
            return Err(response_error(&response));
        }
        let metadata = parse_metadata(id, None, &response.body)?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Provenance {
            sha256_checksum: Option<String>,
            version: Option<String>,
            #[serde(default)]
            app_properties: std::collections::HashMap<String, String>,
            #[serde(default)]
            parents: Vec<String>,
        }
        let file: Provenance =
            serde_json::from_slice(&response.body).map_err(|_| invalid_response())?;
        Ok(Some(DriveUploadedFile {
            metadata,
            sha256_checksum: file.sha256_checksum,
            version: file.version,
            operation_id: file.app_properties.get("ticketdUpload").cloned(),
            parent_ids: file.parents,
        }))
    }
    fn upload_blob(
        &self,
        operation: &DriveUploadOperation,
        input: &mut dyn Read,
        progress: &mut dyn FnMut(u64, u64) -> bool,
    ) -> Result<(), DriveError> {
        let id = operation
            .remote_file_id
            .as_deref()
            .filter(|id| valid_file_id(id))
            .ok_or_else(invalid_response)?;
        let request = &operation.request;
        if !valid_file_id(&request.destination.folder_id) {
            return Err(invalid_response());
        }
        let total = request.size_bytes;
        if !progress(0, total) {
            return Err(cancelled());
        }
        let body=serde_json::to_vec(&serde_json::json!({"id":id,"name":request.filename,"mimeType":"application/octet-stream","parents":[request.destination.folder_id],"appProperties":{"ticketdUpload":operation.attachment_id}})).map_err(|_|invalid_response())?;
        let mut headers = vec![
            (
                "Content-Type".into(),
                "application/json; charset=UTF-8".into(),
            ),
            (
                "X-Upload-Content-Type".into(),
                "application/octet-stream".into(),
            ),
            ("X-Upload-Content-Length".into(), total.to_string()),
        ];
        if let Some(key) = &request.destination.resource_key {
            headers.push((
                "X-Goog-Drive-Resource-Keys".into(),
                format!("{}/{key}", request.destination.folder_id),
            ));
        }
        let session =
            match self
                .client
                .open_session("POST", UPLOAD_URL, &headers, &body, Retry::Never)
            {
                Ok(session) => session,
                // A prior same-ID create may have succeeded. The Workspace verifies it.
                Err(ClientError::Refused(response)) if response.status == 409 => return Ok(()),
                Err(error) => return Err(error.into_drive_error()),
            };
        self.client
            .upload_chunks(
                &session,
                "application/octet-stream",
                total,
                input,
                Retry::Never,
                &mut |sent| {
                    if progress(sent, total) {
                        Ok(())
                    } else {
                        Err(cancelled().into())
                    }
                },
            )
            .map_err(ClientError::into_drive_error)?;
        progress(total, total);
        Ok(())
    }
}

fn cancelled() -> DriveError {
    DriveError::new(
        DriveErrorKind::Cancelled,
        "Upload canceled; any completed file remains in Drive. Check status before retrying.",
    )
}
