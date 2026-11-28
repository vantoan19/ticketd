//! The HTTP seam under the GitHub connector. Tests substitute fixtures here;
//! nothing above this file knows which transport is in use.

use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    /// Used by the publication workflow, not by discovery.
    Post,
}

#[cfg(test)]
#[derive(Clone)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

// Headers may carry a credential, so they are deliberately left out.
#[cfg(test)]
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
#[cfg(test)]
#[derive(Debug, Clone)]
pub struct TransportError {
    pub message: String,
    /// True when the failure happened before any request bytes could have
    /// reached the server (DNS, refused connection, no route), so the request
    /// was certainly not processed. A timeout or a dropped connection after the
    /// request went out is not: the server may have acted on it.
    pub before_send: bool,
}

#[cfg(test)]
impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[cfg(test)]
impl From<String> for TransportError {
    fn from(message: String) -> Self {
        Self {
            message,
            before_send: false,
        }
    }
}

#[cfg(test)]
impl From<&str> for TransportError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

/// Sends one request. An `Err` means no HTTP response was obtained (DNS, TLS,
/// connection, timeout); any status code, including 4xx and 5xx, is an `Ok`.
#[cfg(test)]
pub trait HttpTransport: Send + Sync {
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, TransportError>;
}
