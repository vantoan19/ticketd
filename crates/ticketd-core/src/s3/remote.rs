//! An S3 bucket as the remote file storage of Workspace sync (ADR 0018).
//!
//! A Workspace folder is the key prefix `<prefix><folder-id>/`, with a marker object that
//! holds its readable name. Records sit under the same subfolders as in Drive, keyed by GUID
//! (`tickets/<guid>.md`). A file's version is its VersionId, and the bucket's Versioning keeps
//! the past ones. Writes are conditional on the object (`If-None-Match: *` to create,
//! `If-Match` on the ETag to update), so S3 itself refuses a write over another device's.
//! Sync never deletes: a delete marker only appears when a person deletes in the bucket.
//! Files over [`SINGLE_PART_LIMIT`] upload in parts (see `parts`).
use std::collections::{BTreeMap, HashSet};
use std::io::{Read, SeekFrom, Write};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

use super::bucket_check::{self, BucketCheckError};
use super::client::{S3Call, S3Client, refusal};
use super::provider::{CredentialSource, S3Response, S3Target, S3TargetError, S3Transport, encode};
use super::xml::{Listed, prefixes_page, versions_page};
use crate::sync::remote::{
    RemoteCapabilities, RemoteContent, RemoteError, RemoteFile, RemoteFolder, RemoteKey,
    RemoteKind, RemoteRevision, RemoteStorage, invalid_identifier, valid_identifier,
};

mod parts;

/// A write up to this size is one PutObject. Larger Attachments upload in parts.
pub const SINGLE_PART_LIMIT: u64 = 16 * 1024 * 1024;
/// The size of one ranged read.
const CHUNK: u64 = 8 * 1024 * 1024;
/// Holds the Workspace folder's readable name.
const MARKER: &str = ".ticketd-folder";
/// User metadata: ticketd's own SHA-256 of the content, as hex.
const HASH_METADATA: &str = "x-amz-meta-ticketd-sha256";
/// A file no delete marker ever ended: S3 gives no identity, so this stands for it.
const FIRST_FILE: &str = "none";
const FIRST_FILE_TIME: &str = "1970-01-01T00:00:00.000Z";
/// How often a write starts over from reading the file, after S3 says it changed meanwhile.
const WRITE_ATTEMPTS: u32 = 5;

/// `docs/sync-file-format.md` names these folders; the device registry sits beside them.
fn subfolder(kind: RemoteKind) -> &'static str {
    match kind {
        RemoteKind::Ticket => "tickets",
        RemoteKind::Document => "documents",
        RemoteKind::Plan => "plans",
        RemoteKind::Project => "projects",
        RemoteKind::Automation => "automations",
        RemoteKind::AutomationAgent => "automation_agents",
        RemoteKind::Attachment => "attachments",
        RemoteKind::Devices => "devices",
    }
}

fn extension(kind: RemoteKind) -> &'static str {
    match kind {
        RemoteKind::Attachment => "",
        RemoteKind::Devices => ".json",
        // Listed one by one, so a new kind needs a decision about its file format.
        RemoteKind::Ticket
        | RemoteKind::Document
        | RemoteKind::Plan
        | RemoteKind::Project
        | RemoteKind::Automation
        | RemoteKind::AutomationAgent => ".md",
    }
}

fn content_type(kind: RemoteKind) -> &'static str {
    match kind {
        RemoteKind::Attachment => "application/octet-stream",
        RemoteKind::Devices => "application/json",
        RemoteKind::Ticket
        | RemoteKind::Document
        | RemoteKind::Plan
        | RemoteKind::Project
        | RemoteKind::Automation
        | RemoteKind::AutomationAgent => "text/markdown",
    }
}

/// `<guid>.md`: what a listing calls a file, since it cannot return the readable name.
fn file_name(key: &RemoteKey) -> String {
    format!("{}{}", key.id, extension(key.kind))
}

fn parse_file(path: &str) -> Option<RemoteKey> {
    let (folder, file) = path.split_once('/')?;
    let kind = RemoteKind::ALL
        .into_iter()
        .find(|kind| subfolder(*kind) == folder)?;
    let id = file.strip_suffix(extension(kind))?;
    valid_identifier(id).then(|| RemoteKey::new(kind, id))
}

fn check(folder: &str, key: Option<&RemoteKey>) -> Result<(), RemoteError> {
    if valid_identifier(folder) && key.is_none_or(|key| valid_identifier(&key.id)) {
        Ok(())
    } else {
        Err(invalid_identifier())
    }
}

fn unreadable() -> RemoteError {
    RemoteError::Other("S3 returned an unreadable response".into())
}

/// Moves a listing on to `next`, the cursor of its next page. A cursor that repeats would be
/// requested for ever, so it is an unreadable response.
fn advance<T: PartialEq>(cursor: &mut Option<T>, next: T) -> Result<(), RemoteError> {
    if cursor.as_ref() == Some(&next) {
        return Err(unreadable());
    }
    *cursor = Some(next);
    Ok(())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A VersionId is opaque to ticketd: AWS documents ids with `+` and other characters a URL
/// must encode, and the client encodes it as a query value. Only an empty or oversized id, or
/// one with a control character, names no version.
fn valid_version(version: &str) -> bool {
    !version.is_empty() && version.len() <= 1024 && !version.chars().any(char::is_control)
}

/// What a file is now: the current version, with the ETag a conditional update names.
struct Stored {
    file: RemoteFile,
    etag: String,
}

/// Everything the version listing says about one key.
struct Lookup {
    key: RemoteKey,
    /// Newest first, as S3 lists them.
    entries: Vec<Listed>,
}

impl Lookup {
    /// The file's identity is its latest delete marker, so a lifecycle rule that removes old
    /// versions cannot change it.
    fn identity(&self) -> (String, String) {
        self.entries
            .iter()
            .find(|entry| entry.is_delete_marker())
            .map_or_else(
                || (FIRST_FILE.to_owned(), FIRST_FILE_TIME.to_owned()),
                |marker| (marker.version_id.clone(), marker.modified.clone()),
            )
    }

    /// `None` when the key was never written or its newest entry is a delete marker.
    fn stored(&self) -> Option<Stored> {
        let newest = self.entries.first()?;
        let content = newest.content.as_ref()?;
        let (file_id, created) = self.identity();
        Some(Stored {
            file: RemoteFile {
                key: self.key.clone(),
                name: file_name(&self.key),
                version: newest.version_id.clone(),
                size: content.size,
                file_id,
                created,
            },
            etag: content.etag.clone(),
        })
    }
}

/// The prefix with its trailing `/` added when it lacks one, or why the S3 storage would
/// refuse it. Whoever records a prefix checks it here, so no binding is made that cannot sync.
pub fn checked_prefix(prefix: &str) -> Result<String, S3TargetError> {
    let safe = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/');
    // A `.` or `..` segment is resolved by the URL, which would leave the bucket's path.
    let dot_segment = prefix
        .split('/')
        .any(|segment| matches!(segment, "." | ".."));
    if !prefix.bytes().all(safe) || prefix.starts_with('/') || prefix.contains("//") || dot_segment
    {
        return Err(S3TargetError::Prefix);
    }
    let normalized = if prefix.is_empty() || prefix.ends_with('/') {
        prefix.to_owned()
    } else {
        format!("{prefix}/")
    };
    // The limit is on the value kept, so whatever passes is accepted again where it is used.
    if normalized.len() > 512 {
        return Err(S3TargetError::Prefix);
    }
    Ok(normalized)
}

/// What a ranged read learned about an object while reading it.
struct Fetched {
    /// ticketd's SHA-256 from the object's metadata, if it has any (`aws s3 cp` drops it).
    recorded: Option<String>,
    computed: String,
}

/// [`RemoteStorage`] on an S3 bucket. One value serves any number of Workspace folders under
/// its prefix.
pub struct S3Remote<'a> {
    client: S3Client<'a>,
    prefix: String,
    /// The size of each part but the last of an upload in parts.
    part_size: u64,
    /// Folders whose marker was seen, so a write does not look for it every time. `list`
    /// looks afresh, so a folder removed from the bucket is noticed.
    known: Mutex<HashSet<String>>,
    /// Whether the bucket passed [`S3Remote::check_bucket`].
    checked: Mutex<Checked>,
}

/// The bucket check's pass, and how often it was cleared since this `S3Remote` began. A check
/// publishes its pass only if none was cleared while it ran: the bucket it probed may be
/// another bucket by then (Versioning suspended).
#[derive(Default)]
struct Checked {
    passed: bool,
    cleared: u64,
}

impl S3Remote<'static> {
    /// [`S3Remote::new`] for a remote that keeps its credentials and transport alive itself,
    /// so they go when it does.
    pub fn shared(
        target: S3Target,
        prefix: &str,
        credentials: Arc<dyn CredentialSource>,
        transport: Arc<dyn S3Transport>,
    ) -> Result<Self, S3TargetError> {
        let prefix = checked_prefix(prefix)?;
        Ok(Self::with_client(
            S3Client::shared(target, credentials, transport),
            prefix,
        ))
    }
}

impl<'a> S3Remote<'a> {
    /// `prefix` is where the Workspace folders go, such as `ticketd/`; a missing trailing
    /// `/` is added.
    pub fn new(
        target: S3Target,
        prefix: &str,
        credentials: &'a dyn CredentialSource,
        transport: &'a dyn S3Transport,
    ) -> Result<Self, S3TargetError> {
        let prefix = checked_prefix(prefix)?;
        Ok(Self::with_client(
            S3Client::new(target, credentials, transport),
            prefix,
        ))
    }

    fn with_client(client: S3Client<'a>, prefix: String) -> Self {
        Self {
            client,
            prefix,
            part_size: parts::PART_SIZE,
            known: Mutex::new(HashSet::new()),
            checked: Mutex::new(Checked::default()),
        }
    }

    /// Replace the wait between retries, so tests control time.
    pub fn with_pause(mut self, pause: impl Fn(Duration) + Send + Sync + 'a) -> Self {
        self.client = self.client.with_pause(pause);
        self
    }

    /// The size of each part of an upload in parts, at least the 5 MiB S3 requires. A file too
    /// big for 10,000 parts of this size gets bigger ones. Tests use it to keep fixtures small.
    pub fn with_part_size(mut self, size: u64) -> Self {
        self.part_size = size.max(parts::MIN_PART);
        self
    }

    pub fn target(&self) -> &S3Target {
        self.client.target()
    }

    /// The prefix the Workspace folders are under, with its trailing `/` (or empty).
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// Whether the bucket can sync a Workspace safely: Versioning on, conditional creates
    /// refused, and the profile allowed to read, write and list what sync uses. Writes one
    /// small object under the prefix and leaves it. After it passes once, this `S3Remote`
    /// does not check again.
    pub fn check_bucket(&self) -> Result<(), BucketCheckError> {
        let cleared = {
            let checked = lock(&self.checked);
            if checked.passed {
                return Ok(());
            }
            checked.cleared
        };
        bucket_check::run(&self.client, &self.prefix)?;
        let mut checked = lock(&self.checked);
        if checked.cleared == cleared {
            checked.passed = true;
        }
        Ok(())
    }

    /// The VersionId of a write S3 just committed. A write with none, or to the `null` version,
    /// has no stable revision: Versioning is off or was suspended after the bucket passed its
    /// check, so the check runs again at the next call. (Reading a `null` version made before
    /// Versioning was turned on is still fine.)
    fn committed_version(&self, response: &S3Response) -> Result<String, RemoteError> {
        match response.header("x-amz-version-id") {
            Some("null") => {
                let mut checked = lock(&self.checked);
                checked.passed = false;
                checked.cleared += 1;
                drop(checked);
                Err(RemoteError::Other(
                    "S3 stored the file in the bucket's null version, which the next write replaces; Versioning is suspended, so turn it on again".into(),
                ))
            }
            Some(version) if valid_version(version) => Ok(version.to_owned()),
            _ => Err(RemoteError::Other(
                "S3 stored the file without a version; turn on Versioning for the bucket".into(),
            )),
        }
    }

    /// The `s3://` address of a Workspace folder, for a person to open in another tool.
    pub fn folder_address(&self, folder: &str) -> Result<String, RemoteError> {
        check(folder, None)?;
        Ok(format!(
            "s3://{}/{}{folder}/",
            self.client.target().bucket(),
            self.prefix
        ))
    }

    fn folder_prefix(&self, folder: &str) -> String {
        format!("{}{folder}/", self.prefix)
    }

    fn marker_key(&self, folder: &str) -> String {
        format!("{}{MARKER}", self.folder_prefix(folder))
    }

    fn object_key(&self, folder: &str, key: &RemoteKey) -> String {
        format!(
            "{}{}/{}",
            self.folder_prefix(folder),
            subfolder(key.kind),
            file_name(key)
        )
    }

    fn forget(&self, folder: &str) -> RemoteError {
        lock(&self.known).remove(folder);
        RemoteError::FolderMissing
    }

    /// The Workspace folder's readable name, or `None` when it has no marker.
    fn read_marker(&self, folder: &str) -> Result<Option<String>, RemoteError> {
        let response = self
            .client
            .send(&S3Call::get(&self.marker_key(folder), &[]))?;
        match response.status {
            200 => Ok(Some(
                String::from_utf8_lossy(&response.body).trim().to_owned(),
            )),
            404 if super::client::error_of(&response).is_some_and(|e| e.code == "NoSuchKey") => {
                Ok(None)
            }
            _ => Err(refusal(&response)),
        }
    }

    /// Fails with `FolderMissing` unless the folder's marker is in the bucket.
    fn require_folder(&self, folder: &str) -> Result<(), RemoteError> {
        if lock(&self.known).contains(folder) {
            return Ok(());
        }
        if self.read_marker(folder)?.is_none() {
            return Err(RemoteError::FolderMissing);
        }
        lock(&self.known).insert(folder.to_owned());
        Ok(())
    }

    /// The entries S3 lists for exactly `object`, newest first, up to and including its latest
    /// delete marker: the versions below it belong to an earlier file, and nothing here reads
    /// them. S3 sorts the listing by key, so the entries are together and the pages end where
    /// they end.
    fn versions(&self, object: &str) -> Result<Vec<Listed>, RemoteError> {
        let mut found = Vec::new();
        let mut markers: Option<(String, Option<String>)> = None;
        loop {
            let mut query = vec![("versions", ""), ("prefix", object)];
            if let Some((key, version)) = &markers {
                query.push(("key-marker", key));
                if let Some(version) = version {
                    query.push(("version-id-marker", version));
                }
            }
            let response = self.client.send(&S3Call::get("", &query))?;
            if response.status != 200 {
                return Err(refusal(&response));
            }
            let page = versions_page(&response.body).ok_or_else(unreadable)?;
            let mut beyond = false;
            for entry in page.entries {
                if entry.key == object {
                    let marker = entry.is_delete_marker();
                    found.push(entry);
                    if marker {
                        return Ok(found);
                    }
                } else {
                    beyond = true;
                }
            }
            if beyond || !page.truncated {
                return Ok(found);
            }
            advance(
                &mut markers,
                (
                    page.next_key_marker.ok_or_else(unreadable)?,
                    page.next_version_marker,
                ),
            )?;
        }
    }

    fn lookup(&self, folder: &str, key: &RemoteKey) -> Result<Lookup, RemoteError> {
        Ok(Lookup {
            key: key.clone(),
            entries: self.versions(&self.object_key(folder, key))?,
        })
    }

    /// Reads one version into `output`, in ranges, and hashes what it read. `Ok(None)` when
    /// S3 has no such version.
    fn fetch(
        &self,
        object: &str,
        version: &str,
        output: &mut dyn Write,
    ) -> Result<Option<Fetched>, RemoteError> {
        let mut hasher = Sha256::new();
        let mut recorded = None;
        let mut offset = 0_u64;
        let mut total: Option<u64> = None;
        loop {
            let range = format!("bytes={offset}-{}", offset + CHUNK - 1);
            let ranged = [("range", range)];
            let query = [("versionId", version)];
            let mut call = S3Call::get(object, &query);
            call.headers = &ranged;
            let mut response = self.client.send(&call)?;
            if response.status == 416 && offset == 0 {
                // S3 refuses a range of an empty object.
                response = self.client.send(&S3Call::get(object, &query))?;
            }
            let from = offset;
            match response.status {
                206 => {
                    let (first, last, size) =
                        content_range(response.header("content-range")).ok_or_else(unreadable)?;
                    let consistent = first == from
                        && last - first + 1 == response.body.len() as u64
                        && total.is_none_or(|known| known == size);
                    if !consistent {
                        return Err(incomplete());
                    }
                    total = Some(size);
                }
                200 if offset == 0 => total = Some(response.body.len() as u64),
                404 | 405 => return Ok(None),
                400 if super::client::error_of(&response)
                    .is_some_and(|e| e.code == "InvalidArgument") =>
                {
                    return Ok(None);
                }
                _ => return Err(refusal(&response)),
            }
            if offset == 0 {
                recorded = response
                    .header(HASH_METADATA)
                    .map(str::to_ascii_lowercase)
                    .filter(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()));
            }
            hasher.update(&response.body);
            output
                .write_all(&response.body)
                .map_err(|_| RemoteError::Other("cannot write the downloaded bytes".into()))?;
            offset += response.body.len() as u64;
            let size = total.ok_or_else(unreadable)?;
            if offset > size || (response.body.is_empty() && offset < size) {
                return Err(incomplete());
            }
            if offset == size {
                return Ok(Some(Fetched {
                    recorded,
                    computed: hex(&hasher.finalize()),
                }));
            }
        }
    }

    /// Whether the stored version already holds these bytes. Its SHA-256 is in its metadata
    /// when ticketd wrote it; a file uploaded by hand has none, and is hashed from its bytes.
    fn holds(
        &self,
        object: &str,
        stored: &Stored,
        size: u64,
        hash: &str,
    ) -> Result<bool, RemoteError> {
        if stored.file.size != size {
            return Ok(false);
        }
        if size == 0 {
            return Ok(true);
        }
        let version = &stored.file.version;
        let query = [("versionId", version.as_str())];
        let first = [("range", "bytes=0-0".to_owned())];
        let mut call = S3Call::get(object, &query);
        call.headers = &first;
        let response = self.client.send(&call)?;
        match response.status {
            200 | 206 => {}
            404 | 405 => return Ok(false),
            _ => return Err(refusal(&response)),
        }
        if let Some(recorded) = response.header(HASH_METADATA) {
            return Ok(recorded.eq_ignore_ascii_case(hash));
        }
        Ok(self
            .fetch(object, version, &mut std::io::sink())?
            .is_some_and(|fetched| fetched.computed == hash))
    }
}

fn incomplete() -> RemoteError {
    RemoteError::Other("S3 returned incomplete download bytes; it will be retried".into())
}

/// `bytes 0-9/100` as `(0, 9, 100)`.
fn content_range(value: Option<&str>) -> Option<(u64, u64, u64)> {
    let (span, total) = value?.strip_prefix("bytes ")?.split_once('/')?;
    let (first, last) = span.split_once('-')?;
    let (first, last, total) = (first.parse().ok()?, last.parse().ok()?, total.parse().ok()?);
    (first <= last && last < total).then_some((first, last, total))
}

fn read_all(content: &mut dyn RemoteContent) -> Result<Vec<u8>, RemoteError> {
    let unreadable = |_| RemoteError::Other("cannot read the content to upload".into());
    content.seek(SeekFrom::Start(0)).map_err(unreadable)?;
    let mut bytes = Vec::new();
    content
        .take(SINGLE_PART_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(unreadable)?;
    content.seek(SeekFrom::Start(0)).map_err(unreadable)?;
    Ok(bytes)
}

impl RemoteStorage for S3Remote<'_> {
    fn capabilities(&self) -> RemoteCapabilities {
        // S3 refuses an update whose ETag moved, and a create over an existing object.
        RemoteCapabilities {
            conditional_writes: true,
            keeps_revisions: true,
        }
    }

    fn check_usable(&self) -> Result<(), RemoteError> {
        Ok(self.check_bucket()?)
    }

    fn folders(&self) -> Result<Vec<RemoteFolder>, RemoteError> {
        let mut ids = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut query = vec![
                ("list-type", "2"),
                ("prefix", self.prefix.as_str()),
                ("delimiter", "/"),
            ];
            if let Some(token) = &token {
                query.push(("continuation-token", token));
            }
            let response = self.client.send(&S3Call::get("", &query))?;
            if response.status != 200 {
                return Err(refusal(&response));
            }
            let page = prefixes_page(&response.body).ok_or_else(unreadable)?;
            ids.extend(page.prefixes.iter().filter_map(|prefix| {
                let id = prefix
                    .strip_prefix(self.prefix.as_str())?
                    .strip_suffix('/')?;
                valid_identifier(id).then(|| id.to_owned())
            }));
            let Some(next) = page.next_token else {
                break;
            };
            advance(&mut token, next)?;
        }
        ids.sort();
        let mut folders = Vec::new();
        for id in ids {
            // A prefix without a marker is somebody else's data.
            if let Some(name) = self.read_marker(&id)? {
                folders.push(RemoteFolder { id, name });
            }
        }
        Ok(folders)
    }

    fn ensure_folder(&self, folder: &str, name: &str) -> Result<(), RemoteError> {
        check(folder, None)?;
        let marker = self.marker_key(folder);
        let headers = [
            ("content-type", "text/plain; charset=utf-8".to_owned()),
            ("if-none-match", "*".to_owned()),
        ];
        for attempt in 0..WRITE_ATTEMPTS {
            let response = self.client.send(&S3Call {
                method: "PUT",
                key: &marker,
                query: &[],
                headers: &headers,
                body: name.as_bytes(),
            })?;
            match response.status {
                // Created, or another device made the folder first: its name stays.
                200 | 412 => {
                    lock(&self.known).insert(folder.to_owned());
                    return Ok(());
                }
                409 => self.client.wait(Duration::from_millis(100 << attempt)),
                _ => return Err(refusal(&response)),
            }
        }
        Err(RemoteError::Other(
            "S3 kept refusing to create the folder; it will be retried".into(),
        ))
    }

    fn list(&self, folder: &str) -> Result<Vec<RemoteFile>, RemoteError> {
        check(folder, None)?;
        struct Seen {
            newest: Listed,
            marker: Option<Listed>,
        }
        let base = self.folder_prefix(folder);
        let marker_key = self.marker_key(folder);
        let mut marker_live = None;
        let mut seen: BTreeMap<RemoteKey, Seen> = BTreeMap::new();
        let mut cursor: Option<(String, Option<String>)> = None;
        loop {
            let mut query = vec![("versions", ""), ("prefix", base.as_str())];
            if let Some((key, version)) = &cursor {
                query.push(("key-marker", key));
                if let Some(version) = version {
                    query.push(("version-id-marker", version));
                }
            }
            let response = self.client.send(&S3Call::get("", &query))?;
            if response.status != 200 {
                let error = refusal(&response);
                return Err(if error == RemoteError::FolderMissing {
                    self.forget(folder)
                } else {
                    error
                });
            }
            let page = versions_page(&response.body).ok_or_else(unreadable)?;
            for entry in page.entries {
                if entry.key == marker_key {
                    // The first entry of a key is its newest.
                    marker_live.get_or_insert(!entry.is_delete_marker());
                    continue;
                }
                let Some(key) = entry.key.strip_prefix(base.as_str()).and_then(parse_file) else {
                    continue;
                };
                match seen.get_mut(&key) {
                    None => {
                        let marker = entry.is_delete_marker().then(|| entry.clone());
                        seen.insert(
                            key,
                            Seen {
                                newest: entry,
                                marker,
                            },
                        );
                    }
                    Some(known) => {
                        if known.marker.is_none() && entry.is_delete_marker() {
                            known.marker = Some(entry);
                        }
                    }
                }
            }
            if !page.truncated {
                break;
            }
            advance(
                &mut cursor,
                (
                    page.next_key_marker.ok_or_else(unreadable)?,
                    page.next_version_marker,
                ),
            )?;
        }
        if marker_live != Some(true) {
            return Err(self.forget(folder));
        }
        lock(&self.known).insert(folder.to_owned());
        Ok(seen
            .into_iter()
            .filter_map(|(key, seen)| {
                let content = seen.newest.content.as_ref()?;
                let (file_id, created) = seen.marker.map_or_else(
                    || (FIRST_FILE.to_owned(), FIRST_FILE_TIME.to_owned()),
                    |marker| (marker.version_id, marker.modified),
                );
                Some(RemoteFile {
                    name: file_name(&key),
                    version: seen.newest.version_id.clone(),
                    size: content.size,
                    file_id,
                    created,
                    key,
                })
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
        if !valid_version(version) {
            return Err(RemoteError::NotFound);
        }
        let fetched = self
            .fetch(&self.object_key(folder, key), version, output)?
            .ok_or(RemoteError::NotFound)?;
        match fetched.recorded {
            Some(recorded) if recorded != fetched.computed => Err(RemoteError::Other(
                "the downloaded file does not match the checksum ticketd stored with it".into(),
            )),
            _ => Ok(()),
        }
    }

    fn write(
        &self,
        folder: &str,
        key: &RemoteKey,
        name: &str,
        expected: Option<&str>,
        content: &mut dyn RemoteContent,
    ) -> Result<RemoteFile, RemoteError> {
        check(folder, Some(key))?;
        let unreadable = |_| RemoteError::Other("cannot read the content to upload".into());
        let size = content.seek(SeekFrom::End(0)).map_err(unreadable)?;
        content.seek(SeekFrom::Start(0)).map_err(unreadable)?;
        if size > SINGLE_PART_LIMIT {
            return self.write_in_parts(folder, key, name, expected, content, size);
        }
        let body = read_all(content)?;
        if body.len() as u64 > SINGLE_PART_LIMIT {
            return Err(RemoteError::Other(
                "the file changed while it was being read".into(),
            ));
        }
        let digest = Sha256::digest(&body);
        let hash = hex(&digest);
        let size = body.len() as u64;
        self.require_folder(folder)?;
        let object = self.object_key(folder, key);

        for attempt in 0..WRITE_ATTEMPTS {
            let lookup = self.lookup(folder, key)?;
            let stored = lookup.stored();
            if let Some(stored) = &stored
                && self.holds(&object, stored, size, &hash)?
            {
                // The bytes are already there, such as from a write whose answer was lost.
                return Ok(stored.file.clone());
            }
            let condition = condition_for(&stored, expected)?;
            let headers = [
                ("content-type", content_type(key.kind).to_owned()),
                (
                    "content-disposition",
                    format!("attachment; filename*=UTF-8''{}", encode(name)),
                ),
                (HASH_METADATA, hash.clone()),
                ("x-amz-checksum-sha256", STANDARD.encode(digest)),
                condition,
            ];
            let response = self.client.send(&S3Call {
                method: "PUT",
                key: &object,
                query: &[],
                headers: &headers,
                body: &body,
            })?;
            match response.status {
                200 => {
                    let version = self.committed_version(&response)?;
                    let (file_id, created) = lookup.identity();
                    return Ok(RemoteFile {
                        key: key.clone(),
                        name: file_name(key),
                        version,
                        size,
                        file_id,
                        created,
                    });
                }
                // Another device wrote since the lookup; read what is stored now.
                412 => {}
                // The file went away since the lookup.
                404 if stored.is_some() && condition_is_if_match(&headers) => {
                    return Err(RemoteError::PreconditionFailed { current: None });
                }
                // Another conditional write to the key is still in progress.
                409 => self.client.wait(Duration::from_millis(100 << attempt)),
                _ => {
                    let error = refusal(&response);
                    return Err(if error == RemoteError::FolderMissing {
                        self.forget(folder)
                    } else {
                        error
                    });
                }
            }
        }
        Err(RemoteError::Other(
            "S3 kept refusing the write because the file kept changing; it will be retried".into(),
        ))
    }

    fn revisions(&self, folder: &str, key: &RemoteKey) -> Result<Vec<RemoteRevision>, RemoteError> {
        check(folder, Some(key))?;
        let lookup = self.lookup(folder, key)?;
        // The versions written since the file's latest delete marker are this file's own.
        let mut revisions: Vec<RemoteRevision> = lookup
            .entries
            .iter()
            .map_while(|entry| {
                entry.content.as_ref().map(|content| RemoteRevision {
                    version: entry.version_id.clone(),
                    modified: entry.modified.clone(),
                    size: content.size,
                })
            })
            .collect();
        if revisions.is_empty() {
            return Err(RemoteError::NotFound);
        }
        revisions.reverse();
        Ok(revisions)
    }
}

/// The header that makes a write refuse to replace what it did not read: `If-None-Match: *` to
/// create, `If-Match` on the ETag to update the version the caller has.
fn condition_for(
    stored: &Option<Stored>,
    expected: Option<&str>,
) -> Result<(&'static str, String), RemoteError> {
    match (stored, expected) {
        (None, None) => Ok(("if-none-match", "*".to_owned())),
        (None, Some(_)) => Err(RemoteError::PreconditionFailed { current: None }),
        (Some(stored), Some(version)) if stored.file.version == version => {
            Ok(("if-match", stored.etag.clone()))
        }
        (Some(stored), _) => Err(RemoteError::PreconditionFailed {
            current: Some(Box::new(stored.file.clone())),
        }),
    }
}

fn condition_is_if_match(headers: &[(&str, String)]) -> bool {
    headers.iter().any(|(name, _)| *name == "if-match")
}
