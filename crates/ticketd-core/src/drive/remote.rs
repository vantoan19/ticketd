//! Google Drive as the remote file storage of Workspace sync.
//!
//! Everything lives in a visible folder this app created, under `drive.file`.
//! Files and folders are identified by `appProperties`, never by name. Sync
//! updates only files it created there; it never deletes or shares anything.
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;

use super::provider::metadata_error;
use super::upload_provider::{safe_session_url, send_chunks};
use super::{
    CredentialStore, DriveError, DriveErrorKind, DriveRequest, DriveResponse, DriveTransport,
    GoogleDrive, valid_file_id,
};
use crate::sync::remote::{
    RemoteContent, RemoteError, RemoteFile, RemoteFolder, RemoteKey, RemoteKind, RemoteRevision,
    RemoteStorage, digest, invalid_identifier, valid_identifier,
};

const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER: &str = "application/vnd.google-apps.folder";
const FILE_FIELDS: &str =
    "id,name,mimeType,size,headRevisionId,sha256Checksum,createdTime,trashed,appProperties";
/// Download range size; the transport refuses response bodies above 1 MiB.
const CHUNK: u64 = 256 * 1024;
const MAX_RETRIES: u32 = 4;

// appProperties keys. Folders carry SYNC + ROLE, files carry KIND + ID.
const SYNC: &str = "ticketdSync";
const ROLE: &str = "ticketdRole";
const KIND: &str = "ticketdKind";
const ID: &str = "ticketdId";

impl From<DriveError> for RemoteError {
    fn from(error: DriveError) -> Self {
        match error.kind {
            DriveErrorKind::Reauthorize => Self::Unauthorized,
            DriveErrorKind::Offline => Self::Offline,
            DriveErrorKind::RateLimited => Self::RateLimited { retry_after: None },
            DriveErrorKind::Unconfigured
            | DriveErrorKind::SelectFile
            | DriveErrorKind::PermissionDenied
            | DriveErrorKind::Missing
            | DriveErrorKind::InaccessibleOrMissing
            | DriveErrorKind::Unsupported
            | DriveErrorKind::InvalidResponse
            | DriveErrorKind::Cancelled
            | DriveErrorKind::Uncertain => Self::Other(error.message),
        }
    }
}

#[derive(Clone)]
struct Folders {
    root: String,
    attachments: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    mime_type: String,
    size: Option<String>,
    head_revision_id: Option<String>,
    sha256_checksum: Option<String>,
    #[serde(default)]
    created_time: String,
    trashed: Option<bool>,
    #[serde(default)]
    app_properties: HashMap<String, String>,
}

impl Entry {
    /// Duplicates of one identity resolve to the same, oldest entry on every device.
    fn age(&self) -> (&str, &str) {
        (&self.created_time, &self.id)
    }

    fn key(&self) -> Option<RemoteKey> {
        let kind = RemoteKind::parse(self.app_properties.get(KIND)?)?;
        let id = self.app_properties.get(ID)?;
        valid_identifier(id).then(|| RemoteKey::new(kind, id.clone()))
    }

    /// `None` for folders, foreign files and uploads that have no content yet.
    fn file(&self) -> Option<RemoteFile> {
        Some(RemoteFile {
            key: self.key()?,
            name: self.name.clone(),
            version: self.head_revision_id.clone()?,
            size: self.size.as_deref()?.parse().ok()?,
        })
    }
}

/// [`RemoteStorage`] on the Drive transport and OAuth boundary. One value
/// serves any number of Workspace folders of the connected account.
pub struct DriveRemote<'a> {
    drive: GoogleDrive<'a>,
    pause: Box<dyn Fn(Duration) + Send + Sync + 'a>,
    bearer: Mutex<Option<Vec<(String, String)>>>,
    folders: Mutex<HashMap<String, Folders>>,
    files: Mutex<HashMap<(String, RemoteKey), String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn unreadable() -> RemoteError {
    RemoteError::Other("Google Drive returned an unreadable response".into())
}

fn json<T: DeserializeOwned>(response: &DriveResponse) -> Result<T, RemoteError> {
    serde_json::from_slice(&response.body).map_err(|_| unreadable())
}

fn header<'r>(response: &'r DriveResponse, name: &str) -> Option<&'r str> {
    response
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn url(path: &str, parameters: &[(&str, &str)]) -> Result<String, RemoteError> {
    url::Url::parse_with_params(&format!("{API}/{path}"), parameters)
        .map(String::from)
        .map_err(|_| unreadable())
}

fn property(key: &str, value: &str) -> String {
    format!("appProperties has {{ key='{key}' and value='{value}' }}")
}

fn response_error(response: &DriveResponse) -> RemoteError {
    let body: serde_json::Value = serde_json::from_slice(&response.body).unwrap_or_default();
    let has_reason = |wanted: &[&str]| {
        body["error"]["errors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|error| error["reason"].as_str())
            .any(|reason| wanted.contains(&reason))
    };
    let retry_after = header(response, "retry-after")
        .and_then(|seconds| seconds.trim().parse().ok())
        .map(Duration::from_secs);
    match response.status {
        401 => RemoteError::Unauthorized,
        403 if has_reason(&["storageQuotaExceeded", "teamDriveFileLimitExceeded"]) => {
            RemoteError::StorageFull
        }
        429 => RemoteError::RateLimited { retry_after },
        403 if has_reason(&[
            "rateLimitExceeded",
            "userRateLimitExceeded",
            "dailyLimitExceeded",
        ]) =>
        {
            RemoteError::RateLimited { retry_after }
        }
        500..=599 => RemoteError::Offline,
        _ => RemoteError::Other(metadata_error(response).message),
    }
}

/// Exponential backoff with jitter: between half and all of 1 s, 2 s, 4 s…,
/// and never shorter than the wait the server asked for.
fn backoff(attempt: u32, retry_after: Option<Duration>) -> Duration {
    let ceiling = 1000_u64 << attempt.min(5);
    let jitter = uuid::Uuid::new_v4().as_u128() % u128::from(ceiling / 2 + 1);
    Duration::from_millis(ceiling / 2 + jitter as u64).max(retry_after.unwrap_or_default())
}

fn content_type(kind: RemoteKind) -> &'static str {
    match kind {
        RemoteKind::Ticket | RemoteKind::Document | RemoteKind::Plan | RemoteKind::Project => {
            "text/markdown"
        }
        RemoteKind::Attachment => "application/octet-stream",
        RemoteKind::Devices => "application/json",
    }
}

fn check(folder: &str, key: Option<&RemoteKey>) -> Result<(), RemoteError> {
    if valid_identifier(folder) && key.is_none_or(|key| valid_identifier(&key.id)) {
        Ok(())
    } else {
        Err(invalid_identifier())
    }
}

impl<'a> DriveRemote<'a> {
    pub fn new(
        connection_id: &'a str,
        vault: &'a dyn CredentialStore,
        transport: &'a dyn DriveTransport,
    ) -> Self {
        Self {
            drive: GoogleDrive::new(connection_id, vault, transport),
            pause: Box::new(std::thread::sleep),
            bearer: Mutex::new(None),
            folders: Mutex::new(HashMap::new()),
            files: Mutex::new(HashMap::new()),
        }
    }

    /// Replace the wait between retries, so tests control time.
    pub fn with_pause(mut self, pause: impl Fn(Duration) + Send + Sync + 'a) -> Self {
        self.pause = Box::new(pause);
        self
    }

    fn authorization(&self) -> Result<Vec<(String, String)>, RemoteError> {
        let mut bearer = lock(&self.bearer);
        match &*bearer {
            Some(headers) => Ok(headers.clone()),
            None => {
                let headers = self.drive.authorization()?;
                *bearer = Some(headers.clone());
                Ok(headers)
            }
        }
    }

    /// Sends with the cached access token, renews it once when refused, and
    /// retries rate limits and server failures with backoff. Returns
    /// successes, 404 and 409; every other status is an error.
    fn send(
        &self,
        method: &'static str,
        url: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> Result<DriveResponse, RemoteError> {
        let mut renewed = false;
        let mut attempt = 0;
        loop {
            let mut all = headers.to_vec();
            all.extend(self.authorization()?);
            let response = self.drive.transport.send(DriveRequest {
                method,
                url: url.into(),
                headers: all,
                body: body.to_vec(),
            })?;
            let error = match response.status {
                200..=399 | 404 | 409 => return Ok(response),
                401 if !renewed => {
                    renewed = true;
                    *lock(&self.bearer) = None;
                    continue;
                }
                _ => response_error(&response),
            };
            let retry_after = match &error {
                RemoteError::RateLimited { retry_after } => *retry_after,
                RemoteError::Offline => None,
                _ => return Err(error),
            };
            if attempt == MAX_RETRIES {
                return Err(error);
            }
            (self.pause)(backoff(attempt, retry_after));
            attempt += 1;
        }
    }

    fn get(&self, url: &str) -> Result<DriveResponse, RemoteError> {
        self.send("GET", url, &[], &[])
    }

    /// Every match of a `files.list` query, across pages.
    fn query(&self, q: &str) -> Result<Vec<Entry>, RemoteError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Page {
            #[serde(default)]
            files: Vec<Entry>,
            next_page_token: Option<String>,
        }
        let fields = format!("nextPageToken,files({FILE_FIELDS})");
        let mut entries = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut parameters = vec![
                ("q", q),
                ("fields", fields.as_str()),
                ("pageSize", "500"),
                ("spaces", "drive"),
            ];
            if let Some(token) = &token {
                parameters.push(("pageToken", token));
            }
            let response = self.get(&url("files", &parameters)?)?;
            if response.status != 200 {
                return Err(response_error(&response));
            }
            let page: Page = json(&response)?;
            entries.extend(page.files);
            token = page.next_page_token;
            if token.is_none() {
                return Ok(entries);
            }
        }
    }

    fn entry(&self, id: &str) -> Result<Option<Entry>, RemoteError> {
        let response = self.get(&url(
            &format!("files/{id}"),
            &[("supportsAllDrives", "true"), ("fields", FILE_FIELDS)],
        )?)?;
        match response.status {
            200 => Ok(Some(json(&response)?)),
            404 => Ok(None),
            _ => Err(response_error(&response)),
        }
    }

    fn reserve(&self) -> Result<String, RemoteError> {
        #[derive(Deserialize)]
        struct Ids {
            ids: Vec<String>,
        }
        let response = self.get(&format!(
            "{API}/files/generateIds?count=1&space=drive&type=files"
        ))?;
        if response.status != 200 {
            return Err(response_error(&response));
        }
        match json::<Ids>(&response)?.ids.as_slice() {
            [id] if valid_file_id(id) => Ok(id.clone()),
            _ => Err(unreadable()),
        }
    }

    /// The Drive folders of a Workspace folder. `list` looks them up afresh so
    /// a folder removed in Drive is noticed; other calls reuse the last answer.
    fn resolve(&self, folder: &str, cached: bool) -> Result<Folders, RemoteError> {
        if cached && let Some(folders) = lock(&self.folders).get(folder) {
            return Ok(folders.clone());
        }
        let entries = self.query(&format!("{} and trashed=false", property(SYNC, folder)))?;
        let pick = |role: &str| {
            entries
                .iter()
                .filter(|entry| {
                    entry.mime_type == FOLDER
                        && entry.app_properties.get(ROLE).map(String::as_str) == Some(role)
                })
                .min_by(|a, b| a.age().cmp(&b.age()))
                .map(|entry| entry.id.clone())
        };
        let Some(root) = pick("workspace") else {
            lock(&self.folders).remove(folder);
            return Err(RemoteError::FolderMissing);
        };
        let folders = Folders {
            root,
            attachments: pick("attachments"),
        };
        lock(&self.folders).insert(folder.into(), folders.clone());
        Ok(folders)
    }

    /// A pre-generated ID makes a repeated creation answer 409 instead of
    /// adding a second folder.
    fn create_folder(
        &self,
        folder: &str,
        role: &str,
        name: &str,
        parent: Option<&str>,
    ) -> Result<String, RemoteError> {
        let id = self.reserve()?;
        let mut metadata = serde_json::json!({
            "id": id,
            "name": name,
            "mimeType": FOLDER,
            "appProperties": { SYNC: folder, ROLE: role },
        });
        if let Some(parent) = parent {
            metadata["parents"] = serde_json::json!([parent]);
        }
        let response = self.send(
            "POST",
            &format!("{API}/files?supportsAllDrives=true&fields=id"),
            &[(
                "Content-Type".into(),
                "application/json; charset=UTF-8".into(),
            )],
            metadata.to_string().as_bytes(),
        )?;
        match response.status {
            404 => Err(self.folder_gone(folder)),
            _ => Ok(id),
        }
    }

    fn folder_gone(&self, folder: &str) -> RemoteError {
        lock(&self.folders).remove(folder);
        RemoteError::FolderMissing
    }

    fn attachments_folder(&self, folder: &str, folders: &Folders) -> Result<String, RemoteError> {
        if let Some(id) = &folders.attachments {
            return Ok(id.clone());
        }
        let id = self.create_folder(folder, "attachments", "attachments", Some(&folders.root))?;
        if let Some(cached) = lock(&self.folders).get_mut(folder) {
            cached.attachments = Some(id.clone());
        }
        Ok(id)
    }

    /// The file as Drive stores it now, or `None` when it is missing or trashed.
    fn current(
        &self,
        folder: &str,
        folders: &Folders,
        key: &RemoteKey,
    ) -> Result<Option<Entry>, RemoteError> {
        let cache_key = (folder.to_owned(), key.clone());
        let known = lock(&self.files).get(&cache_key).cloned();
        if let Some(id) = known {
            match self.entry(&id)? {
                Some(entry) if entry.trashed != Some(true) && entry.file().is_some() => {
                    return Ok(Some(entry));
                }
                _ => lock(&self.files).remove(&cache_key),
            };
        }
        let parent = match (key.kind, &folders.attachments) {
            (RemoteKind::Attachment, Some(attachments)) => attachments,
            (RemoteKind::Attachment, None) => return Ok(None),
            _ => &folders.root,
        };
        let found = self
            .query(&format!(
                "'{parent}' in parents and {} and {} and trashed=false",
                property(KIND, key.kind.as_str()),
                property(ID, &key.id)
            ))?
            .into_iter()
            .filter(|entry| entry.file().is_some())
            .min_by(|a, b| a.age().cmp(&b.age()));
        if let Some(entry) = &found {
            lock(&self.files).insert(cache_key, entry.id.clone());
        }
        Ok(found)
    }

    fn file_id(&self, folder: &str, key: &RemoteKey) -> Result<String, RemoteError> {
        let cache_key = (folder.to_owned(), key.clone());
        if let Some(id) = lock(&self.files).get(&cache_key) {
            return Ok(id.clone());
        }
        let folders = self.resolve(folder, true)?;
        Ok(self
            .current(folder, &folders, key)?
            .ok_or(RemoteError::NotFound)?
            .id)
    }

    fn forget(&self, folder: &str, key: &RemoteKey) {
        lock(&self.files).remove(&(folder.to_owned(), key.clone()));
    }

    /// Opens a resumable session with `method` on `target`, sends the content
    /// and returns the stored file, or the 404 or 409 status with which Drive
    /// refused to open the session.
    fn upload(
        &self,
        method: &'static str,
        target: &str,
        metadata: &serde_json::Value,
        kind: RemoteKind,
        size: u64,
        content: &mut dyn RemoteContent,
    ) -> Result<Result<Entry, u16>, RemoteError> {
        let opened = self.send(
            method,
            &format!("{target}?uploadType=resumable&supportsAllDrives=true&fields={FILE_FIELDS}"),
            &[
                (
                    "Content-Type".into(),
                    "application/json; charset=UTF-8".into(),
                ),
                ("X-Upload-Content-Type".into(), content_type(kind).into()),
                ("X-Upload-Content-Length".into(), size.to_string()),
            ],
            metadata.to_string().as_bytes(),
        )?;
        if matches!(opened.status, 404 | 409) {
            return Ok(Err(opened.status));
        }
        let session = header(&opened, "location")
            .filter(|location| safe_session_url(location))
            .ok_or_else(unreadable)?;
        let response = send_chunks(
            size,
            content,
            &mut |range, bytes| {
                self.send(
                    "PUT",
                    session,
                    &[
                        ("Content-Type".into(), content_type(kind).into()),
                        ("Content-Range".into(), range),
                    ],
                    &bytes,
                )
            },
            &mut |_| Ok(()),
        )?;
        if !matches!(response.status, 200 | 201) {
            return Err(RemoteError::Other(
                "Google Drive did not complete the upload; it will be retried".into(),
            ));
        }
        let stored: Entry = json(&response)?;
        if stored.head_revision_id.is_some() {
            return Ok(Ok(stored));
        }
        Ok(Ok(self.entry(&stored.id)?.ok_or_else(unreadable)?))
    }

    /// Live-check probe, not part of sync: whether `changes.list` reports this
    /// app's files under `drive.file`. `None` returns a start token and no
    /// IDs; a token returns the IDs of files changed since it and the next token.
    pub fn changed_file_ids(
        &self,
        page_token: Option<&str>,
    ) -> Result<(Vec<String>, String), RemoteError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Start {
            start_page_token: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Change {
            file_id: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Page {
            #[serde(default)]
            changes: Vec<Change>,
            next_page_token: Option<String>,
            new_start_page_token: Option<String>,
        }
        let ok = |response: DriveResponse| match response.status {
            200 => Ok(response),
            _ => Err(response_error(&response)),
        };
        let Some(mut token) = page_token.map(str::to_owned) else {
            let response = ok(self.get(&format!("{API}/changes/startPageToken"))?)?;
            return Ok((Vec::new(), json::<Start>(&response)?.start_page_token));
        };
        let mut ids = Vec::new();
        loop {
            let response = ok(self.get(&url(
                "changes",
                &[
                    ("pageToken", token.as_str()),
                    ("spaces", "drive"),
                    ("pageSize", "500"),
                    ("fields", "nextPageToken,newStartPageToken,changes(fileId)"),
                ],
            )?)?)?;
            let page: Page = json(&response)?;
            ids.extend(page.changes.into_iter().filter_map(|change| change.file_id));
            match (page.next_page_token, page.new_start_page_token) {
                (Some(next), _) => token = next,
                (None, Some(start)) => return Ok((ids, start)),
                (None, None) => return Err(unreadable()),
            }
        }
    }
}

impl RemoteStorage for DriveRemote<'_> {
    fn folders(&self) -> Result<Vec<RemoteFolder>, RemoteError> {
        let entries = self.query(&format!(
            "mimeType='{FOLDER}' and {} and trashed=false",
            property(ROLE, "workspace")
        ))?;
        let mut oldest: BTreeMap<String, &Entry> = BTreeMap::new();
        for entry in &entries {
            let Some(id) = entry
                .app_properties
                .get(SYNC)
                .filter(|id| valid_identifier(id))
            else {
                continue;
            };
            let kept = oldest.entry(id.clone()).or_insert(entry);
            if entry.age() < kept.age() {
                *kept = entry;
            }
        }
        Ok(oldest
            .into_iter()
            .map(|(id, entry)| RemoteFolder {
                id,
                name: entry.name.clone(),
            })
            .collect())
    }

    fn ensure_folder(&self, folder: &str, name: &str) -> Result<(), RemoteError> {
        check(folder, None)?;
        let root = match self.resolve(folder, false) {
            Ok(Folders {
                attachments: Some(_),
                ..
            }) => return Ok(()),
            Ok(folders) => folders.root,
            Err(RemoteError::FolderMissing) => {
                self.create_folder(folder, "workspace", name, None)?
            }
            Err(error) => return Err(error),
        };
        let attachments = self.create_folder(folder, "attachments", "attachments", Some(&root))?;
        lock(&self.folders).insert(
            folder.into(),
            Folders {
                root,
                attachments: Some(attachments),
            },
        );
        Ok(())
    }

    // ponytail: a full listing per poll (one request per 500 files). Switch to
    // `changes.list` or a `modifiedTime` filter if the live check shows it works
    // under `drive.file` and Workspaces grow large.
    fn list(&self, folder: &str) -> Result<Vec<RemoteFile>, RemoteError> {
        check(folder, None)?;
        let folders = self.resolve(folder, false)?;
        let parents = match &folders.attachments {
            Some(attachments) => {
                format!(
                    "('{}' in parents or '{attachments}' in parents)",
                    folders.root
                )
            }
            None => format!("'{}' in parents", folders.root),
        };
        let entries = self.query(&format!("{parents} and trashed=false"))?;
        let mut oldest: BTreeMap<RemoteKey, (&Entry, RemoteFile)> = BTreeMap::new();
        for entry in &entries {
            let Some(file) = entry.file() else { continue };
            match oldest.get(&file.key) {
                Some((kept, _)) if kept.age() <= entry.age() => {}
                _ => {
                    oldest.insert(file.key.clone(), (entry, file));
                }
            }
        }
        let mut ids = lock(&self.files);
        Ok(oldest
            .into_values()
            .map(|(entry, file)| {
                ids.insert((folder.to_owned(), file.key.clone()), entry.id.clone());
                file
            })
            .collect())
    }

    fn download(
        &self,
        folder: &str,
        key: &RemoteKey,
        version: &str,
        output: &mut dyn Write,
    ) -> Result<(), RemoteError> {
        check(folder, Some(key))?;
        if !valid_file_id(version) {
            return Err(RemoteError::NotFound);
        }
        #[derive(Deserialize)]
        struct Revision {
            size: Option<String>,
        }
        let id = self.file_id(folder, key)?;
        let revision = format!("{API}/files/{id}/revisions/{version}");
        let response = self.get(&format!("{revision}?fields=id,size"))?;
        if response.status != 200 {
            self.forget(folder, key);
            return Err(RemoteError::NotFound);
        }
        let size: u64 = json::<Revision>(&response)?
            .size
            .and_then(|size| size.parse().ok())
            .ok_or_else(unreadable)?;
        let mut offset = 0;
        while offset < size {
            let length = (size - offset).min(CHUNK);
            let response = self.send(
                "GET",
                &format!("{revision}?alt=media"),
                &[(
                    "Range".into(),
                    format!("bytes={offset}-{}", offset + length - 1),
                )],
                &[],
            )?;
            let whole = response.status == 200 && offset == 0 && length == size;
            if response.status == 404 {
                return Err(RemoteError::NotFound);
            }
            if !(response.status == 206 || whole) || response.body.len() as u64 != length {
                return Err(RemoteError::Other(
                    "Google Drive returned incomplete download bytes; it will be retried".into(),
                ));
            }
            output
                .write_all(&response.body)
                .map_err(|_| RemoteError::Other("cannot write the downloaded bytes".into()))?;
            offset += length;
        }
        Ok(())
    }

    // ponytail: Drive v3 has no conditional update, so the version is checked
    // just before the upload. A write by another device inside that window is
    // replaced as the head revision (it stays in the file's Drive revisions).
    // Close the window with a per-file lock file if it ever shows up in practice.
    fn write(
        &self,
        folder: &str,
        key: &RemoteKey,
        name: &str,
        expected: Option<&str>,
        content: &mut dyn RemoteContent,
    ) -> Result<RemoteFile, RemoteError> {
        check(folder, Some(key))?;
        let (hash, size) = digest(content)?;
        let folders = self.resolve(folder, true)?;
        let current = self.current(folder, &folders, key)?;
        let stored = current.as_ref().and_then(Entry::file);
        let uploaded = match (&current, expected) {
            (Some(entry), _) if entry.sha256_checksum.as_deref() == Some(hash.as_str()) => {
                return stored.ok_or_else(unreadable);
            }
            (None, None) => {
                let parent = match key.kind {
                    RemoteKind::Attachment => self.attachments_folder(folder, &folders)?,
                    _ => folders.root.clone(),
                };
                let id = self.reserve()?;
                let metadata = serde_json::json!({
                    "id": id,
                    "name": name,
                    "mimeType": content_type(key.kind),
                    "parents": [parent],
                    "appProperties": { KIND: key.kind.as_str(), ID: key.id },
                });
                match self.upload("POST", UPLOAD, &metadata, key.kind, size, content)? {
                    Ok(entry) => entry,
                    Err(404) => return Err(self.folder_gone(folder)),
                    // The reserved ID exists: an earlier attempt already stored it.
                    Err(_) => self.entry(&id)?.ok_or_else(unreadable)?,
                }
            }
            (Some(entry), Some(version)) if entry.head_revision_id.as_deref() == Some(version) => {
                let target = format!("{UPLOAD}/{}", entry.id);
                let metadata = serde_json::json!({ "name": name });
                match self.upload("PATCH", &target, &metadata, key.kind, size, content)? {
                    Ok(entry) => entry,
                    Err(_) => {
                        self.forget(folder, key);
                        return Err(RemoteError::PreconditionFailed { current: None });
                    }
                }
            }
            _ => return Err(RemoteError::PreconditionFailed { current: stored }),
        };
        lock(&self.files).insert((folder.to_owned(), key.clone()), uploaded.id.clone());
        Ok(RemoteFile {
            key: key.clone(),
            name: name.into(),
            version: uploaded.head_revision_id.ok_or_else(unreadable)?,
            size,
        })
    }

    fn revisions(&self, folder: &str, key: &RemoteKey) -> Result<Vec<RemoteRevision>, RemoteError> {
        check(folder, Some(key))?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Revision {
            id: String,
            #[serde(default)]
            modified_time: String,
            size: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Page {
            #[serde(default)]
            revisions: Vec<Revision>,
            next_page_token: Option<String>,
        }
        let id = self.file_id(folder, key)?;
        let mut revisions = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut parameters = vec![
                ("pageSize", "200"),
                ("fields", "nextPageToken,revisions(id,modifiedTime,size)"),
            ];
            if let Some(token) = &token {
                parameters.push(("pageToken", token));
            }
            let response = self.get(&url(&format!("files/{id}/revisions"), &parameters)?)?;
            if response.status != 200 {
                self.forget(folder, key);
                return Err(RemoteError::NotFound);
            }
            let page: Page = json(&response)?;
            revisions.extend(page.revisions.into_iter().map(|revision| {
                RemoteRevision {
                    version: revision.id,
                    modified: revision.modified_time,
                    size: revision
                        .size
                        .and_then(|size| size.parse().ok())
                        .unwrap_or_default(),
                }
            }));
            token = page.next_page_token;
            if token.is_none() {
                return Ok(revisions);
            }
        }
    }
}
