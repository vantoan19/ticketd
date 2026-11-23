//! The HTTP seam under the GitHub connector. Tests substitute fixtures here;
//! nothing above this file knows which transport is in use.

use std::{collections::BTreeMap, time::Duration};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    /// Used by the publication workflow, not by discovery.
    Post,
}

#[derive(Clone)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

// Headers may carry a credential, so they are deliberately left out.
impl std::fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Default)]
pub struct HttpResponse {
    pub status: u16,
    /// Header names are lower-cased.
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

/// Why no HTTP response was obtained.
#[derive(Debug, Clone)]
pub struct TransportError {
    pub message: String,
    /// True when the failure happened before any request bytes could have
    /// reached the server (DNS, refused connection, no route), so the request
    /// was certainly not processed. A timeout or a dropped connection after the
    /// request went out is not: the server may have acted on it.
    pub before_send: bool,
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<String> for TransportError {
    fn from(message: String) -> Self {
        Self {
            message,
            before_send: false,
        }
    }
}

impl From<&str> for TransportError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

/// Sends one request. An `Err` means no HTTP response was obtained (DNS, TLS,
/// connection, timeout); any status code, including 4xx and 5xx, is an `Ok`.
pub trait HttpTransport: Send + Sync {
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, TransportError>;
}

/// The real network, over blocking HTTPS.
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    pub fn new() -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .http_status_as_error(false)
            // Redirects are followed by the connector, which keeps the
            // credential on the API host.
            .max_redirects(0)
            .max_redirects_will_error(false)
            .build()
            .into();
        Self { agent }
    }
}

/// Describe the failure without rendering a URL or the response body.
fn describe_transport_error(error: &ureq::Error) -> &'static str {
    use std::io::ErrorKind;
    match error {
        ureq::Error::HostNotFound => "the server's address could not be found",
        ureq::Error::ConnectionFailed => "the connection could not be made",
        ureq::Error::Timeout(_) => "the request timed out",
        ureq::Error::Io(io) => match io.kind() {
            ErrorKind::ConnectionRefused => "the connection was refused",
            ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted | ErrorKind::BrokenPipe => {
                "the connection was dropped"
            }
            ErrorKind::TimedOut => "the request timed out",
            ErrorKind::NotConnected | ErrorKind::AddrNotAvailable => {
                "there is no network connection"
            }
            _ => "the network request failed",
        },
        _ => "the network request failed",
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpTransport for UreqTransport {
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, TransportError> {
        let result = match request.method {
            Method::Get => {
                let mut builder = self.agent.get(&request.url);
                for (name, value) in &request.headers {
                    builder = builder.header(name, value);
                }
                builder.call()
            }
            Method::Post => {
                let mut builder = self.agent.post(&request.url);
                for (name, value) in &request.headers {
                    builder = builder.header(name, value);
                }
                builder.send(request.body.as_deref().unwrap_or_default())
            }
        };
        let mut response = result.map_err(|error| TransportError {
            before_send: matches!(
                error,
                ureq::Error::HostNotFound
                    | ureq::Error::ConnectionFailed
                    | ureq::Error::BadUri(_)
                    | ureq::Error::Timeout(ureq::Timeout::Resolve | ureq::Timeout::Connect)
            ),
            message: describe_transport_error(&error).into(),
        })?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_ascii_lowercase(), value.to_owned()))
            })
            .collect();
        let body = response
            .body_mut()
            .read_to_vec()
            .map_err(|error| TransportError::from(describe_transport_error(&error)))?;
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[test]
    fn network_failures_read_as_sentences_without_technical_details() {
        let refused =
            describe_transport_error(&ureq::Error::Io(Error::from(ErrorKind::ConnectionRefused)));
        assert_eq!(refused, "the connection was refused");
        assert!(
            describe_transport_error(&ureq::Error::HostNotFound)
                .starts_with("the server's address could not be found")
        );
        let other = ureq::Error::TooManyRedirects;
        assert_eq!(
            describe_transport_error(&other),
            "the network request failed"
        );
    }
}
