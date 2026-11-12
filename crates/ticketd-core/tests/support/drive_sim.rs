//! A small stateful Google Drive behind the controlled transport: enough of
//! files, resumable uploads, revisions and changes for the sync adapter tests.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Shared deterministic fixture.
use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use ticketd_core::drive::*;

pub struct Vault;
impl CredentialStore for Vault {
    fn load(&self, _: &str) -> Result<DriveCredential, DriveError> {
        Ok(DriveCredential {
            client_id: "client".into(),
            client_secret: None,
            refresh_token: "private-refresh".into(),
        })
    }
    fn save(&self, _: &str, _: &DriveCredential) -> Result<(), DriveError> {
        Ok(())
    }
}

const FOLDER: &str = "application/vnd.google-apps.folder";

struct Revision {
    id: String,
    bytes: Vec<u8>,
    modified: String,
}

struct Item {
    id: String,
    name: String,
    mime: String,
    parents: Vec<String>,
    properties: Value,
    created: String,
    pub trashed: bool,
    revisions: Vec<Revision>,
}

impl Item {
    fn json(&self) -> Value {
        let mut value = json!({
            "id": self.id, "name": self.name, "mimeType": self.mime, "parents": self.parents,
            "appProperties": self.properties, "createdTime": self.created, "trashed": self.trashed,
        });
        if let Some(head) = self.revisions.last() {
            value["size"] = json!(head.bytes.len().to_string());
            value["headRevisionId"] = json!(head.id);
            value["sha256Checksum"] = json!(
                Sha256::digest(&head.bytes)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            );
        }
        value
    }
}

struct Session {
    /// Metadata of the file to create, or the ID and new name of the file to update.
    create: Option<Value>,
    update: Option<(String, String)>,
    received: Vec<u8>,
}

/// A response to give instead of (or after) the simulated behaviour.
pub struct Fault {
    pub method: &'static str,
    pub url_contains: &'static str,
    /// Matching requests to let through first.
    pub skip: usize,
    /// Matching requests to answer with this fault.
    pub times: usize,
    pub status: u16,
    pub body: &'static str,
    pub headers: Vec<(String, String)>,
    /// Perform the request, then answer with the fault: a lost response.
    pub after_applying: bool,
}

impl Fault {
    pub fn new(method: &'static str, url_contains: &'static str, status: u16) -> Self {
        Self {
            method,
            url_contains,
            skip: 0,
            times: 1,
            status,
            body: "{}",
            headers: vec![],
            after_applying: false,
        }
    }
}

#[derive(Default)]
struct State {
    items: Vec<Item>,
    sessions: HashMap<String, Session>,
    /// Finished upload sessions and the file each one stored.
    completed: HashMap<String, String>,
    changes: Vec<String>,
    counter: u64,
    token: Option<String>,
    revoked: bool,
    offline: bool,
    page_size: usize,
    faults: Vec<Fault>,
    requests: Vec<(String, String)>,
}

#[derive(Default)]
pub struct DriveSim(Mutex<State>);

fn respond(status: u16, body: Value) -> DriveResponse {
    DriveResponse {
        status,
        body: body.to_string().into_bytes(),
        headers: vec![],
    }
}

fn header<'r>(request: &'r DriveRequest, name: &str) -> Option<&'r str> {
    request
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// Every text between `start` and the next single quote.
fn quoted(q: &str, start: &str) -> Vec<String> {
    q.split(start)
        .skip(1)
        .filter_map(|rest| rest.split('\'').next())
        .map(str::to_owned)
        .collect()
}

impl State {
    fn next(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}{}", self.counter)
    }

    fn now(&mut self) -> String {
        self.counter += 1;
        format!("2026-11-11T00:00:00.{:06}Z", self.counter)
    }

    fn find(&mut self, id: &str) -> Option<&mut Item> {
        self.items.iter_mut().find(|item| item.id == id)
    }

    fn trashed(&self, item: &Item) -> bool {
        item.trashed
            || item.parents.iter().any(|parent| {
                self.items
                    .iter()
                    .any(|i| &i.id == parent && self.trashed(i))
            })
    }

    /// The subset of the Drive query language the adapter uses.
    fn search(&self, q: &str) -> Vec<Value> {
        let parents: Vec<String> = q
            .match_indices("' in parents")
            .filter_map(|(end, _)| Some(q[q[..end].rfind('\'')? + 1..end].to_owned()))
            .collect();
        let keys = quoted(q, "has { key='");
        let values = quoted(q, "' and value='");
        let mime = quoted(q, "mimeType='");
        assert!(q.contains("trashed=false"), "queries must skip Drive trash");
        self.items
            .iter()
            .filter(|item| !self.trashed(item))
            .filter(|item| parents.is_empty() || item.parents.iter().any(|p| parents.contains(p)))
            .filter(|item| mime.iter().all(|m| &item.mime == m))
            .filter(|item| {
                keys.iter()
                    .zip(&values)
                    .all(|(key, value)| item.properties[key] == json!(value))
            })
            .map(Item::json)
            .collect()
    }

    fn page(&self, key: &str, all: Vec<Value>, query: &HashMap<String, String>) -> DriveResponse {
        let asked: usize = query.get("pageSize").map_or(100, |n| n.parse().unwrap());
        let size = if self.page_size == 0 {
            asked
        } else {
            self.page_size.min(asked)
        };
        let start: usize = query.get("pageToken").map_or(0, |t| t.parse().unwrap());
        let end = (start + size).min(all.len());
        let mut body = json!({ key: all[start..end] });
        if end < all.len() {
            body["nextPageToken"] = json!(end.to_string());
        }
        respond(200, body)
    }

    fn handle(&mut self, request: &DriveRequest) -> DriveResponse {
        let parsed = url::Url::parse(&request.url).unwrap();
        let query: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
        let path = parsed.path().to_owned();
        if path == "/token" {
            if self.revoked {
                return respond(400, json!({"error": "invalid_grant"}));
            }
            let token = self.next("access-");
            self.token = Some(token.clone());
            return respond(200, json!({ "access_token": token }));
        }
        let bearer = self.token.as_ref().map(|token| format!("Bearer {token}"));
        if bearer.is_none() || header(request, "authorization") != bearer.as_deref() {
            return respond(401, json!({"error": {"errors": [{"reason": "authError"}]}}));
        }
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        match (request.method, segments.as_slice()) {
            ("GET", ["drive", "v3", "files", "generateIds"]) => {
                let id = self.next("file-");
                respond(200, json!({ "ids": [id] }))
            }
            ("GET", ["drive", "v3", "files"]) => {
                let found = self.search(&query["q"]);
                self.page("files", found, &query)
            }
            ("POST", ["drive", "v3", "files"]) => {
                let metadata: Value = serde_json::from_slice(&request.body).unwrap();
                self.create(metadata, None)
            }
            ("POST", ["upload", "drive", "v3", "files"]) => {
                let metadata: Value = serde_json::from_slice(&request.body).unwrap();
                if let Some(refused) = self.refuse_create(&metadata) {
                    return refused;
                }
                self.open(
                    Session {
                        create: Some(metadata),
                        update: None,
                        received: vec![],
                    },
                    "",
                )
            }
            ("PATCH", ["upload", "drive", "v3", "files", id]) => {
                if self.find(id).is_none() {
                    return respond(404, json!({}));
                }
                let metadata: Value = serde_json::from_slice(&request.body).unwrap();
                let name = metadata["name"].as_str().unwrap().to_owned();
                self.open(
                    Session {
                        create: None,
                        update: Some(((*id).to_owned(), name)),
                        received: vec![],
                    },
                    &format!("/{id}"),
                )
            }
            ("PUT", ["upload", "drive", "v3", "files", ..]) => self.receive(request, &query),
            ("GET", ["drive", "v3", "files", id]) => match self.find(id) {
                Some(item) => respond(200, item.json()),
                None => respond(404, json!({})),
            },
            ("GET", ["drive", "v3", "files", id, "revisions"]) => {
                let Some(item) = self.find(id) else {
                    return respond(404, json!({}));
                };
                let all = item
                    .revisions
                    .iter()
                    .map(|r| json!({"id": r.id, "modifiedTime": r.modified, "size": r.bytes.len().to_string()}))
                    .collect();
                self.page("revisions", all, &query)
            }
            ("GET", ["drive", "v3", "files", id, "revisions", revision]) => {
                let Some(found) = self
                    .find(id)
                    .and_then(|item| item.revisions.iter().find(|r| r.id == *revision))
                else {
                    return respond(404, json!({}));
                };
                if query.get("alt").map(String::as_str) != Some("media") {
                    return respond(
                        200,
                        json!({"id": found.id, "size": found.bytes.len().to_string()}),
                    );
                }
                let range = header(request, "range")
                    .unwrap()
                    .strip_prefix("bytes=")
                    .unwrap();
                let (from, to) = range.split_once('-').unwrap();
                let (from, to): (usize, usize) = (from.parse().unwrap(), to.parse().unwrap());
                assert!(
                    to - from < 256 * 1024,
                    "downloads must stay within the transport limit"
                );
                DriveResponse {
                    status: 206,
                    body: found.bytes[from..=to].to_vec(),
                    headers: vec![(
                        "Content-Range".into(),
                        format!("bytes {from}-{to}/{}", found.bytes.len()),
                    )],
                }
            }
            ("GET", ["drive", "v3", "changes", "startPageToken"]) => respond(
                200,
                json!({ "startPageToken": self.changes.len().to_string() }),
            ),
            ("GET", ["drive", "v3", "changes"]) => {
                let from: usize = query["pageToken"].parse().unwrap();
                let changes: Vec<Value> = self.changes[from..]
                    .iter()
                    .map(|id| json!({ "fileId": id }))
                    .collect();
                respond(
                    200,
                    json!({ "changes": changes, "newStartPageToken": self.changes.len().to_string() }),
                )
            }
            (method, _) => panic!("unexpected Drive request: {method} {path}"),
        }
    }

    fn refuse_create(&self, metadata: &Value) -> Option<DriveResponse> {
        let id = metadata["id"].as_str().unwrap();
        if self.items.iter().any(|item| item.id == id) {
            return Some(respond(409, json!({})));
        }
        let missing_parent = metadata["parents"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|parent| !self.items.iter().any(|item| json!(item.id) == *parent));
        missing_parent.then(|| respond(404, json!({})))
    }

    fn create(&mut self, metadata: Value, bytes: Option<Vec<u8>>) -> DriveResponse {
        if let Some(refused) = self.refuse_create(&metadata) {
            return refused;
        }
        let created = self.now();
        let revisions = bytes
            .map(|bytes| Revision {
                id: self.next("rev-"),
                bytes,
                modified: created.clone(),
            })
            .into_iter()
            .collect();
        let item = Item {
            id: metadata["id"].as_str().unwrap().to_owned(),
            name: metadata["name"].as_str().unwrap().to_owned(),
            mime: metadata["mimeType"].as_str().unwrap().to_owned(),
            parents: metadata["parents"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|parent| parent.as_str().unwrap().to_owned())
                .collect(),
            properties: metadata["appProperties"].clone(),
            created,
            trashed: false,
            revisions,
        };
        let response = respond(200, item.json());
        self.changes.push(item.id.clone());
        self.items.push(item);
        response
    }

    fn open(&mut self, session: Session, target: &str) -> DriveResponse {
        let id = self.next("session-");
        self.sessions.insert(id.clone(), session);
        DriveResponse {
            status: 200,
            body: vec![],
            headers: vec![(
                "Location".into(),
                format!(
                    "https://www.googleapis.com/upload/drive/v3/files{target}?uploadType=resumable&upload_id={id}"
                ),
            )],
        }
    }

    fn receive(
        &mut self,
        request: &DriveRequest,
        query: &HashMap<String, String>,
    ) -> DriveResponse {
        let upload_id = &query["upload_id"];
        let range = header(request, "content-range").unwrap().to_owned();
        let total: usize = range.rsplit('/').next().unwrap().parse().unwrap();
        // Drive answers a repeated final chunk with the file it already stored.
        if let Some(id) = self.completed.get(upload_id).cloned() {
            return respond(200, self.find(&id).unwrap().json());
        }
        let session = self
            .sessions
            .get_mut(upload_id)
            .expect("an open upload session");
        if !range.starts_with("bytes */") {
            let from = range
                .strip_prefix("bytes ")
                .unwrap()
                .split('-')
                .next()
                .unwrap();
            assert_eq!(from.parse::<usize>().unwrap(), session.received.len());
        }
        session.received.extend_from_slice(&request.body);
        if session.received.len() < total {
            let last = session.received.len() - 1;
            return DriveResponse {
                status: 308,
                body: vec![],
                headers: vec![("Range".into(), format!("bytes=0-{last}"))],
            };
        }
        let session = self.sessions.remove(upload_id).unwrap();
        if let Some(metadata) = session.create {
            let id = metadata["id"].as_str().unwrap().to_owned();
            self.completed.insert(upload_id.clone(), id);
            return self.create(metadata, Some(session.received));
        }
        let (id, name) = session.update.unwrap();
        self.completed.insert(upload_id.clone(), id.clone());
        let revision = Revision {
            id: self.next("rev-"),
            bytes: session.received,
            modified: self.now(),
        };
        self.changes.push(id.clone());
        let item = self.find(&id).unwrap();
        item.name = name;
        item.revisions.push(revision);
        respond(200, item.json())
    }
}

impl DriveSim {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap()
    }

    pub fn fault(&self, fault: Fault) {
        self.state().faults.push(fault);
    }

    /// Listings return at most this many entries per page.
    pub fn page_size(&self, size: usize) {
        self.state().page_size = size;
    }

    /// The access token stops working; the refresh token still does.
    pub fn expire_access_token(&self) {
        self.state().token = None;
    }

    /// The person withdrew ticketd's access: no token works any more.
    pub fn revoke(&self) {
        let mut state = self.state();
        state.token = None;
        state.revoked = true;
    }

    pub fn offline(&self, offline: bool) {
        self.state().offline = offline;
    }

    /// Move a file or folder to Drive trash, as the person can in Drive.
    pub fn trash(&self, id: &str) {
        self.state().find(id).unwrap().trashed = true;
    }

    /// Add a file the way an interrupted or concurrent creation leaves one.
    pub fn insert(&self, metadata: Value, bytes: &[u8]) {
        self.state().create(metadata, Some(bytes.to_vec()));
    }

    /// Every stored file and folder, as Drive metadata.
    pub fn items(&self) -> Vec<Value> {
        self.state().items.iter().map(Item::json).collect()
    }

    /// `(method, url)` of every request so far.
    pub fn requests(&self) -> Vec<(String, String)> {
        self.state().requests.clone()
    }

    pub fn count(&self, method: &str, url_contains: &str) -> usize {
        self.requests()
            .iter()
            .filter(|(m, url)| m == method && url.contains(url_contains))
            .count()
    }
}

impl DriveTransport for DriveSim {
    fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError> {
        // The real transport refuses anything outside its allow-list.
        assert!(
            ticketd_core::drive::request_allowed(request.method, &request.url),
            "GoogleTransport refuses {} {}",
            request.method,
            request.url
        );
        let mut state = self.state();
        state
            .requests
            .push((request.method.to_owned(), request.url.clone()));
        if state.offline {
            return Err(DriveError::new(DriveErrorKind::Offline, "offline"));
        }
        let mut hit = None;
        for (index, fault) in state.faults.iter_mut().enumerate() {
            if fault.method != request.method || !request.url.contains(fault.url_contains) {
                continue;
            }
            if fault.skip > 0 {
                fault.skip -= 1;
            } else if hit.is_none() {
                fault.times -= 1;
                hit = Some(index);
            }
        }
        let Some(index) = hit else {
            return Ok(state.handle(&request));
        };
        let fault = &state.faults[index];
        let response = DriveResponse {
            status: fault.status,
            body: fault.body.as_bytes().to_vec(),
            headers: fault.headers.clone(),
        };
        let (apply, spent) = (fault.after_applying, fault.times == 0);
        if spent {
            state.faults.remove(index);
        }
        if apply {
            state.handle(&request);
        }
        Ok(response)
    }
}
