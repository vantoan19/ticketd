//! A small stateful S3 behind the controlled transport: a versioned bucket with delete
//! markers, conditional writes, ranged reads and paginated listings, enough for the S3
//! adapter's tests. It checks what a real S3 checks of a request that the adapter could get
//! wrong: that it is for this bucket, that every `x-amz-*` header is signed, that the payload
//! hash is the body's, and that the credentials are the ones it accepts.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Shared deterministic fixture.
use std::collections::BTreeMap;
use std::sync::Mutex;

use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use ticketd_core::s3::*;

pub const BUCKET: &str = "ticketd-test";
pub const REGION: &str = "us-east-1";
pub const ACCESS_KEY: &str = "AKIDSIM";

pub fn target() -> S3Target {
    S3Target::new(BUCKET, REGION, None).unwrap()
}

/// Credentials the way the AWS CLI hands them out: a session token that changes when the
/// session is renewed. `forget` moves to the next token of the list, as exporting again does.
pub struct FakeCredentials {
    tokens: Vec<String>,
    state: Mutex<(usize, usize, usize)>,
}

impl FakeCredentials {
    pub fn new(tokens: &[&str]) -> Self {
        Self {
            tokens: tokens.iter().map(|t| (*t).to_owned()).collect(),
            state: Mutex::new((0, 0, 0)),
        }
    }

    /// How many times the credentials were asked for.
    pub fn fetches(&self) -> usize {
        self.state.lock().unwrap().1
    }

    /// How many times the adapter dropped them.
    pub fn forgets(&self) -> usize {
        self.state.lock().unwrap().2
    }
}

impl Default for FakeCredentials {
    fn default() -> Self {
        Self::new(&["token-1"])
    }
}

impl CredentialSource for FakeCredentials {
    fn credentials(&self) -> Result<Credentials, AwsCliError> {
        let mut state = self.state.lock().unwrap();
        state.1 += 1;
        Ok(Credentials {
            access_key_id: ACCESS_KEY.into(),
            secret_access_key: "secret-key-of-the-simulator".into(),
            session_token: Some(self.tokens[state.0].clone()),
            expires_at: None,
        })
    }

    fn forget(&self) {
        let mut state = self.state.lock().unwrap();
        state.0 = (state.0 + 1).min(self.tokens.len() - 1);
        state.2 += 1;
    }
}

struct Version {
    id: String,
    bytes: Vec<u8>,
    metadata: Vec<(String, String)>,
    disposition: Option<String>,
    content_type: Option<String>,
    modified: String,
    delete_marker: bool,
}

impl Version {
    fn etag(&self) -> String {
        // Like S3's, it is the same for the same content.
        format!("\"{:.32}\"", hex(&Sha256::digest(&self.bytes)))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// What the bucket holds as the current version of a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    pub bytes: Vec<u8>,
    pub metadata: Vec<(String, String)>,
    pub disposition: Option<String>,
    pub content_type: Option<String>,
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
    pub body: String,
    pub headers: Vec<(String, String)>,
    /// Perform the request, then answer with the fault: a lost response.
    pub after_applying: bool,
}

impl Fault {
    pub fn new(method: &'static str, url_contains: &'static str, status: u16, code: &str) -> Self {
        Self {
            method,
            url_contains,
            skip: 0,
            times: 1,
            status,
            body: error_xml(code, "injected by the test"),
            headers: vec![],
            after_applying: false,
        }
    }
}

fn error_xml(code: &str, message: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>{code}</Code><Message>{message}</Message><RequestId>sim</RequestId></Error>"
    )
}

#[derive(Default)]
struct State {
    objects: BTreeMap<String, Vec<Version>>,
    counter: u64,
    token: String,
    missing_bucket: bool,
    offline: bool,
    page_size: usize,
    faults: Vec<Fault>,
    requests: Vec<(String, String)>,
    /// Writes by another device that land just before the next matching PutObject.
    interleaved: Vec<(String, Vec<u8>)>,
}

pub struct S3Sim {
    target: S3Target,
    state: Mutex<State>,
}

impl Default for S3Sim {
    fn default() -> Self {
        Self {
            target: target(),
            state: Mutex::new(State {
                token: "token-1".into(),
                ..State::default()
            }),
        }
    }
}

fn answer(status: u16, headers: Vec<(String, String)>, body: impl Into<Vec<u8>>) -> S3Response {
    S3Response {
        status,
        headers,
        body: body.into(),
    }
}

fn failure(status: u16, code: &str) -> S3Response {
    answer(status, vec![], error_xml(code, "refused by the simulator"))
}

struct Query(Vec<(String, String)>);

impl Query {
    fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn header<'r>(request: &'r S3Request, name: &str) -> Option<&'r str> {
    request
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

impl State {
    fn now(&mut self) -> String {
        self.counter += 1;
        let time =
            chrono::DateTime::from_timestamp(1_794_000_000 + self.counter as i64, 0).unwrap();
        time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
    }

    fn current(&self, key: &str) -> Option<&Version> {
        self.objects
            .get(key)
            .and_then(|versions| versions.last())
            .filter(|version| !version.delete_marker)
    }

    fn store(
        &mut self,
        key: &str,
        bytes: Vec<u8>,
        metadata: Vec<(String, String)>,
        disposition: Option<String>,
        content_type: Option<String>,
    ) -> (String, String) {
        let modified = self.now();
        let id = format!("v{}", self.counter);
        let version = Version {
            id: id.clone(),
            bytes,
            metadata,
            disposition,
            content_type,
            modified,
            delete_marker: false,
        };
        let etag = version.etag();
        self.objects
            .entry(key.to_owned())
            .or_default()
            .push(version);
        (id, etag)
    }

    fn handle(&mut self, request: &S3Request, target: &S3Target) -> S3Response {
        if let Some(refused) = self.authenticate(request, target) {
            return refused;
        }
        if self.missing_bucket {
            return failure(404, "NoSuchBucket");
        }
        let url = url::Url::parse(&request.url).unwrap();
        let query = Query(url.query_pairs().into_owned().collect());
        let path = url.path().strip_prefix('/').unwrap();
        let key = percent_encoding::percent_decode_str(path)
            .decode_utf8()
            .unwrap()
            .into_owned();
        match (request.method, key.is_empty()) {
            ("GET", true) if query.get("versions").is_some() => self.list_versions(&query),
            ("GET", true) if query.get("list-type") == Some("2") => self.list_folders(&query),
            ("GET", false) => self.get(request, &key, query.get("versionId")),
            ("PUT", false) => self.put(request, &key),
            (method, _) => panic!("unexpected S3 request: {method} {}", url.path()),
        }
    }

    fn authenticate(&self, request: &S3Request, target: &S3Target) -> Option<S3Response> {
        let authorization = header(request, "authorization").expect("a signed request");
        assert!(
            authorization.starts_with(&format!("AWS4-HMAC-SHA256 Credential={ACCESS_KEY}/"))
                && authorization.contains(&format!("/{}/s3/aws4_request", target.region())),
            "the credential scope names the bucket's region and S3"
        );
        let signed: Vec<&str> = authorization
            .split("SignedHeaders=")
            .nth(1)
            .unwrap()
            .split(',')
            .next()
            .unwrap()
            .split(';')
            .collect();
        for required in ["host", "x-amz-date", "x-amz-content-sha256"] {
            assert!(signed.contains(&required), "{required} must be signed");
        }
        for (name, _) in &request.headers {
            let name = name.to_ascii_lowercase();
            if name.starts_with("x-amz-") {
                assert!(signed.contains(&name.as_str()), "{name} must be signed");
            }
        }
        assert_eq!(
            header(request, "x-amz-content-sha256").unwrap(),
            hex(&Sha256::digest(&request.body)),
            "the signed payload hash is the body's"
        );
        (header(request, "x-amz-security-token") != Some(self.token.as_str()))
            .then(|| failure(400, "ExpiredToken"))
    }

    fn put(&mut self, request: &S3Request, key: &str) -> S3Response {
        if let Some(index) = self
            .interleaved
            .iter()
            .position(|(contains, _)| key.contains(contains.as_str()))
        {
            let (_, bytes) = self.interleaved.remove(index);
            self.store(key, bytes, vec![], None, None);
        }
        if let Some(sent) = header(request, "x-amz-checksum-sha256")
            && sent != STANDARD.encode(Sha256::digest(&request.body))
        {
            return failure(400, "BadDigest");
        }
        let current = self.current(key).map(Version::etag);
        if header(request, "if-none-match") == Some("*") && current.is_some() {
            return failure(412, "PreconditionFailed");
        }
        if let Some(wanted) = header(request, "if-match") {
            match current {
                None => return failure(404, "NoSuchKey"),
                Some(etag) if etag != wanted => return failure(412, "PreconditionFailed"),
                Some(_) => {}
            }
        }
        let metadata = request
            .headers
            .iter()
            .filter(|(name, _)| name.to_ascii_lowercase().starts_with("x-amz-meta-"))
            .map(|(name, value)| (name.to_ascii_lowercase(), value.clone()))
            .collect();
        let (id, etag) = self.store(
            key,
            request.body.clone(),
            metadata,
            header(request, "content-disposition").map(str::to_owned),
            header(request, "content-type").map(str::to_owned),
        );
        answer(
            200,
            vec![("etag".into(), etag), ("x-amz-version-id".into(), id)],
            vec![],
        )
    }

    fn get(&self, request: &S3Request, key: &str, version_id: Option<&str>) -> S3Response {
        let version = match version_id {
            Some(id) => {
                let found = self
                    .objects
                    .get(key)
                    .and_then(|versions| versions.iter().find(|v| v.id == id));
                match found {
                    None => return failure(404, "NoSuchVersion"),
                    Some(version) if version.delete_marker => {
                        return failure(405, "MethodNotAllowed");
                    }
                    Some(version) => version,
                }
            }
            None => match self.current(key) {
                Some(version) => version,
                None => return failure(404, "NoSuchKey"),
            },
        };
        let mut headers = vec![
            ("etag".to_owned(), version.etag()),
            ("x-amz-version-id".to_owned(), version.id.clone()),
        ];
        headers.extend(version.metadata.iter().cloned());
        let len = version.bytes.len();
        let Some(range) = header(request, "range") else {
            return answer(200, headers, version.bytes.clone());
        };
        let (from, to) = range
            .strip_prefix("bytes=")
            .unwrap()
            .split_once('-')
            .unwrap();
        let (from, to): (usize, usize) = (from.parse().unwrap(), to.parse().unwrap());
        if len == 0 || from >= len {
            return failure(416, "InvalidRange");
        }
        let to = to.min(len - 1);
        assert!(to - from < 8 * 1024 * 1024, "reads stay within a chunk");
        headers.push(("content-range".into(), format!("bytes {from}-{to}/{len}")));
        answer(206, headers, version.bytes[from..=to].to_vec())
    }

    fn page_limit(&self, param: &Query) -> usize {
        let asked: usize = param.get("max-keys").map_or(1000, |n| n.parse().unwrap());
        if self.page_size == 0 {
            asked
        } else {
            self.page_size.min(asked)
        }
    }

    fn list_versions(&self, param: &Query) -> S3Response {
        let prefix = param.get("prefix").unwrap_or("");
        let mut entries: Vec<(&String, &Version, bool)> = Vec::new();
        for (key, versions) in self
            .objects
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
        {
            for (index, version) in versions.iter().rev().enumerate() {
                entries.push((key, version, index == 0));
            }
        }
        let start = match (param.get("key-marker"), param.get("version-id-marker")) {
            (Some(key), Some(id)) => {
                entries
                    .iter()
                    .position(|(k, v, _)| k.as_str() == key && v.id == id)
                    .expect("a marker the listing gave")
                    + 1
            }
            (Some(key), None) => entries
                .iter()
                .position(|(k, _, _)| k.as_str() > key)
                .unwrap_or(entries.len()),
            _ => 0,
        };
        let limit = self.page_limit(param);
        let end = (start + limit).min(entries.len());
        let truncated = end < entries.len();
        let mut xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListVersionsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>{BUCKET}</Name><Prefix>{}</Prefix><MaxKeys>{limit}</MaxKeys><IsTruncated>{truncated}</IsTruncated>",
            escape(prefix)
        );
        if truncated {
            let (key, version, _) = entries[end - 1];
            xml.push_str(&format!(
                "<NextKeyMarker>{}</NextKeyMarker><NextVersionIdMarker>{}</NextVersionIdMarker>",
                escape(key),
                version.id
            ));
        }
        for (key, version, latest) in &entries[start..end] {
            let (tag, details) = if version.delete_marker {
                ("DeleteMarker", String::new())
            } else {
                (
                    "Version",
                    format!(
                        "<ETag>{}</ETag><Size>{}</Size><StorageClass>STANDARD</StorageClass>",
                        escape(&version.etag()),
                        version.bytes.len()
                    ),
                )
            };
            xml.push_str(&format!(
                "<{tag}><Key>{}</Key><VersionId>{}</VersionId><IsLatest>{latest}</IsLatest><LastModified>{}</LastModified>{details}</{tag}>",
                escape(key),
                version.id,
                version.modified
            ));
        }
        xml.push_str("</ListVersionsResult>");
        answer(200, vec![], xml)
    }

    /// Folders: the common prefixes of the current objects.
    fn list_folders(&self, param: &Query) -> S3Response {
        let prefix = param.get("prefix").unwrap_or("");
        let delimiter = param
            .get("delimiter")
            .expect("a folder listing has a delimiter");
        let mut prefixes: Vec<String> = Vec::new();
        for key in self.objects.keys() {
            if self.current(key).is_none() {
                continue;
            }
            let Some(rest) = key.strip_prefix(prefix) else {
                continue;
            };
            if let Some((folder, _)) = rest.split_once(delimiter) {
                let common = format!("{prefix}{folder}{delimiter}");
                if prefixes.last() != Some(&common) {
                    prefixes.push(common);
                }
            }
        }
        let start: usize = param
            .get("continuation-token")
            .map_or(0, |t| t.parse().unwrap());
        let end = (start + self.page_limit(param)).min(prefixes.len());
        let truncated = end < prefixes.len();
        let mut xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>{BUCKET}</Name><IsTruncated>{truncated}</IsTruncated>"
        );
        if truncated {
            xml.push_str(&format!(
                "<NextContinuationToken>{end}</NextContinuationToken>"
            ));
        }
        for prefix in &prefixes[start..end] {
            xml.push_str(&format!(
                "<CommonPrefixes><Prefix>{}</Prefix></CommonPrefixes>",
                escape(prefix)
            ));
        }
        xml.push_str("</ListBucketResult>");
        answer(200, vec![], xml)
    }
}

impl S3Sim {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    pub fn fault(&self, fault: Fault) {
        self.state().faults.push(fault);
    }

    /// Listings return at most this many entries per page.
    pub fn page_size(&self, size: usize) {
        self.state().page_size = size;
    }

    /// Requests must now carry this session token; any other is `ExpiredToken`.
    pub fn accept_token(&self, token: &str) {
        self.state().token = token.to_owned();
    }

    pub fn remove_bucket(&self) {
        self.state().missing_bucket = true;
    }

    pub fn offline(&self, offline: bool) {
        self.state().offline = offline;
    }

    /// An object uploaded by hand (`aws s3 cp`): no ticketd metadata, no readable name.
    pub fn put_foreign(&self, key: &str, bytes: &[u8]) -> String {
        self.state()
            .store(key, bytes.to_vec(), vec![], None, None)
            .0
    }

    /// A person deletes the object in the bucket: a delete marker becomes its newest version.
    pub fn delete(&self, key: &str) -> String {
        let mut state = self.state();
        let modified = state.now();
        let id = format!("m{}", state.counter);
        state
            .objects
            .entry(key.to_owned())
            .or_default()
            .push(Version {
                id: id.clone(),
                bytes: vec![],
                metadata: vec![],
                disposition: None,
                content_type: None,
                modified,
                delete_marker: true,
            });
        id
    }

    /// A person deletes one version, or a delete marker, for good.
    pub fn remove_version(&self, key: &str, version: &str) {
        let mut state = self.state();
        let versions = state.objects.get_mut(key).unwrap();
        let before = versions.len();
        versions.retain(|v| v.id != version);
        assert_eq!(versions.len() + 1, before, "the version existed");
    }

    /// Flip a byte of the current version, as a damaged copy would be.
    pub fn corrupt(&self, key: &str) {
        let mut state = self.state();
        let last = state.objects.get_mut(key).unwrap().last_mut().unwrap();
        last.bytes[0] ^= 0xff;
    }

    /// Another device's write lands just before the next PutObject of a key containing `key`.
    pub fn interleave(&self, key_contains: &str, bytes: &[u8]) {
        self.state()
            .interleaved
            .push((key_contains.to_owned(), bytes.to_vec()));
    }

    /// The current version of a key.
    pub fn object(&self, key: &str) -> Option<Stored> {
        self.state().current(key).map(|v| Stored {
            bytes: v.bytes.clone(),
            metadata: v.metadata.clone(),
            disposition: v.disposition.clone(),
            content_type: v.content_type.clone(),
        })
    }

    /// `(version id, is a delete marker)` of a key, oldest first.
    pub fn versions(&self, key: &str) -> Vec<(String, bool)> {
        self.state()
            .objects
            .get(key)
            .into_iter()
            .flatten()
            .map(|v| (v.id.clone(), v.delete_marker))
            .collect()
    }

    /// Every key the bucket holds, with its newest version still current or not.
    pub fn keys(&self) -> Vec<String> {
        self.state().objects.keys().cloned().collect()
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

impl S3Transport for S3Sim {
    fn send(&self, request: S3Request) -> Result<S3Response, S3TransportError> {
        // The real transport refuses anything outside its allow-list.
        assert!(
            self.target.allows(request.method, &request.url),
            "UreqS3Transport refuses {} {}",
            request.method,
            request.url
        );
        let mut state = self.state();
        state
            .requests
            .push((request.method.to_owned(), request.url.clone()));
        if state.offline {
            return Err(S3TransportError::Offline);
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
            return Ok(state.handle(&request, &self.target));
        };
        let fault = &state.faults[index];
        let response = answer(
            fault.status,
            fault.headers.clone(),
            fault.body.clone().into_bytes(),
        );
        let (apply, spent) = (fault.after_applying, fault.times == 0);
        if spent {
            state.faults.remove(index);
        }
        if apply {
            let target = self.target.clone();
            state.handle(&request, &target);
        }
        Ok(response)
    }
}
