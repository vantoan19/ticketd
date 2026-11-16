//! The one Google Drive client under both adapter families.
//!
//! It owns what every request to Drive has in common: the in-memory access
//! token (renewed once when Drive refuses it, with refresh-token rotation under
//! the cross-process credential lock), the classification of Google's errors,
//! `generateIds` and resumable upload sessions, ranged reads that check
//! `Content-Range`, pagination, and retry with backoff for requests that opt
//! in. The adapters (`GoogleDrive` and friends for Attachments, `DriveRemote`
//! for Workspace sync) only translate its answers into their own errors.
use std::io::{Read, Write};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde::Deserialize;

use super::provider::{credential_lock, token_request};
use super::{
    CredentialStore, DriveError, DriveErrorKind, DriveRequest, DriveResponse, DriveTransport,
    valid_file_id,
};

const API: &str = "https://www.googleapis.com/drive/v3";
/// Range size of reads and chunk size of uploads; the transport refuses
/// response bodies above 1 MiB.
const CHUNK: u64 = 256 * 1024;
const MAX_RETRIES: u32 = 4;
/// The longest `Retry-After` a call waits out itself.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

/// Whether a request is repeated when Drive is rate limiting or unavailable.
/// Workspace sync opts in: its writes are safe to repeat. An Uploaded copy
/// never does: it is recorded as uncertain before any bytes are sent and
/// reconciled by its reserved file ID instead.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Retry {
    Never,
    Backoff,
}

/// How a refused Drive response is understood, whichever adapter asked.
pub(crate) enum Failure {
    /// The access token (or the whole grant) is refused.
    Unauthorized,
    StorageFull,
    RateLimited {
        retry_after: Option<Duration>,
    },
    /// A server failure (5xx).
    Unavailable,
    ApiDisabled,
    /// The app was not authorized for this file: select it in the Picker.
    SelectFile,
    PermissionDenied,
    /// An unexplained 403 or 404: no evidence which.
    Inaccessible,
    Unreadable,
}

impl Failure {
    pub(crate) fn of(response: &DriveResponse) -> Self {
        let body: serde_json::Value = serde_json::from_slice(&response.body).unwrap_or_default();
        let reasons: Vec<&str> = body["error"]["errors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|error| error["reason"].as_str())
            .collect();
        let has_reason = |wanted: &[&str]| reasons.iter().any(|reason| wanted.contains(reason));
        let retry_after = header(response, "retry-after")
            .and_then(|seconds| seconds.trim().parse().ok())
            .map(Duration::from_secs);
        match response.status {
            401 => Self::Unauthorized,
            429 => Self::RateLimited { retry_after },
            500..=599 => Self::Unavailable,
            403 if api_disabled(&body) => Self::ApiDisabled,
            403 if has_reason(&["storageQuotaExceeded", "teamDriveFileLimitExceeded"]) => {
                Self::StorageFull
            }
            403 if has_reason(&["appNotAuthorizedToFile"]) => Self::SelectFile,
            403 if has_reason(&[
                "rateLimitExceeded",
                "userRateLimitExceeded",
                "dailyLimitExceeded",
            ]) =>
            {
                Self::RateLimited { retry_after }
            }
            403 if has_reason(&["insufficientFilePermissions"]) => Self::PermissionDenied,
            403 | 404 => Self::Inaccessible,
            _ => Self::Unreadable,
        }
    }

    /// What to tell a person about a file or folder Drive refused.
    pub(crate) fn guidance(&self) -> DriveError {
        match self {
            Self::Unauthorized => DriveError::new(
                DriveErrorKind::Reauthorize,
                "Drive authorization expired; select the file again in ticketd's Google Drive tab",
            ),
            Self::RateLimited { .. } => DriveError::new(
                DriveErrorKind::RateLimited,
                "Drive is rate limited; wait and retry",
            ),
            Self::Unavailable => DriveError::new(
                DriveErrorKind::Offline,
                "Drive is temporarily unavailable; retry later",
            ),
            Self::ApiDisabled => DriveError::new(
                DriveErrorKind::Unconfigured,
                "Google Drive API is disabled for ticketd's Google app; the app publisher must enable Google Drive API in Google Cloud, then retry",
            ),
            Self::SelectFile => select_file(),
            Self::PermissionDenied => DriveError::new(
                DriveErrorKind::PermissionDenied,
                "Drive denied permission for this file; open it in Drive and request access from its owner, then retry; ticketd never changes sharing",
            ),
            Self::StorageFull | Self::Inaccessible => DriveError::new(
                DriveErrorKind::InaccessibleOrMissing,
                "Drive cannot provide this file: it may be inaccessible or missing; select it again or request access from its owner in Drive",
            ),
            Self::Unreadable => invalid_response(),
        }
    }
}

fn api_disabled(body: &serde_json::Value) -> bool {
    body["error"]["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|error| error["reason"] == "accessNotConfigured")
        || body["error"]["details"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|error| {
                error["reason"] == "SERVICE_DISABLED"
                    && error["domain"] == "googleapis.com"
                    && error["metadata"]["service"] == "drive.googleapis.com"
            })
}

/// The Drive error for a refused response, with per-file guidance.
pub(crate) fn response_error(response: &DriveResponse) -> DriveError {
    Failure::of(response).guidance()
}

pub(crate) fn api_disabled_error(response: &DriveResponse) -> Option<DriveError> {
    if response.status != 403 {
        return None;
    }
    let body: serde_json::Value = serde_json::from_slice(&response.body).ok()?;
    api_disabled(&body).then(|| Failure::ApiDisabled.guidance())
}

pub(crate) fn invalid_response() -> DriveError {
    DriveError::new(
        DriveErrorKind::InvalidResponse,
        "Google returned an unreadable response; retry or select the file again",
    )
}

fn select_file() -> DriveError {
    DriveError::new(
        DriveErrorKind::SelectFile,
        "this file is not authorized for ticketd; open the Google Drive tab in the attachment picker and select this file; account access alone does not authorize it",
    )
}

pub(crate) fn header<'r>(response: &'r DriveResponse, name: &str) -> Option<&'r str> {
    response
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// Whether `value` is a resumable upload session URL the client may send
/// credentials to: Google's upload endpoint, nothing else.
pub(crate) fn safe_session_url(value: &str) -> bool {
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

/// Why a call that got past authorization did not produce its answer.
pub(crate) enum ClientError {
    /// No answer: offline, or authorization failed.
    Drive(DriveError),
    /// Drive answered with a status the call does not accept.
    Refused(DriveResponse),
    /// Drive answered something the call cannot read.
    Unreadable,
}

impl From<DriveError> for ClientError {
    fn from(error: DriveError) -> Self {
        Self::Drive(error)
    }
}

impl ClientError {
    /// The error with per-file guidance, for the Attachment adapters.
    pub(crate) fn into_drive_error(self) -> DriveError {
        match self {
            Self::Drive(error) => error,
            Self::Refused(response) => response_error(&response),
            Self::Unreadable => invalid_response(),
        }
    }
}

/// Why a ranged read stopped.
pub(crate) enum ReadError {
    Client(ClientError),
    /// A partial response named a different range or total than asked for.
    ContentRange,
    /// A response carried more or fewer bytes than its range.
    Length,
    /// Drive answered a range request with the whole content.
    NotRanged,
    /// The output refused the bytes.
    Output,
}

impl From<DriveError> for ReadError {
    fn from(error: DriveError) -> Self {
        Self::Client(error.into())
    }
}

/// An open resumable upload session. Its URL is a bearer secret: it stays in
/// memory and is never logged or stored.
pub(crate) struct Session(String);

pub(crate) struct DriveClient<'a> {
    connection_id: String,
    vault: &'a dyn CredentialStore,
    transport: &'a dyn DriveTransport,
    access_token: Mutex<Option<String>>,
    pause: Box<dyn Fn(Duration) + Send + Sync + 'a>,
}

impl<'a> DriveClient<'a> {
    pub(crate) fn new(
        connection_id: &str,
        vault: &'a dyn CredentialStore,
        transport: &'a dyn DriveTransport,
    ) -> Self {
        Self {
            connection_id: connection_id.to_owned(),
            vault,
            transport,
            access_token: Mutex::new(None),
            pause: Box::new(std::thread::sleep),
        }
    }

    /// Replace the wait between retries, so tests control time.
    pub(crate) fn with_pause(mut self, pause: impl Fn(Duration) + Send + Sync + 'a) -> Self {
        self.pause = Box::new(pause);
        self
    }

    fn access_token(&self) -> Result<String, DriveError> {
        let mut cached = self
            .access_token
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(token) = &*cached {
            return Ok(token.clone());
        }
        let token = self.exchange()?;
        *cached = Some(token.clone());
        Ok(token)
    }

    fn forget_access_token(&self) {
        *self
            .access_token
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// Always reads the stored credential, so a sign-in made since the cached
    /// token was issued is used when that token is refused.
    fn exchange(&self) -> Result<String, DriveError> {
        // The secure-store lock serializes refresh-token rotation across CLI/desktop.
        let _lock = credential_lock(&self.connection_id)?;
        let mut credential = self.vault.load(&self.connection_id)?;
        let mut fields = vec![
            ("grant_type", "refresh_token"),
            ("client_id", &credential.client_id),
            ("refresh_token", &credential.refresh_token),
        ];
        if let Some(secret) = credential.client_secret.as_deref() {
            fields.push(("client_secret", secret));
        }
        let token = token_request(self.transport, &fields)?;
        if let Some(refresh) = token.refresh_token.filter(|r| !r.is_empty()) {
            credential.refresh_token = refresh;
            self.vault.save(&self.connection_id, &credential)?;
        }
        Ok(token.access_token)
    }

    /// Sends with the cached access token and renews it once when Drive
    /// refuses it. Returns the answer whatever its status, after any retries
    /// `retry` allows; only a failure to get an answer is an error. A 401 is
    /// not a retry of an uncertain request: Drive rejected it unprocessed.
    pub(crate) fn send(
        &self,
        method: &'static str,
        url: &str,
        headers: &[(String, String)],
        body: &[u8],
        retry: Retry,
    ) -> Result<DriveResponse, DriveError> {
        let mut renewed = false;
        let mut attempt = 0;
        loop {
            let mut all = headers.to_vec();
            all.push((
                "Authorization".into(),
                format!("Bearer {}", self.access_token()?),
            ));
            let response = self.transport.send(DriveRequest {
                method,
                url: url.into(),
                headers: all,
                body: body.to_vec(),
            })?;
            if response.status < 400 {
                return Ok(response);
            }
            if response.status == 401 && !renewed {
                renewed = true;
                self.forget_access_token();
                continue;
            }
            if retry == Retry::Never {
                return Ok(response);
            }
            let retry_after = match Failure::of(&response) {
                Failure::RateLimited { retry_after } => retry_after,
                Failure::Unavailable => None,
                _ => return Ok(response),
            };
            // A server may ask for any wait; a long one is the caller's to schedule.
            if attempt == MAX_RETRIES || retry_after.is_some_and(|wait| wait > MAX_RETRY_AFTER) {
                return Ok(response);
            }
            (self.pause)(backoff(attempt, retry_after));
            attempt += 1;
        }
    }

    /// Reads a paginated listing. `url` gives the request for a page token
    /// (`None` for the first page); `page` reads one answer and returns the
    /// next token, or `None` after the last page.
    pub(crate) fn pages<E: From<DriveError>>(
        &self,
        retry: Retry,
        url: &mut dyn FnMut(Option<&str>) -> Result<String, E>,
        page: &mut dyn FnMut(DriveResponse) -> Result<Option<String>, E>,
    ) -> Result<(), E> {
        let mut token: Option<String> = None;
        loop {
            let response = self.send("GET", &url(token.as_deref())?, &[], &[], retry)?;
            token = page(response)?;
            if token.is_none() {
                return Ok(());
            }
        }
    }

    /// A file ID Drive keeps for this account, so repeating a creation under it
    /// answers 409 instead of adding a second file.
    pub(crate) fn reserve_id(&self, retry: Retry) -> Result<String, ClientError> {
        #[derive(Deserialize)]
        struct Ids {
            ids: Vec<String>,
        }
        let response = self.send(
            "GET",
            &format!("{API}/files/generateIds?count=1&space=drive&type=files"),
            &[],
            &[],
            retry,
        )?;
        if response.status != 200 {
            return Err(ClientError::Refused(response));
        }
        let ids: Ids =
            serde_json::from_slice(&response.body).map_err(|_| ClientError::Unreadable)?;
        match ids.ids.as_slice() {
            [id] if valid_file_id(id) => Ok(id.clone()),
            _ => Err(ClientError::Unreadable),
        }
    }

    /// Opens a resumable upload session: `method` on `url` with the file's
    /// JSON `metadata`. A status other than 200 or 201 is `Refused`.
    pub(crate) fn open_session(
        &self,
        method: &'static str,
        url: &str,
        headers: &[(String, String)],
        metadata: &[u8],
        retry: Retry,
    ) -> Result<Session, ClientError> {
        let response = self.send(method, url, headers, metadata, retry)?;
        if !matches!(response.status, 200 | 201) {
            return Err(ClientError::Refused(response));
        }
        header(&response, "location")
            .filter(|location| safe_session_url(location))
            .map(|location| Session(location.to_owned()))
            .ok_or(ClientError::Unreadable)
    }

    /// Sends `total` bytes of `input` to `session` in 256 KiB chunks and
    /// returns the completing response. `proceed` may stop the upload before
    /// each chunk, given the bytes sent so far.
    pub(crate) fn upload_chunks(
        &self,
        session: &Session,
        content_type: &str,
        total: u64,
        input: &mut dyn Read,
        retry: Retry,
        proceed: &mut dyn FnMut(u64) -> Result<(), ClientError>,
    ) -> Result<DriveResponse, ClientError> {
        let response = send_chunks(
            total,
            input,
            &mut |range, bytes| {
                let response = self.send(
                    "PUT",
                    &session.0,
                    &[
                        ("Content-Type".into(), content_type.into()),
                        ("Content-Range".into(), range),
                    ],
                    &bytes,
                    retry,
                )?;
                if response.status >= 400 {
                    return Err(ClientError::Refused(response));
                }
                Ok(response)
            },
            proceed,
        )?;
        if matches!(response.status, 200 | 201) {
            Ok(response)
        } else {
            Err(ClientError::Refused(response))
        }
    }

    /// Reads `size` bytes of the content at `url` in ranges of at most 256 KiB,
    /// writing them to `output`. Every partial response must name exactly the
    /// range asked for and the total, and carry exactly its bytes.
    pub(crate) fn read_ranges(
        &self,
        url: &str,
        headers: &[(String, String)],
        size: u64,
        retry: Retry,
        output: &mut dyn Write,
    ) -> Result<(), ReadError> {
        let mut offset = 0;
        while offset < size {
            let length = (size - offset).min(CHUNK);
            let last = offset + length - 1;
            let mut all = headers.to_vec();
            all.push(("Range".into(), format!("bytes={offset}-{last}")));
            let response = self.send("GET", url, &all, &[], retry)?;
            match response.status {
                206 => {
                    let expected = format!("bytes {offset}-{last}/{size}");
                    if !response.headers.iter().any(|(key, value)| {
                        key.eq_ignore_ascii_case("content-range") && *value == expected
                    }) {
                        return Err(ReadError::ContentRange);
                    }
                }
                // The whole content, when one range covers all of it.
                200 if offset == 0 && length == size => {}
                200 => return Err(ReadError::NotRanged),
                _ => return Err(ReadError::Client(ClientError::Refused(response))),
            }
            if response.body.len() as u64 != length {
                return Err(ReadError::Length);
            }
            output
                .write_all(&response.body)
                .map_err(|_| ReadError::Output)?;
            offset += length;
        }
        Ok(())
    }
}

/// Exponential backoff with jitter: between half and all of 1 s, 2 s, 4 s…,
/// and never shorter than the wait the server asked for.
fn backoff(attempt: u32, retry_after: Option<Duration>) -> Duration {
    let ceiling = 1000_u64 << attempt.min(5);
    let jitter = uuid::Uuid::new_v4().as_u128() % u128::from(ceiling / 2 + 1);
    Duration::from_millis(ceiling / 2 + jitter as u64).max(retry_after.unwrap_or_default())
}

/// Sends `total` bytes of `input` to a resumable upload session in 256 KiB
/// chunks. `put` sends one chunk with its `Content-Range`; `proceed` may stop
/// the upload before each chunk. Returns the completing response, or the first
/// response that neither completes nor continues the upload.
fn send_chunks<E: From<DriveError>>(
    total: u64,
    input: &mut dyn Read,
    put: &mut dyn FnMut(String, Vec<u8>) -> Result<DriveResponse, E>,
    proceed: &mut dyn FnMut(u64) -> Result<(), E>,
) -> Result<DriveResponse, E> {
    let mut sent = 0;
    loop {
        proceed(sent)?;
        let count = (total - sent).min(CHUNK) as usize;
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
