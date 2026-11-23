//! What every S3 request has in common: SigV4 signing with the person's AWS CLI credentials,
//! fetching them again once when S3 says they expired, retrying throttling and server
//! failures with backoff, and reading S3's refusals as sync's recovery states. The adapters
//! (`S3Remote`, and later the bucket check and multipart uploads) build on this.
use std::ops::Deref;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use aws_credential_types::Credentials as SigningCredentials;
use aws_sigv4::http_request::{
    PayloadChecksumKind, PercentEncodingMode, SignableBody, SignableRequest, SigningSettings,
    UriPathNormalizationMode, sign,
};
use aws_sigv4::sign::v4;
use aws_smithy_runtime_api::client::identity::Identity;

use super::provider::{CredentialSource, S3Request, S3Response, S3Target, S3Transport};
use super::xml::{ErrorBody, error_body};
use super::{AwsCliError, S3TransportError};
use crate::sync::remote::RemoteError;

const MAX_RETRIES: u32 = 4;
/// The longest `Retry-After` a call waits out itself.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

/// One request, before it is signed. `key` is a plain object key, or empty for the bucket.
pub struct S3Call<'a> {
    pub method: &'static str,
    pub key: &'a str,
    pub query: &'a [(&'a str, &'a str)],
    pub headers: &'a [(&'a str, String)],
    pub body: &'a [u8],
}

impl<'a> S3Call<'a> {
    pub fn get(key: &'a str, query: &'a [(&'a str, &'a str)]) -> Self {
        Self {
            method: "GET",
            key,
            query,
            headers: &[],
            body: &[],
        }
    }
}

/// A value the client borrows, or shares with whoever else holds it.
enum Held<'a, T: ?Sized> {
    Borrowed(&'a T),
    Shared(Arc<T>),
}

impl<T: ?Sized> Deref for Held<'_, T> {
    type Target = T;

    fn deref(&self) -> &T {
        match self {
            Self::Borrowed(value) => value,
            Self::Shared(value) => value,
        }
    }
}

pub struct S3Client<'a> {
    target: S3Target,
    credentials: Held<'a, dyn CredentialSource + 'a>,
    transport: Held<'a, dyn S3Transport + 'a>,
    pause: Box<dyn Fn(Duration) + Send + Sync + 'a>,
}

impl<'a> S3Client<'a> {
    pub fn new(
        target: S3Target,
        credentials: &'a dyn CredentialSource,
        transport: &'a dyn S3Transport,
    ) -> Self {
        Self {
            target,
            credentials: Held::Borrowed(credentials),
            transport: Held::Borrowed(transport),
            pause: Box::new(std::thread::sleep),
        }
    }

    /// A client that keeps what it signs and sends with alive, so nothing outlives it.
    pub fn shared(
        target: S3Target,
        credentials: Arc<dyn CredentialSource>,
        transport: Arc<dyn S3Transport>,
    ) -> S3Client<'static> {
        S3Client {
            target,
            credentials: Held::Shared(credentials),
            transport: Held::Shared(transport),
            pause: Box::new(std::thread::sleep),
        }
    }

    /// Replace the wait between retries, so tests control time.
    pub fn with_pause(mut self, pause: impl Fn(Duration) + Send + Sync + 'a) -> Self {
        self.pause = Box::new(pause);
        self
    }

    pub fn target(&self) -> &S3Target {
        &self.target
    }

    /// Waits as a retry does.
    pub(crate) fn wait(&self, wait: Duration) {
        (self.pause)(wait);
    }

    /// Signs and sends. Returns the answer whatever its status, once the retries below are
    /// spent; only a failure to get an answer, or to get credentials, is an error.
    ///
    /// - Credentials S3 reports as expired are fetched again, once.
    /// - Throttling (`SlowDown`, 429, 503) and server failures (500, 502, 504) are repeated
    ///   up to four times with jittered backoff. A write that S3 applied before its answer was
    ///   lost is safe to repeat: it was conditional, so the repeat is refused and the caller
    ///   reads what is stored.
    pub fn send(&self, call: &S3Call<'_>) -> Result<S3Response, RemoteError> {
        let url = self.target.url(call.key, call.query);
        let mut renewed = false;
        let mut attempt = 0;
        loop {
            let credentials = self.credentials.credentials().map_err(credentials_error)?;
            let request = sign_request(&self.target, &credentials, call, &url)?;
            let response = self.transport.send(request).map_err(transport_error)?;
            if response.status < 400 {
                return Ok(response);
            }
            let code = error_code(&response);
            let mismatch = code.as_deref() == Some("SignatureDoesNotMatch");
            if credentials_expired(response.status, code.as_deref())
                || response.status == 401
                || mismatch
                || ended_session_on_head(call.method, &response)
            {
                if !renewed {
                    renewed = true;
                    self.credentials.forget();
                    continue;
                }
                // A mismatch that persists is not an ended session; the caller words it.
                if !mismatch && !self.credentials.can_sign_in() {
                    // Not an ended session, which signing in would mend: the key is wrong.
                    return Err(RemoteError::Other(
                        "S3 refused the access key of this AWS profile. Check the profile's keys with the AWS CLI".into(),
                    ));
                }
            }
            let retry_after = match response.status {
                503 | 429 => retry_after(&response),
                500 | 502 | 504 => None,
                _ if code.as_deref() == Some("SlowDown") => retry_after(&response),
                _ => return Ok(response),
            };
            if attempt == MAX_RETRIES || retry_after.is_some_and(|wait| wait > MAX_RETRY_AFTER) {
                return Ok(response);
            }
            tracing::debug!(
                status = response.status,
                attempt,
                "s3 request will be repeated"
            );
            (self.pause)(backoff(attempt, retry_after));
            attempt += 1;
        }
    }
}

fn sign_request(
    target: &S3Target,
    credentials: &super::Credentials,
    call: &S3Call<'_>,
    url: &str,
) -> Result<S3Request, RemoteError> {
    let unsignable = || RemoteError::Other("ticketd could not sign the S3 request".into());
    let identity: Identity = SigningCredentials::new(
        credentials.access_key_id.clone(),
        credentials.secret_access_key.clone(),
        credentials.session_token.clone(),
        None,
        "aws-cli",
    )
    .into();
    let mut settings = SigningSettings::default();
    // What S3 asks of a signature: the payload hash as a signed header, the path as sent.
    settings.payload_checksum_kind = PayloadChecksumKind::XAmzSha256;
    settings.percent_encoding_mode = PercentEncodingMode::Single;
    settings.uri_path_normalization_mode = UriPathNormalizationMode::Disabled;
    let params = v4::SigningParams::builder()
        .identity(&identity)
        .region(target.region())
        .name("s3")
        .time(SystemTime::now())
        .settings(settings)
        .build()
        .map_err(|_| unsignable())?
        .into();
    let signable = SignableRequest::new(
        call.method,
        url,
        call.headers
            .iter()
            .map(|(name, value)| (*name, value.as_str())),
        SignableBody::Bytes(call.body),
    )
    .map_err(|_| unsignable())?;
    let (instructions, _signature) = sign(signable, &params)
        .map_err(|_| unsignable())?
        .into_parts();
    let mut headers: Vec<(String, String)> = call
        .headers
        .iter()
        .map(|(name, value)| ((*name).to_owned(), value.clone()))
        .collect();
    headers.extend(
        instructions
            .headers()
            .map(|(name, value)| (name.to_owned(), value.to_owned())),
    );
    Ok(S3Request {
        method: call.method,
        url: url.to_owned(),
        headers,
        body: call.body.to_vec(),
    })
}

fn credentials_error(error: AwsCliError) -> RemoteError {
    if error.needs_sign_in() {
        RemoteError::Unauthorized
    } else {
        // The CLI's own words: they hold no credential.
        RemoteError::Other(error.to_string())
    }
}

fn transport_error(error: S3TransportError) -> RemoteError {
    match error {
        S3TransportError::Offline => RemoteError::Offline,
        S3TransportError::NotAllowed | S3TransportError::Unreadable => {
            RemoteError::Other(error.to_string())
        }
    }
}

/// The error body of a response, if it has one.
pub(crate) fn error_of(response: &S3Response) -> Option<ErrorBody> {
    error_body(&response.body)
}

fn error_code(response: &S3Response) -> Option<String> {
    error_of(response).map(|error| error.code)
}

/// The codes S3 uses when the credentials, not the request, are the problem.
fn credentials_expired(status: u16, code: Option<&str>) -> bool {
    matches!(status, 400 | 401 | 403)
        && matches!(
            code,
            Some(
                "ExpiredToken"
                    | "ExpiredTokenException"
                    | "InvalidToken"
                    | "TokenRefreshRequired"
                    | "InvalidAccessKeyId"
                    | "InvalidClientTokenId"
            )
        )
}

/// A HEAD answer has no body, so an ended or revoked session shows only as a refusal that
/// names no region. S3 names the bucket's region even in a refusal of a request that was
/// signed well, so a refusal without it is the credentials'.
pub(crate) fn ended_session_on_head(method: &str, response: &S3Response) -> bool {
    method == "HEAD"
        && matches!(response.status, 400 | 401 | 403)
        && response.header("x-amz-bucket-region").is_none()
}

fn retry_after(response: &S3Response) -> Option<Duration> {
    response
        .header("retry-after")?
        .trim()
        .parse()
        .ok()
        .map(Duration::from_secs)
}

/// Exponential backoff with jitter: between half and all of 1 s, 2 s, 4 s…, and never
/// shorter than the wait the server asked for.
fn backoff(attempt: u32, retry_after: Option<Duration>) -> Duration {
    let ceiling = 1000_u64 << attempt.min(5);
    let jitter = uuid::Uuid::new_v4().as_u128() % u128::from(ceiling / 2 + 1);
    Duration::from_millis(ceiling / 2 + jitter as u64).max(retry_after.unwrap_or_default())
}

/// What a response S3 refused means to sync. `NoSuchKey`, `NoSuchVersion` and the
/// conditional-write statuses are for the caller to read first; this is for the rest.
pub fn refusal(response: &S3Response) -> RemoteError {
    let error = error_of(response).unwrap_or_default();
    let code = error.code.as_str();
    if credentials_expired(response.status, Some(code)) || response.status == 401 {
        return RemoteError::Unauthorized;
    }
    match (response.status, code) {
        (404, "NoSuchBucket") => RemoteError::FolderMissing,
        (404, "NoSuchKey" | "NoSuchVersion") => RemoteError::NotFound,
        (503 | 429, _) | (_, "SlowDown") => RemoteError::RateLimited {
            retry_after: retry_after(response),
        },
        (500 | 502 | 504, _) | (_, "RequestTimeout" | "InternalError" | "ServiceUnavailable") => {
            RemoteError::Offline
        }
        (507, _) => RemoteError::StorageFull,
        (_, "SignatureDoesNotMatch") => RemoteError::Other(
            "S3 rejected the request's signature. The profile's secret key may be wrong, or the region or endpoint it signs for; check the profile with the AWS CLI".into(),
        ),
        (_, "RequestTimeTooSkewed") => RemoteError::Other(
            "S3 refused the request because this computer's clock is wrong; correct the date and time".into(),
        ),
        (403, "AccessDenied") => RemoteError::Other(format!(
            "S3 denied access: {}",
            describe(&error.message, "the credentials may not use this bucket")
        )),
        _ => RemoteError::Other(format!(
            "S3 refused the request ({}{}): {}",
            response.status,
            if code.is_empty() {
                String::new()
            } else {
                format!(" {code}")
            },
            describe(&error.message, "no reason given")
        )),
    }
}

fn describe(message: &str, otherwise: &str) -> String {
    if message.is_empty() {
        otherwise.to_owned()
    } else {
        message.chars().take(300).collect()
    }
}
