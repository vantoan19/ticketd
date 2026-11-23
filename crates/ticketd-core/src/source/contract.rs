//! The versioned contract between the ticketd engine and a ticket source
//! connector.
//!
//! A connector translates one provider's operations into the neutral types
//! below. It never touches the workspace database: ticketd's engine decides
//! when to call it, and ticketd's workflows persist whatever it returns.
//!
//! Changes to existing operations and types require a version bump. Adding an
//! optional capability keeps the version.

use super::schema::{ChoiceOption, ConfigValues, FieldIssue};
use super::{SignInGuidance, SourcePresentation, SummaryPart};
pub use ticketd_source_sdk::{
    CONTRACT_VERSION, Capability, ConnectionCheck, ConnectionInfo, ConnectorDescriptor,
    Conversation, DerivedConfiguration, DestinationRules, DestinationValidation, DiscoveryPage,
    DiscoveryRequest, ErrorClass, ExternalComment, ExternalEvent, ExternalEventKind,
    ExternalIdentity, ExternalIssue, ExternalRef, ExternalState, PublicationCandidates,
    PublicationSearch, PublishRequest, SkippedPartition, StateCategory, Surface,
};

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
    #[error("the source extension crashed five times in three minutes. Retry to restart it")]
    ExtensionCrashLimit,
    #[error("source refresh canceled")]
    RefreshCanceled,
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
    ExtensionCrashLimit,
    RefreshCanceled,
    Rejected,
    Protocol,
    Unsupported,
    InvalidConfiguration,
    UnknownProvider,
    IncompatibleContract,
    NotConfigured,
}

impl FailureCode {
    pub(crate) const ALL: [Self; 14] = [
        Self::Unauthenticated,
        Self::Forbidden,
        Self::NotFound,
        Self::RateLimited,
        Self::Unavailable,
        Self::ExtensionCrashLimit,
        Self::RefreshCanceled,
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
            Self::ExtensionCrashLimit => "extension_crash_limit",
            Self::RefreshCanceled => "refresh_canceled",
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
            Self::RateLimited
            | Self::Unavailable
            | Self::ExtensionCrashLimit
            | Self::RefreshCanceled => ErrorClass::Transient,
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
            | Self::ExtensionCrashLimit
            | Self::Unauthenticated
            | Self::Forbidden
            | Self::NotFound
            | Self::Protocol
            | Self::UnknownProvider
            | Self::NotConfigured => true,
            Self::RefreshCanceled
            | Self::RateLimited
            | Self::Rejected
            | Self::Unsupported
            | Self::InvalidConfiguration
            | Self::IncompatibleContract => false,
        }
    }

    /// The failure says the source as a whole cannot be read right now, so asking
    /// again for other tickets would only repeat it, and a scheduler should back
    /// off. A single issue that is gone, denied or unreadable says nothing about
    /// the others.
    pub(crate) fn interrupts_source(self) -> bool {
        match self {
            Self::Unavailable
            | Self::ExtensionCrashLimit
            | Self::RateLimited
            | Self::Unauthenticated => true,
            Self::RefreshCanceled
            | Self::Forbidden
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
            Self::ExtensionCrashLimit => FailureCode::ExtensionCrashLimit,
            Self::RefreshCanceled => FailureCode::RefreshCanceled,
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
            | Self::ExtensionCrashLimit
            | Self::Unsupported(_)
            | Self::InvalidConfiguration(_)
            | Self::UnknownProvider(_)
            | Self::IncompatibleContract { .. } => true,
            Self::Unavailable(_) | Self::Protocol(_) | Self::RefreshCanceled => false,
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

    /// Normalize settings before a connector operation. The process adapter
    /// does this after resolving its credentials in the operation itself.
    #[doc(hidden)]
    fn configuration_for_request(&self, raw: &ConfigValues) -> Result<ConfigValues, SourceError> {
        self.descriptor()
            .schema
            .validate(raw)
            .map_err(SourceError::InvalidConfiguration)
    }

    /// Supplies connection-specific credentials where the connector supports them.
    fn for_connection(&self, _id: &str, _config: &ConfigValues) -> Option<Box<dyn Connector>> {
        None
    }

    /// Binds the vault references belonging to a connection without reading them.
    #[doc(hidden)]
    fn for_connection_with_secret_refs(
        &self,
        id: &str,
        config: &ConfigValues,
        _references: std::collections::BTreeMap<String, uuid::Uuid>,
    ) -> Option<Box<dyn Connector>> {
        self.for_connection(id, config)
    }

    /// Resolves credentials once for a workflow that can make several calls
    /// with the same settings. Single requests and drafts may resolve on demand.
    #[doc(hidden)]
    fn with_workflow_credentials(
        &self,
        _config: &ConfigValues,
    ) -> Result<Option<Box<dyn Connector>>, SourceError> {
        Ok(None)
    }

    /// Attaches controls to a connection-scoped connector that supports them.
    fn for_refresh(&self, _control: &super::RefreshControl) -> Option<Box<dyn Connector>> {
        None
    }

    /// Site known locally before credentials are used, when the connector can tell.
    fn effective_site(&self) -> Option<String> {
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

    #[doc(hidden)]
    fn validate_draft(&self, raw: &ConfigValues) -> Result<ConfigValues, SourceError> {
        let config = self
            .descriptor()
            .schema
            .validate(raw)
            .map_err(SourceError::InvalidConfiguration)?;
        let issues = self.validate(&config)?;
        if issues.is_empty() {
            Ok(config)
        } else {
            Err(SourceError::InvalidConfiguration(issues))
        }
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
