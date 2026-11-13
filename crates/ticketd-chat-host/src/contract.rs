//! The internal adapter interface shared by the Codex adapter, the Claude bridge
//! transport and the fake adapter. It is not the React interface.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;

/// Capacity of a runtime's event channel. A full channel backpressures the adapter's
/// protocol reader, so the supervisor must keep receiving while commands are pending.
pub const EVENT_BUFFER: usize = 256;

/// Upper bound for one [`ProviderDetail`] payload.
pub const MAX_PROVIDER_DETAIL_BYTES: usize = 16 * 1024;

macro_rules! string_id {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        pub struct $name(pub String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }
        }
    };
}

string_id!(
    /// ticketd's identity for one submission attempt. It supplies correlation, not a
    /// provider-side idempotency guarantee.
    SubmissionId
);
string_id!(
    /// The harness's own session identity, distinct from Chat identity.
    NativeSessionId
);
string_id!(
    /// A turn identity as the adapter reports it for the current runtime.
    NativeTurnId
);
string_id!(
    /// A message or tool item inside a turn.
    NativeItemId
);
string_id!(
    /// A live approval or question awaiting an answer in the current runtime.
    NativeRequestId
);

/// Identifies one provider process owned by a Chat. The supervisor assigns a new
/// generation on every open; commands and events from another generation are stale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RuntimeGeneration(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Harness {
    ClaudeCode,
    Codex,
}

// ---------------------------------------------------------------------------
// Inspection and capabilities
// ---------------------------------------------------------------------------

/// What an installation probe observed. A failed probe is not an incompatibility verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inspection {
    Installed {
        executable: PathBuf,
        version: Option<String>,
        login: LoginState,
        capabilities: Capabilities,
    },
    Incompatible {
        executable: PathBuf,
        version: Option<String>,
        /// The capability or version the installation lacks.
        requirement: String,
    },
    NotInstalled,
    ProbeFailed {
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginState {
    SignedIn,
    SignedOut,
    /// Signed in through an API key or cloud provider rather than the harness
    /// subscription. The harness chose this from the user's own configuration; ticketd
    /// never selects it.
    NonSubscription,
    Unknown,
}

/// Effective support for one operation, with the behavior it has and why we believe it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Capability<B> {
    Supported { behavior: B, evidence: String },
    Unsupported { reason: String },
    Unknown { reason: String },
}

impl<B> Capability<B> {
    pub fn behavior(&self) -> Option<&B> {
        match self {
            Self::Supported { behavior, .. } => Some(behavior),
            Self::Unsupported { .. } | Self::Unknown { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SteeringBehavior {
    /// Applying steering input may interrupt tools that are already running.
    pub interrupts_tools: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capabilities {
    /// Adding input to the active turn. Without it the supervisor queues.
    pub steering: Capability<SteeringBehavior>,
    /// Reopening a native session in a replacement process.
    pub native_resume: Capability<()>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenRequest {
    pub generation: RuntimeGeneration,
    /// The Chat the runtime serves, given to the harness process as
    /// `ticketd_core::CHAT_ID_VARIABLE` so the ticketd CLI it runs credits that Chat.
    pub chat_id: String,
    pub working_directory: PathBuf,
    pub session: SessionStart,
}

/// Resuming restores native history only. It never resubmits input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionStart {
    New,
    Resume(NativeSessionId),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Submission {
    pub submission: SubmissionId,
    pub generation: RuntimeGeneration,
    pub kind: SubmissionKind,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmissionKind {
    /// Expects no active turn.
    StartTurn,
    /// Expects `expected_turn` to still be the active turn.
    Steer { expected_turn: NativeTurnId },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InteractionResponse {
    pub generation: RuntimeGeneration,
    pub request: NativeRequestId,
    pub answer: InteractionAnswer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InteractionAnswer {
    Approval(ApprovalDecision),
    Answers(Vec<QuestionAnswer>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Allow,
    AllowForSession,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionAnswer {
    pub question_id: String,
    pub values: Vec<String>,
}

/// One harness setting a person can choose for the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingKey {
    Model,
    Effort,
    Permission,
}

/// Asks the harness to use `value` (an option id it reported) for `setting`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingChange {
    pub generation: RuntimeGeneration,
    pub setting: SettingKey,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterruptRequest {
    pub generation: RuntimeGeneration,
    pub expected_turn: NativeTurnId,
}

// ---------------------------------------------------------------------------
// Command outcomes
// ---------------------------------------------------------------------------

/// Why a command was refused before anything was written to the harness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The command names a generation other than this runtime's.
    StaleGeneration { current: RuntimeGeneration },
    /// The expected turn is not the active turn.
    TurnMismatch { active: Option<NativeTurnId> },
    /// No live request has this identity: never issued, already answered or withdrawn.
    UnknownRequest,
    /// The effective capabilities do not include this operation.
    Unsupported,
    /// The runtime was closed, replaced or lost before the write.
    RuntimeClosed,
}

/// Submission evidence available when `submit` returns. It never describes task
/// completion; the terminal outcome is [`EventKind::TurnEnded`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchOutcome {
    /// Known not sent. Safe to queue or dispatch again.
    NotSent(Refusal),
    /// Handed to the harness; acknowledgment is pending and may arrive later as
    /// [`EventKind::SubmissionEvidence`]. Possibly delivered: never resend.
    Written,
    /// The harness acknowledged the input for this turn.
    Acknowledged { turn: NativeTurnId },
    /// The harness explicitly refused the input. Safe to queue.
    Rejected { reason: String },
    /// Written, then the runtime was lost before any reply. Never resend.
    UnknownAfterLoss,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RespondOutcome {
    /// The answer was written to the live request. Resolution is observed separately.
    Sent,
    NotSent(Refusal),
    UnknownAfterLoss,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InterruptOutcome {
    /// The harness accepted the request. The turn ends only with
    /// [`EventKind::TurnEnded`]; tools may still be running.
    Acknowledged,
    NotSent(Refusal),
    /// Written without an acknowledgment: timeout or loss of contact.
    Unconfirmed,
}

/// What the harness did with a [`SettingChange`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingOutcome {
    /// The harness accepted it; it takes effect as [`Setting::applies_from`] says.
    Applied,
    /// The harness, or ticketd before writing, refused it.
    Refused { reason: String },
    /// Written without an answer in time: the harness may still use the old value.
    Unconfirmed,
    /// This harness cannot change this setting from ticketd.
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseOutcome {
    /// Every owned process was observed to exit.
    Confirmed { exit_code: Option<i32> },
    /// Cleanup ran out of time or could not observe the whole process tree.
    Unconfirmed { reason: String },
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

pub type EventStream = mpsc::Receiver<RuntimeEvent>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeEvent {
    pub generation: RuntimeGeneration,
    pub kind: EventKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventKind {
    SessionIdentified {
        native_session: NativeSessionId,
    },
    /// Evidence about an earlier submission, including one whose `submit` already
    /// returned `Written` or timed out, or one made in an earlier generation.
    SubmissionEvidence {
        submission: SubmissionId,
        evidence: DeliveryEvidence,
    },
    TurnStarted {
        turn: NativeTurnId,
    },
    /// Streamed text. May be coalesced or lost; `MessageCompleted` is authoritative.
    TextDelta {
        turn: NativeTurnId,
        item: NativeItemId,
        text: String,
    },
    /// The full final text of one assistant message, replacing its deltas.
    MessageCompleted {
        turn: NativeTurnId,
        item: NativeItemId,
        text: String,
    },
    /// The latest state of one tool item. `output` is whatever the harness reported so
    /// far; the supervisor bounds what it stores.
    ToolUpdated {
        turn: NativeTurnId,
        item: NativeItemId,
        title: String,
        status: ToolStatus,
        output: Option<String>,
        detail: Option<ProviderDetail>,
    },
    InteractionRequested(InteractionRequest),
    /// The live request is gone; later answers to it are refused.
    InteractionResolved {
        request: NativeRequestId,
        resolution: InteractionResolution,
    },
    /// Terminal outcome of a turn, with the submissions the harness correlated to it.
    TurnEnded {
        turn: NativeTurnId,
        outcome: TurnOutcome,
        submissions: Vec<SubmissionId>,
    },
    /// The provider process or its transport is gone. Always the last event.
    RuntimeLost {
        exit_code: Option<i32>,
        /// Bounded tail of stderr.
        diagnostics: String,
    },
    /// A non-terminal observation about the session or a turn. It never starts, ends
    /// or fails a turn; a turn named here stays active.
    Notice {
        turn: Option<NativeTurnId>,
        kind: NoticeKind,
        message: String,
        detail: Option<ProviderDetail>,
    },
    /// The latest state of one reasoning item, replacing its earlier state. Times are
    /// milliseconds since the Unix epoch, as the harness reported them or as its
    /// events were observed; `text` is only what the harness showed, and is `None`
    /// when it showed nothing or redacted it.
    ReasoningUpdated {
        turn: NativeTurnId,
        item: NativeItemId,
        running: bool,
        started_at: Option<i64>,
        ended_at: Option<i64>,
        text: Option<String>,
        /// A heading the harness itself marked, never one made from the text's words.
        heading: Option<String>,
    },
    /// The turn's whole plan as the harness reported it, replacing its earlier one.
    PlanUpdated {
        turn: NativeTurnId,
        plan: Plan,
    },
    /// Every file the turn changed so far, replacing the earlier list.
    FilesChanged {
        turn: NativeTurnId,
        files: Vec<FileChange>,
    },
    /// How full the session's context window is, as the harness reported it.
    ContextUsage(ContextUsage),
    /// The harness compacted the session's context.
    Compacted,
    /// The session's choosable settings and their current values, replacing the earlier.
    SettingsState(HarnessSettings),
    /// Provider traffic the adapter does not model. Never completion or approval.
    Unknown {
        summary: String,
        detail: ProviderDetail,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub steps: Vec<PlanStep>,
    /// The harness's own note about the plan.
    pub explanation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanStep {
    pub text: String,
    pub status: PlanStepStatus,
    /// The words the harness shows while this step runs ("Running tests").
    pub active_label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    /// As the harness named it: absolute, or relative to the working directory.
    pub path: String,
    pub kind: FileChangeKind,
    /// Line counts only when the harness reported the change's lines.
    pub added_lines: Option<u32>,
    pub removed_lines: Option<u32>,
    /// The harness reported the change as made, not only as attempted.
    pub confirmed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed { from: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextUsage {
    /// Tokens in use.
    pub used: u64,
    /// The window's size in tokens.
    pub window: u64,
    /// What the harness says fills the window; empty when it did not say.
    pub categories: Vec<ContextCategory>,
    /// Where the harness compacts on its own, in tokens.
    pub compacts_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextCategory {
    pub name: String,
    pub tokens: u64,
}

/// The settings a harness reports for the session. `None` is a setting it did not
/// report, which is never offered as a choice.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HarnessSettings {
    pub model: Option<Setting>,
    pub effort: Option<Setting>,
    pub permission: Option<Setting>,
}

impl HarnessSettings {
    pub fn get(&self, key: SettingKey) -> Option<&Setting> {
        match key {
            SettingKey::Model => self.model.as_ref(),
            SettingKey::Effort => self.effort.as_ref(),
            SettingKey::Permission => self.permission.as_ref(),
        }
    }

    pub fn get_mut(&mut self, key: SettingKey) -> Option<&mut Setting> {
        match key {
            SettingKey::Model => self.model.as_mut(),
            SettingKey::Effort => self.effort.as_mut(),
            SettingKey::Permission => self.permission.as_mut(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Setting {
    /// The option id in effect, when the harness said.
    pub current: Option<String>,
    /// In the harness's order; effort levels from lowest to highest.
    pub options: Vec<SettingOption>,
    /// Why ticketd cannot change it, when it cannot.
    pub unchangeable: Option<String>,
    pub applies_from: AppliesFrom,
    /// The model the harness says answered, when it is not the one chosen.
    pub answered_by: Option<String>,
}

impl Setting {
    /// Why `value` cannot be chosen, or `None` when it can. Full access is never a
    /// choice through ticketd, whatever the harness allows.
    pub fn refusal(&self, value: &str) -> Option<String> {
        if let Some(reason) = &self.unchangeable {
            return Some(reason.clone());
        }
        match self.options.iter().find(|option| option.id == value) {
            None => Some(format!("{value} is not one of the choices it offers")),
            Some(option) if option.permission == Some(PermissionKind::FullAccess) => {
                Some("ticketd never turns on full access".to_owned())
            }
            Some(option) if !option.allowed => {
                Some(format!("{} is not allowed by its settings", option.label))
            }
            Some(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub is_default: bool,
    /// For a permission option, what it allows, when known.
    pub permission: Option<PermissionKind>,
    /// The harness's own policy allows choosing it.
    pub allowed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionKind {
    ReadOnly,
    Ask,
    AcceptEdits,
    /// Bypasses approvals. Never offered as a choice through ticketd.
    FullAccess,
}

/// When a change the harness accepted takes effect in the harness itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppliesFrom {
    NextTurn,
    /// From the harness's next model request, which may be inside a running turn.
    NextRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeKind {
    /// The harness is retrying on its own. Do not submit an application-level retry.
    Retrying,
    /// A harness warning, such as a rerouted model or a configuration problem.
    Warning,
    /// The settings the harness reports as in effect for this session, in `detail`.
    EffectiveSettings,
    /// An optional tool, MCP server or model the session asked for is unavailable.
    /// `message` names it and is kept as a notice in the conversation. It is never the
    /// Chat's problem: the rest of the session goes on and ticketd substitutes nothing.
    CapabilityUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryEvidence {
    /// An explicit provider acknowledgment of the input.
    Acknowledged { turn: NativeTurnId },
    /// Provider output correlated to the input, without an explicit acknowledgment.
    Processing { turn: NativeTurnId },
    /// The provider refused the input after `submit` had returned.
    Rejected { reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    Running,
    Succeeded,
    Failed,
    /// The person declined it when the harness asked, so it never ran.
    Declined,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InteractionRequest {
    pub request: NativeRequestId,
    pub turn: Option<NativeTurnId>,
    pub kind: InteractionKind,
    pub detail: Option<ProviderDetail>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InteractionKind {
    Approval {
        /// What would run or change: the command, or a summary of the action. When the
        /// harness gave only its reason, that reason.
        description: String,
        /// Why the harness asks, kept apart from `description`.
        reason: Option<String>,
        /// The decisions this harness accepts for this request.
        decisions: Vec<ApprovalDecision>,
    },
    Question {
        questions: Vec<Question>,
    },
}

impl InteractionKind {
    /// An approval of `subject` asked for `reason`. With only a reason, the reason is the
    /// description, so it is never dropped; with neither, `fallback` is.
    pub fn approval(
        subject: Option<&str>,
        reason: Option<&str>,
        fallback: &str,
        decisions: Vec<ApprovalDecision>,
    ) -> Self {
        let (description, reason) = match (subject, reason) {
            (Some(subject), reason) => (subject, reason),
            (None, Some(reason)) => (reason, None),
            (None, None) => (fallback, None),
        };
        Self::Approval {
            description: description.to_owned(),
            reason: reason.map(str::to_owned),
            decisions,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub id: String,
    pub prompt: String,
    /// Empty when the answer is free text.
    pub options: Vec<String>,
    pub multi_select: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InteractionResolution {
    Answered,
    /// The harness cancelled the request before an answer arrived.
    Withdrawn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnOutcome {
    Completed,
    Interrupted,
    Failed(Problem),
}

/// A failure the UI explains alongside the activity state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub kind: ProblemKind,
    pub message: String,
    pub detail: Option<ProviderDetail>,
    /// When the provider said the limit behind this failure resets, in seconds since
    /// the Unix epoch, read with [`reset_time`]. `None` when it did not say.
    pub resets_at: Option<i64>,
}

/// A provider's reset time as seconds since the Unix epoch, or `None` when the value
/// is not a time: not a whole number, negative, or past year 9999. A value too large
/// for seconds is read as milliseconds.
pub fn reset_time(value: &serde_json::Value) -> Option<i64> {
    let at = value.as_i64()?;
    let seconds = if at > ticketd_core::CHAT_RESET_TIME_MAX {
        at / 1000
    } else {
        at
    };
    (0..=ticketd_core::CHAT_RESET_TIME_MAX)
        .contains(&seconds)
        .then_some(seconds)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProblemKind {
    NotInstalled,
    IncompatibleVersion,
    LoginRequired,
    QuotaExhausted,
    /// Native history for a resume is missing or unreadable.
    NativeHistoryUnavailable,
    SessionInUse,
    /// A required permission or sandbox capability is unavailable.
    PermissionUnavailable,
    Other,
}

/// Provider-specific data kept for display or diagnosis, bounded at construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderDetail {
    kind: String,
    payload: String,
    original_bytes: usize,
}

impl ProviderDetail {
    /// `kind` is the provider's name for the payload, such as a method or message type.
    pub fn new(kind: impl Into<String>, payload: &str) -> Self {
        let mut end = payload.len().min(MAX_PROVIDER_DETAIL_BYTES);
        while !payload.is_char_boundary(end) {
            end -= 1;
        }
        Self {
            kind: kind.into(),
            payload: payload[..end].to_owned(),
            original_bytes: payload.len(),
        }
    }

    pub fn kind(&self) -> &str {
        &self.kind
    }

    pub fn payload(&self) -> &str {
        &self.payload
    }

    pub fn original_bytes(&self) -> usize {
        self.original_bytes
    }

    pub fn truncated(&self) -> bool {
        self.payload.len() < self.original_bytes
    }
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/// One harness integration. Opening starts a provider process for a single Chat.
#[async_trait]
pub trait HarnessAdapter: Send + Sync {
    fn harness(&self) -> Harness;

    /// Probes the installation, login and capabilities without starting a session.
    async fn inspect(&self) -> Inspection;

    /// Starts a provider process for `request.generation` with a new or resumed
    /// native session.
    async fn open(&self, request: OpenRequest) -> Result<OpenedRuntime, Problem>;
}

#[derive(Debug)]
pub struct OpenedRuntime {
    pub runtime: Arc<dyn HarnessRuntime>,
    pub events: EventStream,
    /// Capabilities in effect for this session, which may differ from inspection.
    pub capabilities: Capabilities,
}

/// A live provider process bound to one runtime generation. Methods may be called
/// concurrently and must not block the adapter's protocol reader.
#[async_trait]
pub trait HarnessRuntime: Send + Sync + std::fmt::Debug {
    /// Hands input to the harness after rechecking generation and expected turn
    /// immediately before the write.
    async fn submit(&self, submission: Submission) -> DispatchOutcome;

    /// Answers a live approval or question. Each request accepts one answer.
    async fn respond(&self, response: InteractionResponse) -> RespondOutcome;

    /// Requests interruption of the expected active turn.
    async fn interrupt(&self, request: InterruptRequest) -> InterruptOutcome;

    /// Changes a session setting. The supervisor calls it only between turns, so each
    /// turn runs on one set of settings.
    async fn change_setting(&self, change: SettingChange) -> SettingOutcome {
        let _ = change;
        SettingOutcome::Unsupported
    }

    /// Stops the owned process tree with bounded cleanup and ends the event stream.
    async fn close(&self) -> CloseOutcome;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_detail_truncates_on_a_character_boundary_and_reports_it() {
        let payload = "é".repeat(MAX_PROVIDER_DETAIL_BYTES);

        let detail = ProviderDetail::new("item/unknown", &payload);

        assert_eq!(detail.payload().len(), MAX_PROVIDER_DETAIL_BYTES);
        assert_eq!(detail.original_bytes(), 2 * MAX_PROVIDER_DETAIL_BYTES);
        assert!(detail.truncated());
        assert!(!ProviderDetail::new("item/unknown", "short").truncated());
    }
}
