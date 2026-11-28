//! How a Turn ended, as one typed fact.
//!
//! The supervisor records a [`TurnEnding`] with every turn it ends, and everything that
//! needs to know how a turn ended (the Chat's status, the transcript's end marker, the
//! outcome of an Automation run's agent) asks it here instead of reading the wording
//! kept in the turn's `detail`. The wording stays on the turn for display; only the
//! legacy decoder below reads it back, for turns recorded before the ending existed.

use ticketd_core::{CHAT_NOTICE_LIMIT, ChatObservation, ChatTurn, ChatTurnState};

use crate::host::{HostError, STOPPED_BY_TICKETD, problem_key, problem_kind};
use crate::{Problem, ProblemKind};

/// Why ticketd itself stopped a Chat's harness. One vocabulary for the transcript,
/// the Chats list and an Automation run's agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// ticketd quit.
    Quit,
    /// Chat was switched off in Settings.
    TurnedOff,
    /// A backup was being restored, or had just been.
    Restore,
    /// The person took over the Automation run whose agent was working.
    TakenOver,
    /// The run's time limit passed while its agent was working.
    TimeLimit,
    /// The run's agent was closed because its step ended.
    RunEnded,
    /// The Chat was moved to the trash.
    Trashed,
    /// The person resumed the Chat, which replaced its running harness.
    ExplicitResume,
    /// Chat storage failed, so nothing more could be recorded and nothing more ran.
    StorageFailed,
}

impl StopReason {
    /// Every reason, for tests and decoders that look one up by its marker.
    pub const ALL: [Self; 9] = [
        Self::Quit,
        Self::TurnedOff,
        Self::Restore,
        Self::TakenOver,
        Self::TimeLimit,
        Self::RunEnded,
        Self::Trashed,
        Self::ExplicitResume,
        Self::StorageFailed,
    ];

    /// The reason behind a refusal from the host, if it is one of ticketd stopping.
    pub fn of(error: &HostError) -> Option<Self> {
        match error {
            HostError::Quitting => Some(Self::Quit),
            HostError::TurnedOff => Some(Self::TurnedOff),
            HostError::Restoring => Some(Self::Restore),
            // Refusals that are not ticketd stopping; a new error must be decided here.
            HostError::Core(_)
            | HostError::StorageFailed(_)
            | HostError::InteractionExpired
            | HostError::SubAgentGone
            | HostError::SubAgentNotStopped(_)
            | HostError::ContactLost
            | HostError::PermissionRestartCleanupUnconfirmed
            | HostError::Harness(_)
            | HostError::HarnessUnavailable(_)
            | HostError::Busy
            | HostError::Working => None,
        }
    }

    /// For the person, without a full stop: "Stopped when ticketd quit".
    pub const fn words(self) -> &'static str {
        match self {
            Self::Quit => "Stopped when ticketd quit",
            Self::TurnedOff => "Stopped when Chat was turned off",
            Self::Restore => "Stopped when a backup was restored",
            Self::TakenOver => "You took this run over",
            Self::TimeLimit => "Stopped at the run's time limit",
            Self::RunEnded => "Stopped when its run step ended",
            Self::Trashed => "Stopped when the Chat was moved to the trash",
            Self::ExplicitResume => "Stopped when the Chat was resumed",
            Self::StorageFailed => "Stopped when Chat storage failed",
        }
    }

    /// What stopped it, for the Chats list after "Stopped": "ticketd quit". A few words,
    /// because beside a Project the row has room for about a dozen characters; past
    /// that it shortens this with an ellipsis, never the word before it.
    pub const fn cause(self) -> &'static str {
        match self {
            Self::Quit => "ticketd quit",
            Self::TurnedOff => "Chat turned off",
            Self::Restore => "backup restored",
            Self::TakenOver => "you took over",
            Self::TimeLimit => "time limit",
            Self::RunEnded => "step ended",
            Self::Trashed => "trashed",
            Self::ExplicitResume => "Chat resumed",
            Self::StorageFailed => "storage failed",
        }
    }

    /// The transcript's marker for it. Also the key stored after `stopped_by_ticketd:`
    /// in `chat_turns.ending`, so stored endings and markers cannot differ.
    pub const fn marker(self) -> &'static str {
        match self {
            Self::Quit => "quit",
            Self::TurnedOff => "turned_off",
            Self::Restore => "restore",
            Self::TakenOver => "taken_over",
            Self::TimeLimit => "time_limit",
            Self::RunEnded => "run_ended",
            Self::Trashed => "trashed",
            Self::ExplicitResume => "explicit_resume",
            Self::StorageFailed => "storage_failed",
        }
    }

    /// What is kept as the turn's `detail`, so the turn reads right wherever only its
    /// text is shown.
    pub const fn detail(self) -> &'static str {
        match self {
            Self::Quit => STOPPED_BY_TICKETD,
            Self::TurnedOff => "ticketd stopped this Chat when Chat was turned off",
            Self::Restore => "the workspace was restored from a backup",
            Self::TakenOver => "ticketd stopped this run's agent when the run was taken over",
            Self::TimeLimit => "ticketd stopped this run's agent at the run's time limit",
            Self::RunEnded => "ticketd stopped this run's agent when its step ended",
            Self::Trashed => "the Chat was moved to the trash",
            Self::ExplicitResume => "replaced by an explicit resume",
            Self::StorageFailed => "Chat storage failed",
        }
    }

    /// The reason a turn recorded before endings were stored names in its `detail`. The
    /// build before them already recorded every reason's wording, byte for byte as
    /// [`Self::detail`] gives it, so all of them are recognized.
    fn legacy(detail: Option<&str>) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|reason| Some(reason.detail()) == detail)
    }
}

/// How a turn that is no longer active ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnEnding {
    Completed,
    /// The harness reported the turn failed. `kind` is what the person can act on;
    /// `resets_at` is when the provider said the limit behind it resets, in seconds
    /// since the Unix epoch.
    Failed {
        kind: ProblemKind,
        message: Option<String>,
        resets_at: Option<i64>,
    },
    /// The person pressed Stop.
    StoppedByPerson,
    /// ticketd stopped the turn, whether or not the harness reported it ended.
    StoppedByTicketd(StopReason),
    /// Contact with the harness was lost while the turn was active, so how it ended
    /// was not observed. The reason is what was known of the loss, if anything was.
    ContactLost(Option<String>),
}

const COMPLETED: &str = "completed";
const FAILED: &str = "failed";
const STOPPED_BY_PERSON: &str = "stopped_by_person";
const STOPPED_BY_TICKETD_PREFIX: &str = "stopped_by_ticketd:";
const CONTACT_LOST: &str = "contact_lost";

/// A recorded loss reason, or `None` when none was known (older turns kept it as "").
fn known(reason: Option<String>) -> Option<String> {
    reason.filter(|reason| !reason.is_empty())
}

impl TurnEnding {
    /// A failed ending from what the harness reported.
    pub fn failed(problem: &Problem) -> Self {
        Self::Failed {
            kind: problem.kind,
            message: Some(problem.message.chars().take(CHAT_NOTICE_LIMIT).collect()),
            resets_at: problem.resets_at,
        }
    }

    /// How the turn ended, or `None` while it is still active. Reads the ending the
    /// supervisor stored; a turn recorded before endings existed is read from its
    /// state, detail and problem as they were then written.
    pub fn of(turn: &ChatTurn) -> Option<Self> {
        if turn.state == ChatTurnState::Active {
            return None;
        }
        Some(Self::stored(turn).unwrap_or_else(|| Self::legacy(turn)))
    }

    fn stored(turn: &ChatTurn) -> Option<Self> {
        let key = turn.ending.as_deref()?;
        let message = || turn.detail.clone();
        match key {
            COMPLETED => Some(Self::Completed),
            FAILED => Some(Self::Failed {
                kind: problem_kind(turn.problem.as_deref().unwrap_or_default()),
                message: message(),
                resets_at: turn.problem_resets_at,
            }),
            STOPPED_BY_PERSON => Some(Self::StoppedByPerson),
            CONTACT_LOST => Some(Self::ContactLost(known(message()))),
            _ => {
                let reason = key.strip_prefix(STOPPED_BY_TICKETD_PREFIX)?;
                StopReason::ALL
                    .into_iter()
                    .find(|candidate| candidate.marker() == reason)
                    .map(Self::StoppedByTicketd)
            }
        }
    }

    /// The decoder for turns that carry no ending: the only place that reads the
    /// wording kept in `detail` back into a fact.
    fn legacy(turn: &ChatTurn) -> Self {
        match turn.state {
            ChatTurnState::Completed => Self::Completed,
            ChatTurnState::Failed => Self::Failed {
                kind: problem_kind(turn.problem.as_deref().unwrap_or_default()),
                message: turn.detail.clone(),
                resets_at: turn.problem_resets_at,
            },
            ChatTurnState::Interrupted | ChatTurnState::Unknown | ChatTurnState::Active => {
                match StopReason::legacy(turn.detail.as_deref()) {
                    Some(reason) => Self::StoppedByTicketd(reason),
                    None if turn.state == ChatTurnState::Interrupted => Self::StoppedByPerson,
                    None => Self::ContactLost(known(turn.detail.clone())),
                }
            }
        }
    }

    /// The key this ending is stored under in `chat_turns.ending`.
    pub fn key(&self) -> String {
        match self {
            Self::Completed => COMPLETED.to_owned(),
            Self::Failed { .. } => FAILED.to_owned(),
            Self::StoppedByPerson => STOPPED_BY_PERSON.to_owned(),
            Self::StoppedByTicketd(reason) => {
                format!("{STOPPED_BY_TICKETD_PREFIX}{}", reason.marker())
            }
            Self::ContactLost(_) => CONTACT_LOST.to_owned(),
        }
    }

    /// The wording kept as the turn's `detail`.
    pub fn detail(&self) -> Option<String> {
        match self {
            Self::Completed | Self::StoppedByPerson => None,
            Self::Failed { message, .. } => message.clone(),
            Self::StoppedByTicketd(reason) => Some(reason.detail().to_owned()),
            Self::ContactLost(reason) => reason.clone(),
        }
    }

    /// The observation that records this ending for `turn_id`, when the harness
    /// reported the turn ended. (A turn whose end was never reported is settled by
    /// the core's lost-contact step with [`Self::key`] and [`Self::detail`].)
    pub fn observation(&self, turn_id: String) -> ChatObservation {
        let (state, problem, problem_resets_at) = match self {
            Self::Completed => (ChatTurnState::Completed, None, None),
            Self::Failed {
                kind, resets_at, ..
            } => (
                ChatTurnState::Failed,
                Some(problem_key(*kind).to_owned()),
                *resets_at,
            ),
            Self::StoppedByPerson | Self::StoppedByTicketd(_) => {
                (ChatTurnState::Interrupted, None, None)
            }
            Self::ContactLost(_) => (ChatTurnState::Unknown, None, None),
        };
        ChatObservation::TurnEnded {
            turn_id,
            state,
            detail: self.detail(),
            problem,
            problem_resets_at,
            ending: Some(self.key()),
        }
    }

    /// The Chat's list-row words when ticketd stopped the turn.
    pub fn stopped_by_ticketd(&self) -> Option<StopReason> {
        match self {
            Self::StoppedByTicketd(reason) => Some(*reason),
            _ => None,
        }
    }
}

/// A turn as the core stores it once it ended as `ending`: what tests use to build turns
/// through this module instead of by hand.
#[cfg(test)]
pub(crate) fn recorded_turn(position: i64, ending: &TurnEnding) -> ChatTurn {
    let ChatObservation::TurnEnded {
        state,
        detail,
        problem,
        problem_resets_at,
        ending: key,
        ..
    } = ending.observation(format!("t{position}"))
    else {
        panic!("an ending is recorded as a turn end");
    };
    ChatTurn {
        id: format!("t{position}"),
        position,
        native_turn_id: None,
        state,
        detail,
        problem,
        problem_resets_at,
        ending: key,
        started_at: String::new(),
        ended_at: None,
        origin: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(state: ChatTurnState) -> ChatTurn {
        ChatTurn {
            state,
            ..recorded_turn(1, &TurnEnding::Completed)
        }
    }

    #[test]
    fn every_ending_survives_being_stored_and_read_back() {
        let endings = [
            TurnEnding::Completed,
            TurnEnding::StoppedByPerson,
            TurnEnding::ContactLost(Some("the harness process ended".to_owned())),
            TurnEnding::ContactLost(None),
            TurnEnding::Failed {
                kind: ProblemKind::QuotaExhausted,
                message: Some("out of quota".to_owned()),
                resets_at: Some(1_800_000_000),
            },
        ]
        .into_iter()
        .chain(StopReason::ALL.map(TurnEnding::StoppedByTicketd));
        for ending in endings {
            assert_eq!(
                TurnEnding::of(&recorded_turn(1, &ending)),
                Some(ending.clone())
            );
        }
    }

    #[test]
    fn an_active_turn_has_not_ended() {
        let active = ChatTurn {
            ending: None,
            ..turn(ChatTurnState::Active)
        };
        assert_eq!(TurnEnding::of(&active), None);
    }

    fn legacy(state: ChatTurnState, detail: Option<&str>) -> ChatTurn {
        ChatTurn {
            ending: None,
            detail: detail.map(str::to_owned),
            ..turn(state)
        }
    }

    #[test]
    fn turns_recorded_before_endings_existed_still_decode() {
        assert_eq!(
            TurnEnding::of(&legacy(ChatTurnState::Unknown, Some(STOPPED_BY_TICKETD))),
            Some(TurnEnding::StoppedByTicketd(StopReason::Quit))
        );
        assert_eq!(
            TurnEnding::of(&legacy(
                ChatTurnState::Interrupted,
                Some(StopReason::TakenOver.detail())
            )),
            Some(TurnEnding::StoppedByTicketd(StopReason::TakenOver))
        );
        assert_eq!(
            TurnEnding::of(&legacy(ChatTurnState::Interrupted, None)),
            Some(TurnEnding::StoppedByPerson)
        );
        assert_eq!(
            TurnEnding::of(&legacy(
                ChatTurnState::Unknown,
                Some("the harness process ended")
            )),
            Some(TurnEnding::ContactLost(Some(
                "the harness process ended".to_owned()
            )))
        );
        // An older turn that kept no reason stored "": that is no reason, not an empty one.
        assert_eq!(
            TurnEnding::of(&legacy(ChatTurnState::Unknown, Some(""))),
            Some(TurnEnding::ContactLost(None))
        );
        assert_eq!(
            TurnEnding::of(&ChatTurn {
                problem: Some("quota_exhausted".to_owned()),
                problem_resets_at: Some(5),
                ..legacy(ChatTurnState::Failed, Some("Out of quota"))
            }),
            Some(TurnEnding::Failed {
                kind: ProblemKind::QuotaExhausted,
                message: Some("Out of quota".to_owned()),
                resets_at: Some(5),
            })
        );
        assert_eq!(
            TurnEnding::of(&legacy(ChatTurnState::Completed, None)),
            Some(TurnEnding::Completed)
        );
    }
}
