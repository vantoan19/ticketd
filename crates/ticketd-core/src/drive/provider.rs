use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::client::{DriveClient, Failure, Retry, invalid_response, response_error};
use super::{
    AttachmentProvider, DriveError, DriveErrorKind, DriveMetadata, valid_file_id, validate_metadata,
};

pub const DRIVE_FILE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

// Never derive Debug on credentials or on transport bodies/headers.
#[derive(Serialize, Deserialize)]
pub struct DriveCredential {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub refresh_token: String,
}

pub trait CredentialStore: Send + Sync {
    fn load(&self, connection_id: &str) -> Result<DriveCredential, DriveError>;
    fn save(&self, connection_id: &str, credential: &DriveCredential) -> Result<(), DriveError>;
}

/// OS-user credentials shared by desktop and standalone CLI, never workspace files.
pub struct PlatformCredentialStore;

fn vault_entry(id: &str) -> Result<keyring::Entry, DriveError> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(vault_error());
    }
    keyring::Entry::new("ticketd.google-drive.v1", id).map_err(|_| vault_error())
}
fn vault_error() -> DriveError {
    DriveError::new(
        DriveErrorKind::Reauthorize,
        "Drive credentials are unavailable in this OS user's secure store; unlock the store or select the file in ticketd's Google Drive tab",
    )
}
impl CredentialStore for PlatformCredentialStore {
    fn load(&self, id: &str) -> Result<DriveCredential, DriveError> {
        let value = vault_entry(id)?.get_password().map_err(|_| vault_error())?;
        serde_json::from_str(&value).map_err(|_| vault_error())
    }
    fn save(&self, id: &str, credential: &DriveCredential) -> Result<(), DriveError> {
        let value = serde_json::to_string(credential).map_err(|_| vault_error())?;
        vault_entry(id)?
            .set_password(&value)
            .map_err(|_| vault_error())
    }
}

#[derive(Clone)]
pub struct DriveRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
impl std::fmt::Debug for DriveRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DriveRequest")
            .field("method", &self.method)
            .finish_non_exhaustive()
    }
}
pub struct DriveResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub headers: Vec<(String, String)>,
}
pub trait DriveTransport: Send + Sync {
    fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError>;
}

/// Whether [`GoogleTransport`] sends a request. Defense in depth: bearer and
/// refresh credentials never reach redirects or caller-supplied URLs. Tests run
/// every request the adapters build through this, so a mismatch fails a test.
pub fn request_allowed(method: &str, url: &str) -> bool {
    const FILES: &str = "https://www.googleapis.com/drive/v3/files";
    match method {
        "POST" if url == "https://oauth2.googleapis.com/token" => true,
        "POST" | "PUT" | "PATCH" if super::client::safe_session_url(url) => true,
        // Metadata-only creation of the Workspace sync folders.
        "POST" => url.starts_with(&format!("{FILES}?")),
        "GET" => {
            url.strip_prefix(FILES)
                .is_some_and(|rest| rest.starts_with(['/', '?']))
                || url.starts_with("https://www.googleapis.com/drive/v3/changes")
                // The account of a picker authorization, and of a sync sign-in.
                || matches!(
                    url.strip_prefix("https://www.googleapis.com/drive/v3/about?fields="),
                    Some("user(permissionId)" | "user(permissionId,emailAddress)")
                )
        }
        _ => false,
    }
}

pub struct GoogleTransport {
    agent: ureq::Agent,
}
impl Default for GoogleTransport {
    fn default() -> Self {
        Self {
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(30)))
                .http_status_as_error(false)
                .max_redirects(0)
                .max_redirects_will_error(false)
                .build()
                .into(),
        }
    }
}
impl DriveTransport for GoogleTransport {
    fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError> {
        if !request_allowed(request.method, &request.url) {
            return Err(DriveError::new(
                DriveErrorKind::Unsupported,
                "unsupported Drive request",
            ));
        }
        let response = if request.method == "GET" {
            let mut builder = self.agent.get(&request.url);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            builder.call()
        } else if request.method == "PATCH" {
            let mut builder = self.agent.patch(&request.url);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            builder.send(&request.body)
        } else if request.method == "PUT" {
            let mut builder = self.agent.put(&request.url);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            builder.send(&request.body)
        } else {
            let mut builder = self.agent.post(&request.url);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            builder.send(&request.body)
        };
        let mut response = response.map_err(|_| DriveError::new(DriveErrorKind::Offline, "cannot reach Google Drive; check your connection and retry; last-known details remain available"))?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(k, v)| {
                v.to_str()
                    .ok()
                    .map(|v| (k.as_str().to_owned(), v.to_owned()))
            })
            .collect();
        let body = response
            .body_mut()
            .with_config()
            .limit(1024 * 1024)
            .read_to_vec()
            .map_err(|_| invalid_response())?;
        Ok(DriveResponse {
            status,
            body,
            headers,
        })
    }
}

/// Attachment access to one Drive account, through the shared [`DriveClient`].
pub struct GoogleDrive<'a> {
    pub(super) client: DriveClient<'a>,
}
impl<'a> GoogleDrive<'a> {
    pub fn new(
        connection_id: &str,
        vault: &'a dyn CredentialStore,
        transport: &'a dyn DriveTransport,
    ) -> Self {
        Self {
            client: DriveClient::new(connection_id, vault, transport),
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub scope: Option<String>,
}
pub(crate) fn token_request(
    transport: &dyn DriveTransport,
    fields: &[(&str, &str)],
) -> Result<TokenResponse, DriveError> {
    let response = transport.send(DriveRequest {
        method: "POST",
        url: "https://oauth2.googleapis.com/token".into(),
        headers: vec![(
            "Content-Type".into(),
            "application/x-www-form-urlencoded".into(),
        )],
        body: url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields.iter().copied())
            .finish()
            .into_bytes(),
    })?;
    if response.status != 200 {
        if response.status == 429 {
            return Err(DriveError::new(
                DriveErrorKind::RateLimited,
                "Google authorization is rate limited; wait and retry",
            ));
        }
        if response.status >= 500 {
            return Err(DriveError::new(
                DriveErrorKind::Offline,
                "Google authorization is temporarily unavailable; retry later",
            ));
        }
        return Err(DriveError::new(
            DriveErrorKind::Reauthorize,
            "Google authorization expired or was refused; select the file again in ticketd's Google Drive tab",
        ));
    }
    let token: TokenResponse =
        serde_json::from_slice(&response.body).map_err(|_| invalid_response())?;
    if token.access_token.is_empty() {
        return Err(invalid_response());
    }
    if token
        .scope
        .as_deref()
        .is_some_and(|scope| scope != DRIVE_FILE_SCOPE)
    {
        return Err(DriveError::new(
            DriveErrorKind::Reauthorize,
            "Google must grant only drive.file; reconnect with a dedicated ticketd Desktop OAuth client",
        ));
    }
    Ok(token)
}

impl AttachmentProvider for GoogleDrive<'_> {
    fn metadata(&self, id: &str, resource_key: Option<&str>) -> Result<DriveMetadata, DriveError> {
        if !valid_file_id(id) || resource_key.is_some_and(|key| !valid_file_id(key)) {
            return Err(invalid_response());
        }
        let mut headers = Vec::new();
        if let Some(key) = resource_key {
            headers.push(("X-Goog-Drive-Resource-Keys".into(), format!("{id}/{key}")));
        }
        let response = self.client.send("GET", &format!("https://www.googleapis.com/drive/v3/files/{id}?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,resourceKey,trashed,isAppAuthorized"), &headers, &[], Retry::Never)?;
        if response.status != 200 {
            return Err(response_error(&response));
        }
        parse_metadata(id, resource_key, &response.body)
    }
}
pub(super) fn parse_metadata(
    id: &str,
    resource_key: Option<&str>,
    body: &[u8],
) -> Result<DriveMetadata, DriveError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct File {
        id: String,
        name: String,
        mime_type: String,
        size: Option<String>,
        web_view_link: Option<String>,
        resource_key: Option<String>,
        trashed: Option<bool>,
        is_app_authorized: Option<bool>,
    }
    let file: File = serde_json::from_slice(body).map_err(|_| invalid_response())?;
    if file.id != id {
        return Err(invalid_response());
    }
    if file.is_app_authorized == Some(false) {
        return Err(Failure::SelectFile.guidance());
    }
    if file.trashed == Some(true) {
        return Err(DriveError::new(
            DriveErrorKind::Missing,
            "the file is in Drive trash; restore it in Drive or choose another file",
        ));
    }
    let metadata = DriveMetadata {
        id: file.id,
        name: file.name,
        mime_type: file.mime_type,
        size_bytes: file
            .size
            .map(|v| v.parse())
            .transpose()
            .map_err(|_| invalid_response())?,
        web_url: file
            .web_view_link
            .unwrap_or_else(|| format!("https://drive.google.com/file/d/{id}/view")),
        resource_key: file
            .resource_key
            .or_else(|| resource_key.map(str::to_owned)),
    };
    validate_metadata(id, &metadata)?;
    Ok(metadata)
}

pub(crate) fn credential_lock(id: &str) -> Result<std::fs::File, DriveError> {
    // Only opaque IDs enter the lock filename; no credentials are written here.
    if !valid_file_id(id) {
        return Err(vault_error());
    }
    let directory = directories::ProjectDirs::from("", "ticketd", "ticketd")
        .ok_or_else(vault_error)?
        .data_local_dir()
        .join("drive-locks");
    std::fs::create_dir_all(&directory).map_err(|_| vault_error())?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join(format!("{id}.lock")))
        .map_err(|_| vault_error())?;
    fs2::FileExt::lock_exclusive(&lock).map_err(|_| vault_error())?;
    Ok(lock)
}
