//! Linear's authenticated GraphQL transport. Error text from the tracker can
//! contain credentials or issue content, so only status and error codes cross it.
use std::{
    cell::Cell,
    collections::HashSet,
    time::{Duration, SystemTime},
};

use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use ticketd_source_sdk::{ErrorCode, ExtensionError, RequestContext};
use ureq::http::HeaderValue;

const ENDPOINT: &str = "https://api.linear.app/graphql";
const QUERIES: &str = include_str!("linear.graphql");
pub(crate) const PAGE_SIZE: usize = 50;

pub(crate) struct Client {
    endpoint: String,
    agent: ureq::Agent,
}

impl Client {
    pub(crate) fn new() -> Result<Self, ExtensionError> {
        let endpoint = endpoint()?;
        let builder = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(24)))
            .http_status_as_error(false)
            .max_redirects(0)
            .max_redirects_will_error(false);
        let builder = if endpoint == ENDPOINT {
            builder
        } else {
            builder.proxy(None)
        };
        Ok(Self {
            endpoint,
            agent: builder.build().into(),
        })
    }

    pub(crate) fn with_key<'a>(
        &'a self,
        context: &'a RequestContext<'a>,
        key: &str,
    ) -> Result<Graphql<'a>, ExtensionError> {
        let authorization = HeaderValue::from_str(key).map_err(|_| {
            ExtensionError::new(
                ErrorCode::Unauthenticated,
                "the Linear API key is not valid",
            )
        })?;
        Ok(Graphql {
            client: self,
            context,
            authorization,
            completed: Cell::new(0),
        })
    }
}

#[cfg(not(debug_assertions))]
fn endpoint() -> Result<String, ExtensionError> {
    Ok(ENDPOINT.into())
}

#[cfg(debug_assertions)]
fn endpoint() -> Result<String, ExtensionError> {
    use url::{Host, Url};

    let Some(raw) = std::env::var_os("LINEAR_GRAPHQL_TEST_ENDPOINT") else {
        return Ok(ENDPOINT.into());
    };
    let denied = || {
        ExtensionError::new(
            ErrorCode::Protocol,
            "the Linear test endpoint must be a numeric loopback HTTP /graphql URL",
        )
    };
    let url = Url::parse(raw.to_str().ok_or_else(denied)?).map_err(|_| denied())?;
    let loopback = match url.host() {
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        _ => false,
    };
    if !loopback
        || url.scheme() != "http"
        || url.path() != "/graphql"
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(denied());
    }
    Ok(url.into())
}

pub(crate) struct Graphql<'a> {
    client: &'a Client,
    context: &'a RequestContext<'a>,
    authorization: HeaderValue,
    completed: Cell<u32>,
}

impl Graphql<'_> {
    pub(crate) fn request<T: DeserializeOwned>(
        &self,
        operation: &str,
        variables: Value,
        path: &[&str],
    ) -> Result<T, ExtensionError> {
        self.send(operation, variables, path, false)
    }

    pub(crate) fn create_issue<T: DeserializeOwned>(
        &self,
        input: Value,
    ) -> Result<T, ExtensionError> {
        self.send(
            "LinearPublish",
            json!({"input": input}),
            &["issueCreate"],
            true,
        )
    }

    fn send<T: DeserializeOwned>(
        &self,
        operation: &str,
        variables: Value,
        path: &[&str],
        publishing: bool,
    ) -> Result<T, ExtensionError> {
        if self.context.is_canceled() {
            return Err(ExtensionError::new(
                ErrorCode::NotSent,
                "the Linear request was canceled",
            ));
        }
        let payload = json!({"operationName": operation, "query": QUERIES, "variables": variables});
        let mut response = self
            .client
            .agent
            .post(&self.client.endpoint)
            .header("Authorization", self.authorization.clone())
            .header("Content-Type", "application/json")
            .send(payload.to_string())
            .map_err(|error| {
                let code = match error {
                    ureq::Error::HostNotFound | ureq::Error::ConnectionFailed => ErrorCode::NotSent,
                    _ => ErrorCode::Unavailable,
                };
                ExtensionError::new(code, "could not reach the Linear API")
            })?;
        let status = response.status().as_u16();
        // The GraphQL read error codes do not establish when a mutation failed.
        if publishing && !(200..300).contains(&status) {
            return Err(unconfirmed_creation());
        }
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(retry_after);
        match status {
            401 => return Err(failure(ErrorCode::Unauthenticated)),
            403 => return Err(failure(ErrorCode::Forbidden)),
            429 => return Err(ExtensionError::rate_limited(retry_after)),
            500..=599 => return Err(failure(ErrorCode::Unavailable)),
            200..=299 | 400 => {}
            _ => return Err(failure(ErrorCode::Protocol)),
        }
        let bytes = response
            .body_mut()
            .with_config()
            .limit(8 * 1024 * 1024)
            .read_to_vec()
            .map_err(|_| failure(ErrorCode::Unavailable))?;
        let envelope: Envelope =
            serde_json::from_slice(&bytes).map_err(|_| failure(ErrorCode::Protocol))?;
        if !envelope.errors.is_empty() {
            if publishing {
                return Err(unconfirmed_creation());
            }
            let code = envelope
                .errors
                .iter()
                .find_map(GraphqlError::classify)
                .unwrap_or(ErrorCode::Protocol);
            return Err(if code == ErrorCode::RateLimited {
                ExtensionError::rate_limited(retry_after)
            } else {
                failure(code)
            });
        }
        if status >= 400 {
            return Err(failure(ErrorCode::Protocol));
        }
        let mut data = envelope.data.ok_or_else(|| failure(ErrorCode::Protocol))?;
        for part in path {
            data = data
                .as_object_mut()
                .and_then(|object| object.remove(*part))
                .filter(|value| !value.is_null())
                .ok_or_else(|| failure(ErrorCode::Protocol))?;
        }
        let value = serde_json::from_value(data).map_err(|_| failure(ErrorCode::Protocol))?;
        let completed = self.completed.get().saturating_add(1);
        self.completed.set(completed);
        self.context.progress(completed, None)?;
        Ok(value)
    }

    /// Walk a single GraphQL connection with its own cursor. An independently
    /// fetched first page (such as an issue's labels) can seed the walk.
    pub(crate) fn all<T: DeserializeOwned>(
        &self,
        operation: &str,
        mut variables: Value,
        path: &[&str],
        first: Option<Page<T>>,
    ) -> Result<Vec<T>, ExtensionError> {
        variables["first"] = json!(PAGE_SIZE);
        let mut page = match first {
            Some(page) => page,
            None => self.request(operation, variables.clone(), path)?,
        };
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        loop {
            let cursor = page.next_cursor()?;
            items.append(&mut page.nodes);
            let Some(cursor) = cursor else {
                return Ok(items);
            };
            if !seen.insert(cursor.clone()) {
                return Err(ExtensionError::new(
                    ErrorCode::Protocol,
                    "Linear repeated a continuation cursor",
                ));
            }
            variables["after"] = json!(cursor);
            page = self.request(operation, variables.clone(), path)?;
        }
    }
}

#[derive(Deserialize)]
struct Envelope {
    data: Option<Value>,
    #[serde(default)]
    errors: Vec<GraphqlError>,
}

#[derive(Deserialize)]
struct GraphqlError {
    #[serde(default)]
    extensions: Value,
}

impl GraphqlError {
    fn classify(&self) -> Option<ErrorCode> {
        [self.extensions.get("code"), self.extensions.get("type")]
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|code| code.to_ascii_uppercase().replace(['_', '-', ' '], ""))
            .find_map(|code| match code.as_str() {
                "AUTHENTICATIONERROR" | "UNAUTHENTICATED" | "INVALIDAPIKEY" => {
                    Some(ErrorCode::Unauthenticated)
                }
                "FORBIDDEN" | "FORBIDDENERROR" | "PERMISSIONDENIED" => Some(ErrorCode::Forbidden),
                "NOTFOUND" | "ENTITYNOTFOUND" => Some(ErrorCode::NotFound),
                "RATELIMITED" => Some(ErrorCode::RateLimited),
                "INTERNALSERVERERROR" | "SERVICEUNAVAILABLE" => Some(ErrorCode::Unavailable),
                _ => None,
            })
    }
}

fn unconfirmed_creation() -> ExtensionError {
    ExtensionError::new(
        ErrorCode::Unavailable,
        "Linear did not confirm whether it created the issue",
    )
}

fn failure(code: ErrorCode) -> ExtensionError {
    let message = match code {
        ErrorCode::Unauthenticated => "Linear did not accept the personal API key",
        ErrorCode::Forbidden => "the Linear API key does not have access",
        ErrorCode::NotFound => "the Linear record could not be found",
        ErrorCode::Unavailable => "the Linear API is temporarily unavailable",
        _ => "Linear returned an unexpected GraphQL response",
    };
    ExtensionError::new(code, message)
}

fn retry_after(value: &str) -> Option<u64> {
    value.parse().ok().or_else(|| {
        let until = httpdate::parse_http_date(value).ok()?;
        Some(
            until
                .duration_since(SystemTime::now())
                .unwrap_or_default()
                .as_secs(),
        )
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page<T> {
    pub(crate) nodes: Vec<T>,
    page_info: PageInfo,
}

impl<T> Page<T> {
    pub(crate) fn next_cursor(&self) -> Result<Option<String>, ExtensionError> {
        if !self.page_info.has_next_page {
            return Ok(None);
        }
        self.page_info
            .end_cursor
            .clone()
            .filter(|cursor| !cursor.is_empty())
            .map(Some)
            .ok_or_else(|| {
                ExtensionError::new(ErrorCode::Protocol, "Linear omitted a continuation cursor")
            })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}
