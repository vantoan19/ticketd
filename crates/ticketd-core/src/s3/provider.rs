//! What the S3 adapter sends requests through and signs them with: the controlled HTTP
//! transport, the one bucket it may reach, and where credentials come from.
use std::fmt;
use std::time::Duration;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

use super::{AwsCliError, Credentials, ProfileCredentials};

/// Where the credentials of a signed request come from. [`ProfileCredentials`] is the
/// production source; tests give a fake one.
pub trait CredentialSource: Send + Sync {
    /// The credentials to sign with now, fetched again when the kept ones are about to expire.
    fn credentials(&self) -> Result<Credentials, AwsCliError>;

    /// Drops what is kept, because the service refused the credentials before their expiry.
    fn forget(&self);
}

impl CredentialSource for ProfileCredentials {
    fn credentials(&self) -> Result<Credentials, AwsCliError> {
        self.access().map(|access| access.credentials)
    }

    fn forget(&self) {
        ProfileCredentials::forget(self);
    }
}

/// Everything except the unreserved characters, as SigV4 and S3 want a key or a query value.
const ENCODED: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

pub(crate) fn encode(text: &str) -> String {
    utf8_percent_encode(text, ENCODED).to_string()
}

/// The one bucket ticketd talks to, and how to reach it. Both the adapter that builds
/// requests and the transport that sends them hold the same value, and the transport sends
/// nothing that is not for this bucket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct S3Target {
    bucket: String,
    region: String,
    /// `scheme://host[:port]` of an S3-compatible service; `None` is AWS.
    endpoint: Option<String>,
}

impl S3Target {
    /// `region` is the bucket's own (HeadBucket reports it). `endpoint_url` is the profile's
    /// S3 endpoint for an S3-compatible service, with no path.
    pub fn new(
        bucket: &str,
        region: &str,
        endpoint_url: Option<&str>,
    ) -> Result<Self, S3TargetError> {
        let valid_bucket = (3..=63).contains(&bucket.len())
            && bucket
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.'))
            && !bucket.contains("..")
            && !bucket.starts_with(['.', '-'])
            && !bucket.ends_with(['.', '-']);
        if !valid_bucket {
            return Err(S3TargetError::Bucket);
        }
        if region.is_empty()
            || !region
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(S3TargetError::Region);
        }
        let endpoint = endpoint_url
            .map(|text| {
                let url = url::Url::parse(text).map_err(|_| S3TargetError::Endpoint)?;
                let plain = matches!(url.scheme(), "http" | "https")
                    && url.host_str().is_some()
                    && matches!(url.path(), "" | "/")
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.username().is_empty()
                    && url.password().is_none();
                if !plain {
                    return Err(S3TargetError::Endpoint);
                }
                Ok(url.origin().ascii_serialization())
            })
            .transpose()?;
        Ok(Self {
            bucket: bucket.to_owned(),
            region: region.to_owned(),
            endpoint,
        })
    }

    pub fn bucket(&self) -> &str {
        &self.bucket
    }

    pub fn region(&self) -> &str {
        &self.region
    }

    /// The endpoint of an S3-compatible service, as `scheme://host[:port]`.
    pub fn endpoint(&self) -> Option<&str> {
        self.endpoint.as_deref()
    }

    /// AWS puts the bucket in the host unless its name has a dot, which a certificate for
    /// `*.s3.<region>.amazonaws.com` does not cover. Other services take it in the path.
    fn virtual_hosted(&self) -> bool {
        self.endpoint.is_none() && !self.bucket.contains('.')
    }

    fn origin(&self) -> String {
        match &self.endpoint {
            Some(endpoint) => endpoint.clone(),
            None => {
                let suffix = if self.region.starts_with("cn-") {
                    "amazonaws.com.cn"
                } else {
                    "amazonaws.com"
                };
                if self.virtual_hosted() {
                    format!("https://{}.s3.{}.{suffix}", self.bucket, self.region)
                } else {
                    format!("https://s3.{}.{suffix}", self.region)
                }
            }
        }
    }

    fn path_prefix(&self) -> String {
        if self.virtual_hosted() {
            String::new()
        } else {
            format!("/{}", self.bucket)
        }
    }

    /// The URL of `key` (empty for the bucket itself), with `query` encoded and sorted by name.
    /// `key` is a plain, unencoded key; `/` stays a separator.
    pub fn url(&self, key: &str, query: &[(&str, &str)]) -> String {
        let path: Vec<String> = key.split('/').map(encode).collect();
        let mut url = format!("{}{}/{}", self.origin(), self.path_prefix(), path.join("/"));
        let mut query: Vec<(&str, &str)> = query.to_vec();
        query.sort_unstable();
        for (index, (name, value)) in query.iter().enumerate() {
            url.push(if index == 0 { '?' } else { '&' });
            url.push_str(&encode(name));
            if !value.is_empty() {
                url.push('=');
                url.push_str(&encode(value));
            }
        }
        url
    }

    /// Whether [`UreqS3Transport`] sends this request: reading or writing objects of this
    /// bucket at its endpoint. An upload in parts begins and completes with a POST and is
    /// abandoned with a DELETE. No credential or signature goes anywhere else.
    pub fn allows(&self, method: &str, url: &str) -> bool {
        if !matches!(method, "GET" | "HEAD" | "PUT" | "POST" | "DELETE") {
            return false;
        }
        let Ok(parsed) = url::Url::parse(url) else {
            return false;
        };
        let origin = self.origin();
        let prefix = self.path_prefix();
        let path = parsed.path();
        parsed.origin().ascii_serialization() == origin
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.fragment().is_none()
            && (prefix.is_empty() && path.starts_with('/')
                || path == prefix
                || path
                    .strip_prefix(prefix.as_str())
                    .is_some_and(|rest| rest.starts_with('/')))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum S3TargetError {
    #[error("that is not a valid S3 bucket name")]
    Bucket,
    #[error("that is not a valid AWS region")]
    Region,
    #[error("the S3 endpoint must be a plain http or https address")]
    Endpoint,
    #[error("the key prefix may hold only letters, digits and - _ . /, and must not start with /")]
    Prefix,
}

/// A request already signed. Never derive `Debug`: the headers carry the signature and the
/// session token.
#[derive(Clone)]
pub struct S3Request {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl fmt::Debug for S3Request {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3Request")
            .field("method", &self.method)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct S3Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl fmt::Debug for S3Response {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3Response")
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

impl S3Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Why the transport has no answer to give.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum S3TransportError {
    /// The service cannot be reached.
    #[error("the S3 service cannot be reached")]
    Offline,
    /// The request is not for the configured bucket, so it was not sent.
    #[error("ticketd refused a request that is not for the configured S3 bucket")]
    NotAllowed,
    /// The answer was too large or cut short.
    #[error("S3 returned an unreadable response")]
    Unreadable,
}

pub trait S3Transport: Send + Sync {
    fn send(&self, request: S3Request) -> Result<S3Response, S3TransportError>;
}

/// The longest answer the transport reads: a chunk of an object, or a page of a listing.
pub(crate) const MAX_RESPONSE: u64 = 12 * 1024 * 1024;

/// Sends over HTTPS (or HTTP for a local S3-compatible service) with `ureq`: no redirects,
/// and only requests that [`S3Target::allows`].
pub struct UreqS3Transport {
    target: S3Target,
    agent: ureq::Agent,
}

impl UreqS3Transport {
    pub fn new(target: S3Target) -> Self {
        Self {
            target,
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(120)))
                .http_status_as_error(false)
                .max_redirects(0)
                .max_redirects_will_error(false)
                .build()
                .into(),
        }
    }
}

impl S3Transport for UreqS3Transport {
    fn send(&self, request: S3Request) -> Result<S3Response, S3TransportError> {
        if !self.target.allows(request.method, &request.url) {
            return Err(S3TransportError::NotAllowed);
        }
        let outcome = match request.method {
            "GET" => {
                let mut builder = self.agent.get(&request.url);
                for (name, value) in &request.headers {
                    builder = builder.header(name, value);
                }
                builder.call()
            }
            "HEAD" => {
                let mut builder = self.agent.head(&request.url);
                for (name, value) in &request.headers {
                    builder = builder.header(name, value);
                }
                builder.call()
            }
            "DELETE" => {
                let mut builder = self.agent.delete(&request.url);
                for (name, value) in &request.headers {
                    builder = builder.header(name, value);
                }
                builder.call()
            }
            "POST" => {
                let mut builder = self.agent.post(&request.url);
                for (name, value) in &request.headers {
                    builder = builder.header(name, value);
                }
                builder.send(&request.body)
            }
            _ => {
                let mut builder = self.agent.put(&request.url);
                for (name, value) in &request.headers {
                    builder = builder.header(name, value);
                }
                builder.send(&request.body)
            }
        };
        let mut response = outcome.map_err(|_| S3TransportError::Offline)?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_owned(), value.to_owned()))
            })
            .collect();
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE)
            .read_to_vec()
            .map_err(|_| S3TransportError::Unreadable)?;
        Ok(S3Response {
            status,
            headers,
            body,
        })
    }
}
