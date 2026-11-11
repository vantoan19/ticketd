use super::provider::{invalid_response, metadata_error, parse_metadata};
use super::{
    DriveError, DriveErrorKind, DriveFolder, DriveRequest, DriveResponse, DriveUploadOperation,
    DriveUploadProvider, DriveUploadedFile, GoogleDrive, valid_file_id,
};
use serde::Deserialize;
use std::io::Read;

const UPLOAD_URL: &str =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true";
pub(super) fn safe_session_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    // Creation uploads to the collection; a content update names its file.
    let path = url.path();
    url.scheme() == "https"
        && url.host_str() == Some("www.googleapis.com")
        && (path == "/upload/drive/v3/files"
            || path
                .strip_prefix("/upload/drive/v3/files/")
                .is_some_and(valid_file_id))
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none()
        && url
            .query_pairs()
            .any(|(k, v)| k == "uploadType" && v == "resumable")
}
impl GoogleDrive<'_> {
    fn upload_request(
        &self,
        method: &'static str,
        url: String,
        mut headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> Result<DriveResponse, DriveError> {
        headers.extend(self.authorization()?);
        self.transport.send(DriveRequest {
            method,
            url,
            headers,
            body,
        })
    }
}
impl DriveUploadProvider for GoogleDrive<'_> {
    fn folder(&self, id: &str, resource_key: Option<&str>) -> Result<DriveFolder, DriveError> {
        if !valid_file_id(id) || resource_key.is_some_and(|k| !valid_file_id(k)) {
            return Err(invalid_response());
        }
        let headers = resource_key
            .map(|k| vec![("X-Goog-Drive-Resource-Keys".into(), format!("{id}/{k}"))])
            .unwrap_or_default();
        let response=self.upload_request("GET",format!("https://www.googleapis.com/drive/v3/files/{id}?supportsAllDrives=true&fields=id,name,mimeType,trashed,capabilities(canAddChildren)"),headers,vec![])?;
        if response.status != 200 {
            return Err(metadata_error(&response));
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
        let response = self.upload_request(
            "GET",
            "https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files"
                .into(),
            vec![],
            vec![],
        )?;
        if response.status != 200 {
            return Err(metadata_error(&response));
        }
        #[derive(Deserialize)]
        struct Ids {
            ids: Vec<String>,
        }
        let ids: Ids = serde_json::from_slice(&response.body).map_err(|_| invalid_response())?;
        match ids.ids.as_slice() {
            [id] if valid_file_id(id) => Ok(id.clone()),
            _ => Err(invalid_response()),
        }
    }
    fn uploaded_file(&self, id: &str) -> Result<Option<DriveUploadedFile>, DriveError> {
        if !valid_file_id(id) {
            return Err(invalid_response());
        }
        let response=self.upload_request("GET",format!("https://www.googleapis.com/drive/v3/files/{id}?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,resourceKey,trashed,isAppAuthorized,sha256Checksum,version,appProperties,parents"),vec![],vec![])?;
        if response.status == 404 {
            return Ok(None);
        }
        if response.status != 200 {
            return Err(metadata_error(&response));
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
        let authorization = self.authorization()?;
        headers.extend(authorization.clone());
        let response = self.transport.send(DriveRequest {
            method: "POST",
            url: UPLOAD_URL.into(),
            headers,
            body,
        })?;
        // A prior same-ID create may have succeeded. The Workspace verifies it.
        if response.status == 409 {
            return Ok(());
        }
        if !matches!(response.status, 200 | 201) {
            return Err(metadata_error(&response));
        }
        let session = response
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("location"))
            .map(|(_, v)| v)
            .filter(|v| safe_session_url(v))
            .ok_or_else(invalid_response)?;
        let response = send_chunks(
            total,
            input,
            &mut |range, bytes| {
                let mut headers = vec![
                    ("Content-Type".into(), "application/octet-stream".into()),
                    ("Content-Range".into(), range),
                ];
                headers.extend(authorization.clone());
                self.transport.send(DriveRequest {
                    method: "PUT",
                    url: session.clone(),
                    headers,
                    body: bytes,
                })
            },
            &mut |sent| {
                if progress(sent, total) {
                    Ok(())
                } else {
                    Err(cancelled())
                }
            },
        )?;
        if !matches!(response.status, 200 | 201) {
            return Err(metadata_error(&response));
        }
        progress(total, total);
        Ok(())
    }
}

/// Sends `total` bytes of `input` to a resumable upload session in 256 KiB
/// chunks. `put` sends one chunk with its `Content-Range`; `proceed` may stop
/// the upload before each chunk. Returns the completing response, or the first
/// response that neither completes nor continues the upload.
pub(super) fn send_chunks<E: From<DriveError>>(
    total: u64,
    input: &mut dyn Read,
    put: &mut dyn FnMut(String, Vec<u8>) -> Result<DriveResponse, E>,
    proceed: &mut dyn FnMut(u64) -> Result<(), E>,
) -> Result<DriveResponse, E> {
    let mut sent = 0;
    loop {
        proceed(sent)?;
        let count = (total - sent).min(256 * 1024) as usize;
        let mut bytes = vec![0; count];
        input
            .read_exact(&mut bytes)
            .map_err(|_| invalid_response())?;
        let range = if total == 0 {
            "bytes */0".into()
        } else {
            format!("bytes {}-{}/{total}", sent, sent + count as u64 - 1)
        };
        let response = put(range, bytes)?;
        sent += count as u64;
        if matches!(response.status, 200 | 201) {
            if sent != total {
                return Err(invalid_response().into());
            }
            return Ok(response);
        }
        if response.status != 308 {
            return Ok(response);
        }
        let expected = format!("bytes=0-{}", sent.saturating_sub(1));
        if sent == 0
            || sent >= total
            || !response
                .headers
                .iter()
                .any(|(k, v)| k.eq_ignore_ascii_case("range") && v == &expected)
        {
            return Err(DriveError::new(
                DriveErrorKind::Uncertain,
                "Drive upload progress is uncertain; check status before retrying",
            )
            .into());
        }
    }
}
fn cancelled() -> DriveError {
    DriveError::new(
        DriveErrorKind::Cancelled,
        "Upload canceled; any completed file remains in Drive. Check status before retrying.",
    )
}
