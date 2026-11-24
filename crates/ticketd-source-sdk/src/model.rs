//! Source-independent values exchanged on the connector contract.
use std::collections::BTreeMap;

use crate::{ConfigSchema, ConfigValues, ValueFormat};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{IgnoredAny, value},
};

/// The contract version this build of ticketd speaks. The engine refuses to
/// register a connector that declares a different one.
pub const CONTRACT_VERSION: u32 = 2;

/// What a connector can do beyond describing and validating its configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ConnectorDescriptor {
    /// Stable provider id, such as `github`. It is part of every external identity.
    pub provider: String,
    pub name: String,
    pub contract_version: u32,
    /// Known names describe the supported operations. A host ignores names for
    /// future optional capabilities that it does not yet recognize.
    #[serde(deserialize_with = "known_capabilities")]
    #[schemars(with = "Vec<String>")]
    pub capabilities: Vec<Capability>,
    pub schema: ConfigSchema,
}

// A future optional capability cannot invalidate the operations this host knows.
fn known_capabilities<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<Capability>, D::Error> {
    Ok(Vec::<String>::deserialize(deserializer)?
        .into_iter()
        .filter_map(|name| {
            Capability::deserialize(value::StringDeserializer::<value::Error>::new(name)).ok()
        })
        .collect())
}

/// The account the connector is acting as. Never contains a credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ConnectionInfo {
    /// The label shown for the signed-in account.
    pub account: String,
    /// Stable account identity on this site when the display label is not an identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Canonical site identity. Empty when the provider has only one site.
    #[serde(default)]
    pub site: String,
    /// RFC 3339 time reported by the tracker during this authenticated check, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracker_time: Option<String>,
    /// Whether this source needs tracker time evidence before ticketd can safely publish.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub publication_requires_tracker_time: bool,
}

impl ConnectionInfo {
    /// Use the provider's stable ID when it supplies one.
    pub fn account_key(&self) -> &str {
        self.account_id.as_deref().unwrap_or(&self.account)
    }
}

/// The verified connection and answers derived from its settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ConnectionCheck {
    pub connection: ConnectionInfo,
    pub derived: DerivedConfiguration,
}

/// Configuration answers that ticketd can keep for use without a connector call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
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
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct DestinationRules {
    /// Accepted destinations in their canonical spelling. Empty when the
    /// connector cannot enumerate them.
    pub destinations: Vec<String>,
    /// Optional display labels keyed by canonical destination.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub destination_labels: BTreeMap<String, String>,
    /// Whether destination matching ignores ASCII case.
    pub case_insensitive: bool,
    pub validation: Option<DestinationValidation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct DestinationValidation {
    pub format: ValueFormat,
    pub message: String,
}

/// An issue's immutable record key on its provider. It must be stable across
/// every account and site. Never match issues by display text.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ExternalIdentity {
    pub provider: String,
    pub id: String,
}

/// Enough to ask the connector for an issue again. `locator` is opaque to
/// ticketd and defined by the connector (for GitHub, `owner/name#number`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ExternalRef {
    pub identity: ExternalIdentity,
    pub locator: String,
    /// The part of discovery this issue belongs to, such as a repository.
    /// An empty string denotes a source that is read as one whole.
    pub partition: String,
}

/// How a source state affects ticketd's workflow. Connectors derive the
/// category from typed provider data and use Unknown for an unrecognized value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StateCategory {
    Open,
    Completed,
    NotPlanned,
    Duplicate,
    Unknown,
}

impl StateCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Completed => "completed",
            Self::NotPlanned => "not_planned",
            Self::Duplicate => "duplicate",
            Self::Unknown => "unknown",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "open" => Self::Open,
            "completed" => Self::Completed,
            "not_planned" => Self::NotPlanned,
            "duplicate" => Self::Duplicate,
            _ => Self::Unknown,
        }
    }

    /// A closed issue with a missing or unknown closure reason stays unknown.
    pub fn from_closure(reason: Option<&str>) -> Self {
        match reason {
            Some("completed") => Self::Completed,
            Some("not_planned") => Self::NotPlanned,
            Some("duplicate") => Self::Duplicate,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ExternalState {
    pub category: StateCategory,
    /// The tracker's own name for the state, used only for display. Older
    /// observations may have no name.
    pub name: Option<String>,
}

impl ExternalState {
    pub fn named(category: StateCategory, name: impl Into<String>) -> Self {
        Self {
            category,
            name: Some(name.into()),
        }
    }
}

/// An issue as the provider reports it, in provider-neutral form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ExternalIssue {
    pub reference: ExternalRef,
    /// Human-readable name such as `owner/name#12`. Display only.
    pub display: String,
    pub url: String,
    /// The issue's repository as a normalized `host/owner/name`, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub title: String,
    pub body: String,
    pub state: ExternalState,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    /// When the issue was opened at the source, as an RFC 3339 timestamp.
    pub created_at: String,
    /// When the issue was last updated at the source, as an RFC 3339 timestamp.
    pub updated_at: String,
    /// The source identity that opened the issue, when known.
    #[serde(default)]
    pub author: Option<String>,
    /// For an issue closed as a duplicate: the canonical issue, when the provider
    /// names an accessible one. Absent means the target is unknown.
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "event", content = "category", rename_all = "snake_case")]
pub enum ExternalEventKind {
    Closed(StateCategory),
    Reopened,
    /// A workflow change that does not itself establish a closure or reopening.
    StateChanged(StateCategory),
    /// This issue was marked as a duplicate of another issue.
    MarkedDuplicate,
    UnmarkedDuplicate,
    /// Another issue was marked as a duplicate of this issue.
    DuplicateAdded,
    DuplicateRemoved,
    Assigned,
    Unassigned,
    /// An event kind this version of the SDK does not recognize.
    #[doc(hidden)]
    #[serde(other, deserialize_with = "ignore_event_content", skip_serializing)]
    #[schemars(skip)]
    Unsupported,
}

fn ignore_event_content<'de, D: Deserializer<'de>>(deserializer: D) -> Result<(), D::Error> {
    IgnoredAny::deserialize(deserializer).map(|_| ())
}

/// A timeline event such as a closure, reopening or assignment change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ExternalEvent {
    pub id: String,
    pub kind: ExternalEventKind,
    /// Who acted, when the source says.
    pub actor: Option<String>,
    /// The assignee, destination workflow state, or related issue when known.
    pub subject: Option<String>,
    pub created_at: String,
}

/// An issue's whole conversation. Order is not significant; the engine sorts
/// it chronologically.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Conversation {
    pub comments: Vec<ExternalComment>,
    #[serde(deserialize_with = "deserialize_events")]
    pub events: Vec<ExternalEvent>,
}

fn deserialize_events<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<ExternalEvent>, D::Error> {
    let mut events = Vec::<ExternalEvent>::deserialize(deserializer)?;
    events.retain(|event| event.kind != ExternalEventKind::Unsupported);
    Ok(events)
}

/// One request for a page of discovery results.
#[derive(Debug, Clone, Copy)]
pub struct DiscoveryRequest<'a> {
    pub config: &'a ConfigValues,
    /// Opaque continuation returned by the previous page; `None` starts over.
    pub cursor: Option<&'a str>,
    pub page_size: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PublishRequest {
    pub title: String,
    pub body: String,
    /// Connector-defined destination, such as `owner/name`.
    pub destination: String,
}

/// A search for issues an earlier, uncertain publish may have created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PublicationSearch {
    /// Exactly what the earlier attempt sent.
    pub request: PublishRequest,
    /// The lower bound based on the device clock, in RFC 3339.
    pub since: String,
    /// The lower bound based on the tracker clock immediately before the mutation, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracker_since: Option<String>,
    /// The account ID, or its label when the source has no separate ID. Whatever it created in
    /// the window is a candidate, whatever its text now says: a teammate or an
    /// automation may have edited the title and description since.
    #[serde(default)]
    pub account: Option<String>,
}

/// What a search found. `matches` holds every issue the connector saw whose
/// title or non-empty description equals what the attempt sent. `recent` holds
/// other issues the connected account created in the window, including issues
/// that may have been edited since publication. `complete` describes search
/// coverage. It is true only when the connector covered every possible result
/// of the attempt. Either populated list or incomplete coverage keeps a
/// "not created" resolution unavailable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
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
