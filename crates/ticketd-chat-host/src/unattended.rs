//! Running one turn of a Chat with nobody there: what an Automation run's agent step
//! needs from the host. The harness is opened with the agent's settings and never
//! asks; this module sends the first message, waits for the turn to end or the time
//! limit to pass, says how it ended, and stops the harness process.

use std::time::Duration;

use ticketd_core::{ChatTurn, ChatTurnState};
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::host::{Activity, ChatHost, ChatLive, ChatProblem, HostError, SendMode, problem_kind};
use crate::supervisor::Command;
use crate::{ProblemKind, Unattended};

/// How an unattended turn ended. Only `Finished` is the agent ending its turn itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnEnd {
    Finished,
    TurnLimitReached,
    /// The turn was still going when its time was up, and was stopped.
    TimeLimitReached,
    /// The agent tried something outside its allowed tools, or asked for an approval
    /// nobody is there to give.
    ToolDenied {
        detail: String,
    },
    /// The harness process went away mid-turn.
    Crashed {
        detail: String,
    },
    /// Anything else that kept the turn from finishing: the harness did not start, is
    /// signed out or out of quota, or reported an error.
    Failed {
        detail: String,
    },
}

impl ChatHost {
    /// Sends `text` as the first message of a Chat nobody watches and returns how its
    /// turn ended. The harness runs with `unattended`'s settings; a turn still active
    /// after `time_limit` is stopped. The harness process is closed before this
    /// returns, whatever happened.
    pub async fn run_unattended(
        &self,
        chat_id: &str,
        text: &str,
        unattended: Unattended,
        time_limit: Duration,
    ) -> Result<TurnEnd, HostError> {
        self.set_unattended(chat_id, Some(unattended));
        let ended = self.first_turn(chat_id, text, time_limit).await;
        self.close(chat_id).await;
        self.set_unattended(chat_id, None);
        ended
    }

    async fn first_turn(
        &self,
        chat_id: &str,
        text: &str,
        time_limit: Duration,
    ) -> Result<TurnEnd, HostError> {
        // Subscribed before the send, so no step of the turn is missed.
        let mut changed = self.changed();
        let command_id = format!("{chat_id}:first");
        self.send(chat_id, Some(&command_id), text, SendMode::Auto)
            .await?;
        let waiting = async {
            loop {
                if let Some(end) = self.turn_end(chat_id)? {
                    return Ok(end);
                }
                changed.changed().await.map_err(|_| HostError::Quitting)?;
            }
        };
        match timeout(time_limit, waiting).await {
            Ok(ended) => ended,
            Err(_) => Ok(TurnEnd::TimeLimitReached),
        }
    }

    /// How the Chat's turn ended, or `None` while it is still going or has not begun.
    fn turn_end(&self, chat_id: &str) -> Result<Option<TurnEnd>, HostError> {
        if let Some(end) = self.live().get(chat_id).and_then(live_end) {
            return Ok(Some(end));
        }
        let turn = self.workspace()?.chat_latest_turn(chat_id)?;
        Ok(turn.as_ref().and_then(recorded_end))
    }

    /// Stops the Chat's supervisor and its harness process with bounded cleanup.
    async fn close(&self, chat_id: &str) {
        let Some(commands) = self.forget(chat_id) else {
            return;
        };
        let (reply, done) = oneshot::channel();
        if commands.send(Command::Shutdown(reply)).await.is_ok() {
            let _ = done.await;
        }
    }
}

/// What the supervisor's live state says ended the turn, if it does.
fn live_end(live: &ChatLive) -> Option<TurnEnd> {
    match &live.problem {
        Some(ChatProblem::RuntimeLost { detail }) => {
            return Some(TurnEnd::Crashed {
                detail: detail.clone(),
            });
        }
        Some(ChatProblem::OpenFailed { problem, .. }) => {
            return Some(TurnEnd::Failed {
                detail: problem.message.clone(),
            });
        }
        Some(
            ChatProblem::DispatchRefused { detail }
            | ChatProblem::StorageFailed { detail }
            | ChatProblem::CleanupUnconfirmed { reason: detail },
        ) => {
            return Some(TurnEnd::Failed {
                detail: detail.clone(),
            });
        }
        None => {}
    }
    // An unattended harness is told never to ask. One that asks anyway would wait
    // for ever, so the question itself ends the turn.
    (live.activity == Activity::WaitingForYou).then(|| TurnEnd::ToolDenied {
        detail: "The agent asked for an approval, and nobody is there to give one.".to_owned(),
    })
}

/// What a recorded turn says about how it ended, if it has.
fn recorded_end(turn: &ChatTurn) -> Option<TurnEnd> {
    let detail = || turn.detail.clone().unwrap_or_default();
    match turn.state {
        ChatTurnState::Active => None,
        ChatTurnState::Completed => Some(TurnEnd::Finished),
        ChatTurnState::Failed => Some(
            match problem_kind(turn.problem.as_deref().unwrap_or_default()) {
                ProblemKind::TurnLimitReached => TurnEnd::TurnLimitReached,
                ProblemKind::ToolDenied => TurnEnd::ToolDenied { detail: detail() },
                ProblemKind::NotInstalled
                | ProblemKind::IncompatibleVersion
                | ProblemKind::LoginRequired
                | ProblemKind::QuotaExhausted
                | ProblemKind::NativeHistoryUnavailable
                | ProblemKind::SessionInUse
                | ProblemKind::PermissionUnavailable
                | ProblemKind::Other => TurnEnd::Failed { detail: detail() },
            },
        ),
        // Nothing here stops an unattended turn except the time limit, which does
        // not come through this path; a turn stopped otherwise did not finish.
        ChatTurnState::Interrupted => Some(TurnEnd::Failed {
            detail: "The turn was stopped.".to_owned(),
        }),
        ChatTurnState::Unknown => Some(TurnEnd::Crashed { detail: detail() }),
    }
}
