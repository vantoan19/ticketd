//! The versioned contract between the ticketd engine and a ticket source
//! connector.
//!
//! A connector translates one provider's operations into the neutral types
//! below. It never touches the workspace database: ticketd's engine decides
//! when to call it, and ticketd's workflows persist whatever it returns.
//! Connectors are compiled in; there is no user-installed extension runtime.
//!
//! Changing a signature or the meaning of a type here is a contract change and
//! must bump [`CONTRACT_VERSION`]. Adding an optional capability is not.

use serde::{Deserialize, Serialize};

use super::schema::{ChoiceOption, ConfigSchema, ConfigValues, FieldIssue};

/// The contract version this build of ticketd speaks. The engine refuses to
/// register a connector that declares a different one.
pub const CONTRACT_VERSION: u32 = 1;

/// What a connector can do beyond describing and validating its configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    /// List issues that match the discovery configuration.
    Discover,
    /// Fetch one issue by identity, including its external state.
    Fetch,
    /// Create an ordinary issue from a local ticket (optional).
    Publish,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectorDescriptor {
    /// Stable provider id, such as `github`. It is part of every external identity.
    pub provider: String,
    pub name: String,
    pub contract_version: u32,
    pub capabilities: Vec<Capability>,
    pub schema: ConfigSchema,
}

/// The account the connector is acting as. Never contains a credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub account: String,
}

/// An external issue's immutable identity. Titles, numbers and repository
/// names can change; this cannot. Never match issues by display text.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ExternalIdentity {
    pub provider: String,
    pub id: String,
}

/// Enough to ask the connector for an issue again. `locator` is opaque to
/// ticketd and defined by the connector (for GitHub, `owner/name#number`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalRef {
    pub identity: ExternalIdentity,
    pub locator: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClosureReason {
    Completed,
    NotPlanned,
    Duplicate,
    /// The provider closed the issue without a reason ticketd recognizes.
    /// It must be flagged, never treated as completion.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ExternalState {
    Open,
    Closed { reason: ClosureReason },
}

/// An issue as the provider reports it, in provider-neutral form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalIssue {
    pub reference: ExternalRef,
    /// Human-readable name such as `owner/name#12`. Display only.
    pub display: String,
    pub url: String,
    pub title: String,
    pub body: String,
    pub state: ExternalState,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One request for a page of discovery results.
#[derive(Debug, Clone, Copy)]
pub struct DiscoveryRequest<'a> {
    pub config: &'a ConfigValues,
    /// Opaque continuation returned by the previous page; `None` starts over.
    pub cursor: Option<&'a str>,
    pub page_size: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryPage {
    pub issues: Vec<ExternalIssue>,
    /// `Some` while more results remain. A page may be empty and still have a
    /// continuation, so an empty page is never proof that discovery is done.
    pub next_cursor: Option<String>,
}

/// A request to create an ordinary issue. Reserved for the publication
/// workflow; connectors that do not declare [`Capability::Publish`] keep the
/// default implementation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishRequest {
    pub title: String,
    pub body: String,
    /// Connector-defined destination, such as `owner/name`.
    pub destination: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("{0}")]
    Unauthenticated(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{}", rate_limit_message(*.retry_after_secs))]
    RateLimited { retry_after_secs: Option<u64> },
    #[error("{0}")]
    Unavailable(String),
    #[error("unexpected response from the source: {0}")]
    Protocol(String),
    #[error("this source does not support {0}")]
    Unsupported(&'static str),
    #[error("invalid source configuration: {}", describe_issues(.0))]
    InvalidConfiguration(Vec<FieldIssue>),
    #[error("no source named '{0}' is available")]
    UnknownProvider(String),
    #[error(
        "source '{provider}' speaks connector contract {found}, but ticketd supports {CONTRACT_VERSION}"
    )]
    IncompatibleContract { provider: String, found: u32 },
}

impl SourceError {
    /// A stable machine-readable kind, so clients can branch without parsing
    /// messages.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unauthenticated(_) => "unauthenticated",
            Self::Forbidden(_) => "forbidden",
            Self::NotFound(_) => "not_found",
            Self::RateLimited { .. } => "rate_limited",
            Self::Unavailable(_) => "unavailable",
            Self::Protocol(_) => "protocol",
            Self::Unsupported(_) => "unsupported",
            Self::InvalidConfiguration(_) => "invalid_configuration",
            Self::UnknownProvider(_) => "unknown_provider",
            Self::IncompatibleContract { .. } => "incompatible_contract",
        }
    }

    /// Field-level problems, when the failure is about configuration values.
    pub fn issues(&self) -> &[FieldIssue] {
        match self {
            Self::InvalidConfiguration(issues) => issues,
            _ => &[],
        }
    }
}

fn rate_limit_message(retry_after_secs: Option<u64>) -> String {
    match retry_after_secs {
        Some(seconds) => {
            format!("the source is rate limiting requests; retry in {seconds} seconds")
        }
        None => "the source is rate limiting requests; retry later".into(),
    }
}

fn describe_issues(issues: &[FieldIssue]) -> String {
    issues
        .iter()
        .map(|issue| format!("{} {}", issue.field, issue.message))
        .collect::<Vec<_>>()
        .join("; ")
}

/// A provider integration. Every method is synchronous and may block on the
/// network; the engine never calls one while holding a database transaction.
pub trait Connector: Send + Sync {
    fn descriptor(&self) -> ConnectorDescriptor;

    /// Verifies credentials and permissions and names the acting account.
    fn check_connection(&self, config: &ConfigValues) -> Result<ConnectionInfo, SourceError>;

    /// Dynamic options for a schema field. `config` holds the current, not yet
    /// validated, values of the fields this field depends on.
    fn options(
        &self,
        field: &str,
        query: &str,
        config: &ConfigValues,
    ) -> Result<Vec<ChoiceOption>, SourceError>;

    /// Returns one page of issues matching `request.config`. Must exclude
    /// anything that is not an issue (for GitHub, pull requests).
    fn discover(&self, request: DiscoveryRequest<'_>) -> Result<DiscoveryPage, SourceError>;

    /// Returns the current form of one issue, whether or not it still matches
    /// the discovery configuration.
    fn fetch(
        &self,
        config: &ConfigValues,
        reference: &ExternalRef,
    ) -> Result<ExternalIssue, SourceError>;

    /// Creates an ordinary issue. Only called when the descriptor declares
    /// [`Capability::Publish`].
    fn publish(
        &self,
        _config: &ConfigValues,
        _request: &PublishRequest,
    ) -> Result<ExternalIssue, SourceError> {
        Err(SourceError::Unsupported("publishing"))
    }
}
