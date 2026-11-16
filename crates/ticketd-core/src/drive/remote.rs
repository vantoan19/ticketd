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

use super::client::{ClientError, DriveClient, Failure, ReadError, Retry};
use super::{
    CredentialStore, DriveError, DriveErrorKind, DriveResponse, DriveTransport, valid_file_id,
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

// appProperties keys. Folders carry SYNC + ROLE, files carry KIND + ID.
const SYNC: &str = "ticketdSync";
const ROLE: &str = "ticketdRole";
const KIND: &str = "ticketdKind";
const ID: &str = "ticketdId";
/// ROLE of the Workspace folder itself; a subfolder's ROLE is its name.
const WORKSPACE: &str = "workspace";

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

impl From<ClientError> for RemoteError {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::Drive(error) => error.into(),
            ClientError::Refused(response) => refusal(&response),
            ClientError::Unreadable => unreadable(),
        }
    }
}

#[derive(Clone)]
struct Folders {
    root: String,
    /// Subfolder name to Drive ID: where new files of each kind are created.
    subfolders: HashMap<String, String>,
    /// Every Drive folder of the Workspace folder, duplicates included, so a
    /// file is found wherever a device put it.
    all: Vec<String>,
}

impl Folders {
    fn parents(&self) -> String {
        let terms: Vec<String> = self
            .all
            .iter()
            .map(|id| format!("'{id}' in parents"))
            .collect();
        format!("({})", terms.join(" or "))
    }
}

/// `docs/sync-file-format.md` names these folders; the device registry sits beside them.
fn subfolder(kind: RemoteKind) -> Option<&'static str> {
    match kind {
        RemoteKind::Ticket => Some("tickets"),
        RemoteKind::Document => Some("documents"),
        RemoteKind::Plan => Some("plans"),
        RemoteKind::Project => Some("projects"),
        RemoteKind::Automation => Some("automations"),
        RemoteKind::AutomationAgent => Some("automation_agents"),
        RemoteKind::Attachment => Some("attachments"),
        RemoteKind::Devices => None,
    }
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
            file_id: self.id.clone(),
            created: self.created_time.clone(),
        })
    }
}

/// [`RemoteStorage`] on the Drive transport and OAuth boundary. One value
/// serves any number of Workspace folders of the connected account.
pub struct DriveRemote<'a> {
    client: DriveClient<'a>,
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

fn url(path: &str, parameters: &[(&str, &str)]) -> Result<String, RemoteError> {
    url::Url::parse_with_params(&format!("{API}/{path}"), parameters)
        .map(String::from)
        .map_err(|_| unreadable())
}

fn property(key: &str, value: &str) -> String {
    format!("appProperties has {{ key='{key}' and value='{value}' }}")
}

/// What a status Drive refused with means to sync.
fn refusal(response: &DriveResponse) -> RemoteError {
    match Failure::of(response) {
        Failure::Unauthorized => RemoteError::Unauthorized,
        Failure::StorageFull => RemoteError::StorageFull,
        Failure::RateLimited { retry_after } => RemoteError::RateLimited { retry_after },
        Failure::Unavailable => RemoteError::Offline,
        other => RemoteError::Other(other.guidance().message),
    }
}

fn content_type(kind: RemoteKind) -> &'static str {
    match kind {
        RemoteKind::Ticket
        | RemoteKind::Document
        | RemoteKind::Plan
        | RemoteKind::Project
        | RemoteKind::Automation
        | RemoteKind::AutomationAgent => "text/markdown",
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
        connection_id: &str,
        vault: &'a dyn CredentialStore,
        transport: &'a dyn DriveTransport,
    ) -> Self {
        Self {
            client: DriveClient::new(connection_id, vault, transport),
            folders: Mutex::new(HashMap::new()),
            files: Mutex::new(HashMap::new()),
        }
    }

    /// Where a person sees the Workspace folder in Drive's own interface.
    /// `folder` is the Workspace folder identifier, checked like in every
    /// other call; a folder that is not in Drive is `FolderMissing`.
    pub fn folder_url(&self, folder: &str) -> Result<String, RemoteError> {
        check(folder, None)?;
        let root = self.resolve(folder, true)?.root;
        Ok(format!("https://drive.google.com/drive/folders/{root}"))
    }

    /// Replace the wait between retries, so tests control time.
    pub fn with_pause(mut self, pause: impl Fn(Duration) + Send + Sync + 'a) -> Self {
        self.client = self.client.with_pause(pause);
        self
    }

    /// Sends with the shared client, which renews the access token once when
    /// refused and retries rate limits and server failures with backoff.
    /// Returns successes, 404 and 409; every other status is an error.
    fn send(
        &self,
        method: &'static str,
        url: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> Result<DriveResponse, RemoteError> {
        let response = self
            .client
            .send(method, url, headers, body, Retry::Backoff)?;
        match response.status {
            200..=399 | 404 | 409 => Ok(response),
            _ => Err(refusal(&response)),
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
        self.client.pages(
            Retry::Backoff,
            &mut |token| {
                let mut parameters = vec![
                    ("q", q),
                    ("fields", fields.as_str()),
                    ("pageSize", "500"),
                    ("spaces", "drive"),
                ];
                if let Some(token) = token {
                    parameters.push(("pageToken", token));
                }
                url("files", &parameters)
            },
            &mut |response| {
                if response.status != 200 {
                    return Err(refusal(&response));
                }
                let page: Page = json(&response)?;
                entries.extend(page.files);
                Ok(page.next_page_token)
            },
        )?;
        Ok(entries)
    }

    fn entry(&self, id: &str) -> Result<Option<Entry>, RemoteError> {
        let response = self.get(&url(
            &format!("files/{id}"),
            &[("supportsAllDrives", "true"), ("fields", FILE_FIELDS)],
        )?)?;
        match response.status {
            200 => Ok(Some(json(&response)?)),
            404 => Ok(None),
            _ => Err(refusal(&response)),
        }
    }

    fn reserve(&self) -> Result<String, RemoteError> {
        Ok(self.client.reserve_id(Retry::Backoff)?)
    }

    /// The Drive folders of a Workspace folder. `list` looks them up afresh so
    /// a folder removed in Drive is noticed; other calls reuse the last answer.
    fn resolve(&self, folder: &str, cached: bool) -> Result<Folders, RemoteError> {
        if cached && let Some(folders) = lock(&self.folders).get(folder) {
            return Ok(folders.clone());
        }
        let entries = self.query(&format!("{} and trashed=false", property(SYNC, folder)))?;
        let mut found: Vec<&Entry> = entries
            .iter()
            .filter(|entry| entry.mime_type == FOLDER)
            .collect();
        // Oldest first, so every device picks the same folder among duplicates.
        found.sort_by(|a, b| a.age().cmp(&b.age()));
        let mut root = None;
        let mut subfolders = HashMap::new();
        for entry in &found {
            match entry.app_properties.get(ROLE).map(String::as_str) {
                Some(WORKSPACE) => {
                    root.get_or_insert_with(|| entry.id.clone());
                }
                Some(role) => {
                    subfolders
                        .entry(role.to_owned())
                        .or_insert_with(|| entry.id.clone());
                }
                None => {}
            }
        }
        let Some(root) = root else {
            return Err(self.folder_gone(folder));
        };
        let folders = Folders {
            root,
            subfolders,
            all: found.iter().map(|entry| entry.id.clone()).collect(),
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

    /// The Drive folder new files of `kind` go into. A subfolder removed in
    /// Drive is created again.
    fn parent(
        &self,
        folder: &str,
        folders: &Folders,
        kind: RemoteKind,
    ) -> Result<String, RemoteError> {
        let Some(name) = subfolder(kind) else {
            return Ok(folders.root.clone());
        };
        if let Some(id) = folders.subfolders.get(name) {
            return Ok(id.clone());
        }
        let id = self.create_folder(folder, name, name, Some(&folders.root))?;
        if let Some(cached) = lock(&self.folders).get_mut(folder) {
            cached.subfolders.insert(name.into(), id.clone());
            cached.all.push(id.clone());
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
        let found = self
            .query(&format!(
                "{} and {} and {} and trashed=false",
                folders.parents(),
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
        let session = match self.client.open_session(
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
            Retry::Backoff,
        ) {
            Ok(session) => session,
            Err(ClientError::Refused(response)) if matches!(response.status, 404 | 409) => {
                return Ok(Err(response.status));
            }
            Err(error) => return Err(error.into()),
        };
        let response = self
            .client
            .upload_chunks(
                &session,
                content_type(kind),
                size,
                content,
                Retry::Backoff,
                &mut |_| Ok(()),
            )
            .map_err(|error| match error {
                ClientError::Refused(response) if matches!(response.status, 404 | 409) => {
                    RemoteError::Other(
                        "Google Drive did not complete the upload; it will be retried".into(),
                    )
                }
                error => error.into(),
            })?;
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
            _ => Err(refusal(&response)),
        };
        let Some(token) = page_token else {
            let response = ok(self.get(&format!("{API}/changes/startPageToken"))?)?;
            return Ok((Vec::new(), json::<Start>(&response)?.start_page_token));
        };
        let mut ids = Vec::new();
        let mut start = None;
        self.client.pages(
            Retry::Backoff,
            &mut |next| {
                url(
                    "changes",
                    &[
                        ("pageToken", next.unwrap_or(token)),
                        ("spaces", "drive"),
                        ("pageSize", "500"),
                        ("fields", "nextPageToken,newStartPageToken,changes(fileId)"),
                    ],
                )
            },
            &mut |response| {
                let page: Page = json(&ok(response)?)?;
                ids.extend(page.changes.into_iter().filter_map(|change| change.file_id));
                match (page.next_page_token, page.new_start_page_token) {
                    (Some(next), _) => Ok(Some(next)),
                    (None, Some(newest)) => {
                        start = Some(newest);
                        Ok(None)
                    }
                    (None, None) => Err(unreadable()),
                }
            },
        )?;
        Ok((ids, start.ok_or_else(unreadable)?))
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
        let folders = match self.resolve(folder, false) {
            Ok(folders) => folders,
            Err(RemoteError::FolderMissing) => {
                let root = self.create_folder(folder, WORKSPACE, name, None)?;
                let folders = Folders {
                    root: root.clone(),
                    subfolders: HashMap::new(),
                    all: vec![root],
                };
                lock(&self.folders).insert(folder.into(), folders.clone());
                folders
            }
            Err(error) => return Err(error),
        };
        // Created up front by the one device that sets sync up, so two devices
        // do not each add a subfolder for their first file of a kind.
        for kind in RemoteKind::ALL {
            self.parent(folder, &folders, kind)?;
        }
        Ok(())
    }

    // ponytail: a full listing per poll (one request per 500 files). Switch to
    // `changes.list` or a `modifiedTime` filter if the live check shows it works
    // under `drive.file` and Workspaces grow large.
    fn list(&self, folder: &str) -> Result<Vec<RemoteFile>, RemoteError> {
        check(folder, None)?;
        let folders = self.resolve(folder, false)?;
        let entries = self.query(&format!("{} and trashed=false", folders.parents()))?;
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
        self.client
            .read_ranges(
                &format!("{revision}?alt=media"),
                &[],
                size,
                Retry::Backoff,
                output,
            )
            .map_err(|error| match error {
                ReadError::Client(ClientError::Refused(response)) if response.status == 404 => {
                    RemoteError::NotFound
                }
                ReadError::Client(error) => error.into(),
                ReadError::Output => RemoteError::Other("cannot write the downloaded bytes".into()),
                ReadError::ContentRange | ReadError::Length | ReadError::NotRanged => {
                    RemoteError::Other(
                        "Google Drive returned incomplete download bytes; it will be retried"
                            .into(),
                    )
                }
            })
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
                let parent = self.parent(folder, &folders, key.kind)?;
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
            _ => {
                return Err(RemoteError::PreconditionFailed {
                    current: stored.map(Box::new),
                });
            }
        };
        lock(&self.files).insert((folder.to_owned(), key.clone()), uploaded.id.clone());
        Ok(RemoteFile {
            key: key.clone(),
            name: name.into(),
            version: uploaded.head_revision_id.ok_or_else(unreadable)?,
            size,
            file_id: uploaded.id,
            created: uploaded.created_time,
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
        self.client.pages(
            Retry::Backoff,
            &mut |token| {
                let mut parameters = vec![
                    ("pageSize", "200"),
                    ("fields", "nextPageToken,revisions(id,modifiedTime,size)"),
                ];
                if let Some(token) = token {
                    parameters.push(("pageToken", token));
                }
                url(&format!("files/{id}/revisions"), &parameters)
            },
            &mut |response| {
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
                Ok(page.next_page_token)
            },
        )?;
        Ok(revisions)
    }
}
