//! What keeps a Chat or a harness from going on, as every Chat surface names it, and
//! the decisions that follow from it: whether a message can be sent, whether there is
//! anything to type into, whether a Chat can be started. The words live here once so
//! the list row, the notice and New Chat never disagree.
use serde::Serialize;

use crate::ProblemKind;

/// Why a Chat cannot continue as it is (spec 21.6), in the Chat screens' terms.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatProblemKind {
    NotInstalled,
    Incompatible,
    /// ticketd's own part for this harness is missing from the installation.
    Unavailable,
    ProbeFailed,
    NotSignedIn,
    /// Signed in with an API key or cloud provider: usable, billed there.
    NotSubscription,
    /// ticketd cannot tell whether the harness is signed in.
    SignInUnknown,
    UsageLimit,
    SandboxUnavailable,
    UncertainDelivery,
    FolderMissing,
    HistoryLost,
    SessionInUse,
    StopUnconfirmed,
    #[default]
    Failed,
}

impl From<ProblemKind> for ChatProblemKind {
    fn from(kind: ProblemKind) -> Self {
        match kind {
            ProblemKind::NotInstalled => Self::NotInstalled,
            ProblemKind::IncompatibleVersion => Self::Incompatible,
            ProblemKind::LoginRequired => Self::NotSignedIn,
            ProblemKind::QuotaExhausted => Self::UsageLimit,
            ProblemKind::NativeHistoryUnavailable => Self::HistoryLost,
            ProblemKind::SessionInUse => Self::SessionInUse,
            ProblemKind::PermissionUnavailable => Self::SandboxUnavailable,
            // Only a run's Chat ends at its turn limit or on a denied tool, and the
            // run says why; in the Chat itself the message is enough.
            ProblemKind::TurnLimitReached | ProblemKind::ToolDenied | ProblemKind::Other => {
                Self::Failed
            }
        }
    }
}

impl ChatProblemKind {
    /// Observed now, it keeps the Chat from taking a new message until it is resolved.
    /// Why the last turn stopped never does: that is told, not enforced.
    pub fn blocks_send(self) -> bool {
        match self {
            Self::NotInstalled
            | Self::Incompatible
            | Self::Unavailable
            | Self::NotSignedIn
            | Self::UsageLimit
            | Self::SandboxUnavailable
            | Self::UncertainDelivery
            | Self::SessionInUse => true,
            Self::ProbeFailed
            | Self::NotSubscription
            | Self::SignInUnknown
            | Self::FolderMissing
            | Self::HistoryLost
            | Self::StopUnconfirmed
            | Self::Failed => false,
        }
    }

    /// Observed now, there is nothing to type into: the folder or the session is gone.
    pub fn removes_composer(self) -> bool {
        match self {
            Self::FolderMissing | Self::HistoryLost => true,
            Self::NotInstalled
            | Self::Incompatible
            | Self::Unavailable
            | Self::ProbeFailed
            | Self::NotSignedIn
            | Self::NotSubscription
            | Self::SignInUnknown
            | Self::UsageLimit
            | Self::SandboxUnavailable
            | Self::UncertainDelivery
            | Self::SessionInUse
            | Self::StopUnconfirmed
            | Self::Failed => false,
        }
    }

    /// The words a list row says for a condition that holds now and is not a failure:
    /// an install or sign-in step, a missing folder. `None` for what is said otherwise.
    pub fn condition_word(self) -> Option<&'static str> {
        Some(match self {
            Self::NotInstalled
            | Self::Incompatible
            | Self::Unavailable
            | Self::ProbeFailed
            | Self::NotSignedIn => "Not sent",
            Self::NotSubscription => NOT_SUBSCRIPTION,
            Self::SignInUnknown => SIGN_IN_UNKNOWN,
            Self::UsageLimit => "Usage limit reached",
            Self::SandboxUnavailable => "Sandbox unavailable",
            Self::FolderMissing => "Folder missing",
            Self::HistoryLost => "Session unavailable",
            Self::SessionInUse => "Session in use elsewhere",
            Self::UncertainDelivery | Self::StopUnconfirmed | Self::Failed => return None,
        })
    }

    /// The notice's title, which is also the list row's detail for a failed turn.
    /// `past`: it is why the last turn stopped, not a condition observed now.
    pub fn title(self, harness: &str, past: bool) -> String {
        match self {
            Self::NotSignedIn if past => format!("{harness} wasn't signed in"),
            Self::NotSignedIn => format!("{harness} isn't signed in"),
            Self::NotSubscription => format!("{harness} isn't using a subscription"),
            Self::SignInUnknown => format!("ticketd can't check {harness}'s sign-in"),
            Self::NotInstalled => format!("{harness} isn't installed"),
            Self::Incompatible => format!("This {harness} version can't be used"),
            Self::Unavailable => format!("{harness} isn't available"),
            Self::ProbeFailed => format!("ticketd couldn't check {harness}"),
            Self::UsageLimit => format!("{harness} reached your usage limit"),
            Self::SandboxUnavailable => format!("{harness} can't run commands here"),
            Self::UncertainDelivery => format!("Did {harness} get your message?"),
            Self::FolderMissing => "This Chat's folder is missing".to_owned(),
            Self::HistoryLost => format!("{harness} no longer has this conversation"),
            Self::SessionInUse if past => format!("This {harness} session was open somewhere else"),
            Self::SessionInUse => format!("This {harness} session is open somewhere else"),
            Self::StopUnconfirmed => "Stop not confirmed".to_owned(),
            Self::Failed => format!("{harness} stopped with an error"),
        }
    }
}

const NOT_SUBSCRIPTION: &str = "Not on a subscription";
const SIGN_IN_UNKNOWN: &str = "Sign-in not checked";

/// What the installation and sign-in probe found for a harness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessState {
    Ready,
    NotInstalled,
    Incompatible,
    /// ticketd's own part for this harness is missing; reinstalling restores it.
    Unavailable,
    NotSignedIn,
    /// Usable, but not on the harness subscription; the message says how it bills.
    NotSubscription,
    /// Usable as far as ticketd can tell; sign-in could not be checked.
    SignInUnknown,
    /// The probe itself failed.
    Unknown,
}

/// A harness that is not ready, as one word beside its name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HarnessWord {
    pub word: &'static str,
    /// It needs the person (a sign-in, an update, a check); a word without one is a fact.
    pub dot: bool,
}

impl HarnessState {
    /// Chats can be started on it. A sign-in that is not a subscription, or that
    /// ticketd could not check, does not block: it is shown.
    pub fn usable(self) -> bool {
        match self {
            Self::Ready | Self::NotSubscription | Self::SignInUnknown => true,
            Self::NotInstalled
            | Self::Incompatible
            | Self::Unavailable
            | Self::NotSignedIn
            | Self::Unknown => false,
        }
    }

    /// The problem New Chat tells about a harness that is not ready.
    pub fn problem_kind(self) -> Option<ChatProblemKind> {
        Some(match self {
            Self::Ready => return None,
            Self::NotInstalled => ChatProblemKind::NotInstalled,
            Self::Incompatible => ChatProblemKind::Incompatible,
            Self::Unavailable => ChatProblemKind::Unavailable,
            Self::NotSignedIn => ChatProblemKind::NotSignedIn,
            Self::NotSubscription => ChatProblemKind::NotSubscription,
            Self::SignInUnknown => ChatProblemKind::SignInUnknown,
            Self::Unknown => ChatProblemKind::ProbeFailed,
        })
    }

    /// The word New Chat and the header show beside the harness; none when ready.
    pub fn word(self) -> Option<HarnessWord> {
        let (word, dot) = match self {
            Self::Ready => return None,
            Self::NotSignedIn => ("Not signed in", true),
            Self::Incompatible | Self::Unavailable => ("Can't be used", true),
            Self::Unknown => ("Couldn't check", true),
            Self::NotSubscription => (NOT_SUBSCRIPTION, true),
            Self::NotInstalled => ("Not installed", false),
            Self::SignInUnknown => (SIGN_IN_UNKNOWN, false),
        };
        Some(HarnessWord { word, dot })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_condition_that_stops_delivery_blocks_send() {
        assert!(ChatProblemKind::NotSignedIn.blocks_send());
        assert!(ChatProblemKind::UncertainDelivery.blocks_send());
        assert!(!ChatProblemKind::Failed.blocks_send());
        assert!(!ChatProblemKind::NotSubscription.blocks_send());
        assert!(ChatProblemKind::FolderMissing.removes_composer());
        assert!(!ChatProblemKind::UsageLimit.removes_composer());
    }

    #[test]
    fn a_harness_signed_in_another_way_is_usable_and_says_so_in_the_rows_words() {
        assert!(HarnessState::NotSubscription.usable());
        assert!(HarnessState::SignInUnknown.usable());
        assert!(!HarnessState::NotSignedIn.usable());
        assert_eq!(
            HarnessState::NotSubscription.word().map(|word| word.word),
            ChatProblemKind::NotSubscription.condition_word()
        );
        assert_eq!(HarnessState::Ready.word(), None);
    }
}
