//! The versioned contract between the ticketd engine and a ticket source
//! connector.
//!
//! A connector translates one provider's operations into the neutral types
//! below. It never touches the workspace database: ticketd's engine decides
//! when to call it, and ticketd's workflows persist whatever it returns.
//! Connectors are compiled in; there is no user-installed extension runtime.
//!
//! The contract remains internal while the first public version is being
//! prepared. Once published, changes to existing operations and types require
//! a version bump. Adding an optional capability keeps the version.

use serde::{Deserialize, Serialize};

use super::schema::{ChoiceOption, ConfigSchema, ConfigValues, FieldIssue, ValueFormat};
use super::{SignInGuidance, SourcePresentation, SummaryPart};

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
    /// Create an issue, locate it, and search for an uncertain creation (optional).
    Publish,
    /// Read an issue's comments and timeline events (optional).
    Comments,
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
    /// Canonical site identity. Empty when the provider has only one site.
    #[serde(default)]
    pub site: String,
}

/// The verified connection and answers derived from its settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionCheck {
    pub connection: ConnectionInfo,
    pub derived: DerivedConfiguration,
}

/// Configuration answers that ticketd can keep for use without a connector call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DerivedConfiguration {
    /// Parts read by discovery, named as in [`ExternalRef::partition`].
    pub partitions: Vec<String>,
    /// A stable key for filters that narrow what discovery reads within each part.
    /// An empty key means discovery does not narrow the part.
    pub discovery_scope: String,
    pub publication: DestinationRules,
}

impl Default for DerivedConfiguration {
    fn default() -> Self {
        Self {
            partitions: vec![String::new()],
            discovery_scope: String::new(),
            publication: DestinationRules::default(),
        }
    }
}

/// Destination choices and the rules for checking a destination locally.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DestinationRules {
    /// Accepted destinations in their canonical spelling. Empty when the
    /// connector cannot enumerate them.
    pub destinations: Vec<String>,
    /// Whether destination matching ignores ASCII case.
    pub case_insensitive: bool,
    pub validation: Option<DestinationValidation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DestinationValidation {
    pub format: ValueFormat,
    pub message: String,
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
    /// The part of discovery this issue belongs to, such as a repository.
    /// An empty string denotes a source that is read as one whole.
    pub partition: String,
}

impl ClosureReason {
    /// The name stored and shown for the reason (the same words GitHub's
    /// `state_reason` uses).
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::NotPlanned => "not_planned",
            Self::Duplicate => "duplicate",
            Self::Unknown => "unknown",
        }
    }

    /// The reason named by `name`; anything else, and no reason at all, is
    /// [`Self::Unknown`], never assumed to be completion.
    pub(crate) fn parse(name: Option<&str>) -> Self {
        match name {
            Some("completed") => Self::Completed,
            Some("not_planned") => Self::NotPlanned,
            Some("duplicate") => Self::Duplicate,
            _ => Self::Unknown,
        }
    }
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
    /// When the issue was opened at the source.
    pub created_at: String,
    pub updated_at: String,
    /// The source identity that opened the issue. Additive to contract 1;
    /// connectors that cannot tell leave it `None`.
    #[serde(default)]
    pub author: Option<String>,
    /// For an issue closed as a duplicate: the canonical issue, when the provider
    /// names an accessible one. Absent means the target is unknown. Additive to
    /// contract 1; connectors that cannot tell leave it `None`.
    #[serde(default)]
    pub duplicate_of: Option<ExternalRef>,
    /// Where the canonical issue can be opened, when the provider says.
    #[serde(default)]
    pub duplicate_of_url: Option<String>,
    /// The provider says the duplicate marking was withdrawn. Distinct from
    /// `duplicate_of` being `None`, which only means no target was supplied (a
    /// lookup failed or access changed) and keeps the last known one.
    #[serde(default)]
    pub duplicate_withdrawn: bool,
}

/// A comment on an external issue, as its source reports it. Authors are the
/// source's own identities, never ticketd editing agents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalComment {
    /// Stable within the issue; repeated reads of one comment return one id.
    pub id: String,
    pub author: String,
    pub body: String,
    /// Where the comment can be viewed at the source.
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
}

/// What happened in an external timeline event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", content = "reason", rename_all = "snake_case")]
pub enum ExternalEventKind {
    Closed(ClosureReason),
    Reopened,
    Assigned,
    Unassigned,
}

/// A timeline event such as a closure, reopening or assignment change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalEvent {
    pub id: String,
    pub kind: ExternalEventKind,
    /// Who acted, when the source says.
    pub actor: Option<String>,
    /// Whom an assignment change concerns.
    pub subject: Option<String>,
    pub created_at: String,
}

/// An issue's whole conversation. Order is not significant; the engine sorts
/// it chronologically.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Conversation {
    pub comments: Vec<ExternalComment>,
    pub events: Vec<ExternalEvent>,
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
    /// Parts of the discovery rules the connector could not read (a repository
    /// that is gone or inaccessible) and skipped, so the rest still ran.
    pub skipped: Vec<SkippedPartition>,
}

/// One part of the discovery rules that could not be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedPartition {
    /// The failure code of the part (`not_found` or `forbidden`).
    pub code: String,
    pub class: ErrorClass,
    pub message: String,
    /// The setting that named the part, so a preview can point at it.
    #[serde(default)]
    pub field: Option<String>,
    /// The part, as [`ExternalRef::partition`] names it.
    pub partition: String,
}

/// A request to create an ordinary issue. Connectors that do not declare
/// [`Capability::Publish`] keep the default implementation. It carries exactly
/// what the person previewed: no ticketd metadata, labels or comments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishRequest {
    pub title: String,
    pub body: String,
    /// Connector-defined destination, such as `owner/name`.
    pub destination: String,
}

/// A search for issues an earlier, uncertain publish may have created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationSearch {
    /// Exactly what the earlier attempt sent.
    pub request: PublishRequest,
    /// RFC 3339 instant before which the attempt cannot have created anything.
    pub since: String,
    /// The account the source was connected as. Whatever that account created in
    /// the window is a candidate, whatever its text now says: a teammate or an
    /// automation may have edited the title and description since.
    #[serde(default)]
    pub account: Option<String>,
}

/// What a search found. `matches` holds every issue the connector saw whose
/// title or non-empty description equals what the attempt sent. `recent` holds
/// the other issues the connected account created in the window: they are shown
/// for information and may be attached, but never block a "not created" verdict.
/// `complete` is true only when the connector read the whole window: then an
/// empty `matches` proves that nothing was created, while an incomplete read
/// proves nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationCandidates {
    pub matches: Vec<ExternalIssue>,
    #[serde(default)]
    pub recent: Vec<ExternalIssue>,
    pub complete: bool,
}

/// Where a message will be read. Guidance about signing in differs: a terminal
/// user has environment variables, a desktop user has Settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Terminal,
    Desktop,
}

/// A broad cause that a caller can handle without knowing every failure code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    Config,
    Auth,
    Transient,
    System,
}

impl ErrorClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Config => "config",
            Self::Auth => "auth",
            Self::Transient => "transient",
            Self::System => "system",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("{0}")]
    Unauthenticated(String),
    #[error("{message}")]
    SignIn {
        message: String,
        guidance: Box<SignInGuidance>,
    },
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{}", rate_limit_message(*.retry_after_secs))]
    RateLimited { retry_after_secs: Option<u64> },
    #[error("{0}")]
    Unavailable(String),
    /// The request never left this machine (no DNS answer, connection refused),
    /// so the provider certainly did not act on it. Reads as unavailable
    /// everywhere else, but a failed `publish` with it proves nothing was created.
    #[error("{0}")]
    NotSent(String),
    /// The provider answered and refused the request itself (for GitHub, a
    /// validation failure or a repository with issues disabled). Unlike
    /// [`Self::Unavailable`] and [`Self::Protocol`], nothing was created.
    #[error("{0}")]
    Rejected(String),
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

/// The kinds of failure ticketd records for a source or a ticket, with the one
/// definition of what each means for availability and scheduling. Stored codes
/// are these names; the SQL that counts unavailable tickets is generated from
/// [`Self::is_unavailable`], so Rust and SQL cannot disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailureCode {
    Unauthenticated,
    Forbidden,
    NotFound,
    RateLimited,
    Unavailable,
    Rejected,
    Protocol,
    Unsupported,
    InvalidConfiguration,
    UnknownProvider,
    IncompatibleContract,
    NotConfigured,
}

impl FailureCode {
    pub(crate) const ALL: [Self; 12] = [
        Self::Unauthenticated,
        Self::Forbidden,
        Self::NotFound,
        Self::RateLimited,
        Self::Unavailable,
        Self::Rejected,
        Self::Protocol,
        Self::Unsupported,
        Self::InvalidConfiguration,
        Self::UnknownProvider,
        Self::IncompatibleContract,
        Self::NotConfigured,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Unauthenticated => "unauthenticated",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::RateLimited => "rate_limited",
            Self::Unavailable => "unavailable",
            Self::Rejected => "rejected",
            Self::Protocol => "protocol",
            Self::Unsupported => "unsupported",
            Self::InvalidConfiguration => "invalid_configuration",
            Self::UnknownProvider => "unknown_provider",
            Self::IncompatibleContract => "incompatible_contract",
            Self::NotConfigured => "not_configured",
        }
    }

    pub(crate) fn class(self) -> ErrorClass {
        match self {
            Self::Unauthenticated | Self::Forbidden => ErrorClass::Auth,
            Self::NotFound
            | Self::Rejected
            | Self::InvalidConfiguration
            | Self::UnknownProvider
            | Self::NotConfigured => ErrorClass::Config,
            Self::RateLimited | Self::Unavailable => ErrorClass::Transient,
            Self::Protocol | Self::Unsupported | Self::IncompatibleContract => ErrorClass::System,
        }
    }

    pub(crate) fn parse(code: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|known| known.as_str() == code)
    }

    /// After this failure an externally owned ticket reads Source unavailable:
    /// the source cannot be reached, rejected the credential, denied access, no
    /// longer has the issue, answered with something unusable, or is not
    /// configured. A rate limit is delayed, not unavailable.
    pub(crate) fn is_unavailable(self) -> bool {
        match self {
            Self::Unavailable
            | Self::Unauthenticated
            | Self::Forbidden
            | Self::NotFound
            | Self::Protocol
            | Self::NotConfigured => true,
            Self::RateLimited
            | Self::Rejected
            | Self::Unsupported
            | Self::InvalidConfiguration
            | Self::UnknownProvider
            | Self::IncompatibleContract => false,
        }
    }

    /// The failure says the source as a whole cannot be read right now, so asking
    /// again for other tickets would only repeat it, and a scheduler should back
    /// off. A single issue that is gone, denied or unreadable says nothing about
    /// the others.
    pub(crate) fn interrupts_source(self) -> bool {
        match self {
            Self::Unavailable | Self::RateLimited | Self::Unauthenticated => true,
            Self::Forbidden
            | Self::NotFound
            | Self::Rejected
            | Self::Protocol
            | Self::Unsupported
            | Self::InvalidConfiguration
            | Self::UnknownProvider
            | Self::IncompatibleContract
            | Self::NotConfigured => false,
        }
    }
}

impl SourceError {
    pub(crate) fn failure_code(&self) -> FailureCode {
        match self {
            Self::Unauthenticated(_) | Self::SignIn { .. } => FailureCode::Unauthenticated,
            Self::Forbidden(_) => FailureCode::Forbidden,
            Self::NotFound(_) => FailureCode::NotFound,
            Self::RateLimited { .. } => FailureCode::RateLimited,
            Self::Unavailable(_) | Self::NotSent(_) => FailureCode::Unavailable,
            Self::Rejected(_) => FailureCode::Rejected,
            Self::Protocol(_) => FailureCode::Protocol,
            Self::Unsupported(_) => FailureCode::Unsupported,
            Self::InvalidConfiguration(_) => FailureCode::InvalidConfiguration,
            Self::UnknownProvider(_) => FailureCode::UnknownProvider,
            Self::IncompatibleContract { .. } => FailureCode::IncompatibleContract,
        }
    }

    pub fn class(&self) -> ErrorClass {
        self.failure_code().class()
    }

    /// Records an internal diagnostic without adding it to the error returned
    /// to the workflow. The adapter must omit credentials and record content.
    pub fn with_detail(self, detail: impl std::fmt::Display) -> Self {
        tracing::debug!(
            error_kind = self.code(),
            error_class = self.class().as_str(),
            error = %self,
            error_detail = %detail,
            "source operation failed"
        );
        self
    }

    /// A stable machine-readable kind, so clients can branch without parsing
    /// messages.
    pub fn code(&self) -> &'static str {
        self.failure_code().as_str()
    }

    /// Whether a failed `publish` proves the provider created nothing.
    ///
    /// True only when the provider answered and refused, or the request was
    /// never sent. A timeout, dropped connection, server error or unreadable
    /// answer proves nothing: the issue may exist, so those return false and the
    /// publication stays unresolved until someone can look.
    pub fn ruled_out_creation(&self) -> bool {
        match self {
            Self::Unauthenticated(_)
            | Self::SignIn { .. }
            | Self::Forbidden(_)
            | Self::NotFound(_)
            | Self::RateLimited { .. }
            | Self::Rejected(_)
            | Self::NotSent(_)
            | Self::Unsupported(_)
            | Self::InvalidConfiguration(_)
            | Self::UnknownProvider(_)
            | Self::IncompatibleContract { .. } => true,
            Self::Unavailable(_) | Self::Protocol(_) => false,
        }
    }

    /// Adds connector guidance at the engine boundary so all callers can format
    /// a credential error for their own surface.
    pub(crate) fn with_sign_in(self, guidance: impl FnOnce() -> SignInGuidance) -> Self {
        match self {
            Self::Unauthenticated(message) => Self::SignIn {
                message,
                guidance: Box::new(guidance()),
            },
            other => other,
        }
    }

    /// The message with the guidance that fits `surface`.
    pub fn message_for(&self, surface: Surface) -> String {
        match self {
            Self::SignIn { guidance, .. } => guidance
                .hint(surface)
                .map_or_else(|| self.to_string(), |hint| format!("{self} {hint}")),
            other => other.to_string(),
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
        .map(|issue| match &issue.field {
            Some(field) => format!("{field} {}", issue.message),
            None => issue.message.clone(),
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// A provider integration. Every method is synchronous and may block on the
/// network; the engine never calls one while holding a database transaction.
pub trait Connector: Send + Sync {
    fn descriptor(&self) -> ConnectorDescriptor;

    /// Supplies connection-specific credentials where the connector supports them.
    fn for_connection(&self, _id: &str, _config: &ConfigValues) -> Option<Box<dyn Connector>> {
        None
    }

    /// How ticketd presents this provider and its settings.
    fn presentation(&self) -> SourcePresentation {
        SourcePresentation::default()
    }

    /// Read the rules aloud in one line. The values can still be a draft, so
    /// this operation does not validate, contact the provider, or save anything.
    fn configuration_summary(&self, _config: &ConfigValues) -> Vec<SummaryPart> {
        Vec::new()
    }

    /// Checks normalized settings before previewing or saving them. A problem
    /// can point at one field, or describe the configuration as a whole.
    fn validate(&self, _config: &ConfigValues) -> Result<Vec<FieldIssue>, SourceError> {
        Ok(Vec::new())
    }

    /// Verifies credentials and permissions, and derives how ticketd will use
    /// this configuration. A failed check leaves previously derived data valid
    /// for offline workflows.
    fn check_connection(&self, config: &ConfigValues) -> Result<ConnectionCheck, SourceError>;

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

    /// Returns every comment and timeline event of one issue, following the
    /// provider's paging itself. Only called when the descriptor declares
    /// [`Capability::Comments`].
    fn conversation(
        &self,
        _config: &ConfigValues,
        _reference: &ExternalRef,
    ) -> Result<Conversation, SourceError> {
        Err(SourceError::Unsupported("comments"))
    }

    /// Provides all three publication operations when the descriptor declares
    /// [`Capability::Publish`]. This method does no provider work.
    fn publication(&self) -> Option<&dyn Publication> {
        None
    }
}

/// Publication is optional as a whole. A connector that offers it must
/// implement both creation and recovery.
pub trait Publication: Send + Sync {
    /// Creates an ordinary open issue and returns it as the provider now reports
    /// it. Only called when the descriptor declares [`Capability::Publish`].
    ///
    /// An error must classify honestly through
    /// [`SourceError::ruled_out_creation`]: report a variant that proves nothing
    /// was created only when that is certain.
    fn publish(
        &self,
        config: &ConfigValues,
        request: &PublishRequest,
    ) -> Result<ExternalIssue, SourceError>;

    /// Reads one issue the person named (`text`: a number, a reference or a
    /// link), which must belong to `destination`. Used to attach an issue to an
    /// uncertain publication, so it must refuse an issue elsewhere. Only called
    /// when the descriptor declares [`Capability::Publish`].
    fn locate(
        &self,
        config: &ConfigValues,
        destination: &str,
        text: &str,
    ) -> Result<ExternalIssue, SourceError>;

    /// Looks for issues in the destination that the described publish may have
    /// created. See [`PublicationCandidates::complete`] for what an answer proves.
    fn find_published(
        &self,
        config: &ConfigValues,
        search: &PublicationSearch,
    ) -> Result<PublicationCandidates, SourceError>;
}
