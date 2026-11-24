//! Running one turn of a Chat with nobody there: what an Automation run's agent step
//! needs from the host. The harness is opened with the agent's settings and never
//! asks; this module sends the first message, waits for the turn to end or the time
//! limit to pass, says how it ended, and stops the harness process.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use ticketd_core::{AutomationRunStatus, ChatObservation, ChatTurn, Workspace};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::timeout;

use crate::host::{Activity, ChatHost, ChatLive, ChatProblem, HostError};
use crate::supervisor::Command;
use crate::{ProblemKind, StopReason, TurnEnding, Unattended};

/// The registration shared by the Automation waiter and its supervisor.
pub(crate) struct UnattendedChat {
    pub(crate) settings: Unattended,
    pub(crate) first_message: OnceLock<String>,
    pub(crate) turned_off: watch::Sender<bool>,
}

impl UnattendedChat {
    pub(crate) fn new(settings: Unattended) -> Arc<Self> {
        Arc::new(Self {
            settings,
            first_message: OnceLock::new(),
            turned_off: watch::channel(false).0,
        })
    }
}

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
    /// The harness could not start the agent's commands, so none ran. A command
    /// that ran and failed is not this: the agent saw its result.
    CommandsUnavailable {
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
    /// The person replied in or stopped the Chat (or another Chat of the same run):
    /// the run is theirs, and so is this Chat from here on.
    TakenOver,
    /// ticketd closed the Chat's harness. The reason is `None` when the supervisor went
    /// away while the host was still serving, and none is known.
    Stopped(Option<StopReason>),
}

impl ChatHost {
    /// Sends `text` as the first message of a Chat nobody watches and returns how its
    /// turn ended. The harness runs with `unattended`'s settings; a turn still active
    /// after `time_limit` is stopped. The unattended harness process is closed before
    /// this returns, whatever happened. When the person took the Chat over meanwhile,
    /// `take_over` closed it and this returns `TakenOver` without touching the
    /// session that is now theirs: neither the turn's end nor the time limit ends it.
    /// When the run was taken over or stopped before the agent could start, even
    /// just after its Chat was created, no agent starts and this returns `TakenOver`.
    pub async fn run_unattended(
        &self,
        chat_id: &str,
        text: &str,
        unattended: Unattended,
        time_limit: Duration,
    ) -> Result<TurnEnd, HostError> {
        let unattended = UnattendedChat::new(unattended);
        self.register_unattended(chat_id, unattended.clone());
        let ended = self
            .first_turn(chat_id, &unattended, text, time_limit)
            .await;
        self.stop_listening(chat_id);
        let why = match ended {
            Ok(TurnEnd::TimeLimitReached) => StopReason::TimeLimit,
            _ => StopReason::RunEnded,
        };
        if self.end_unattended(chat_id, why).await.is_none() {
            return Ok(TurnEnd::TakenOver);
        }
        ended
    }

    async fn first_turn(
        &self,
        chat_id: &str,
        unattended: &UnattendedChat,
        text: &str,
        time_limit: Duration,
    ) -> Result<TurnEnd, HostError> {
        // Subscribed before the send, so no step of the turn is missed.
        let mut changed = self.listen(chat_id);
        let mut turned_off = unattended.turned_off.subscribe();
        // Whoever ended the run before the Chat was registered as unattended found
        // no agent to stop, so the run is looked at after registering. Whoever ends
        // it from here on finds the registration, and `unattended_sender` sees that.
        if self
            .workspace()?
            .automation_run(&unattended.settings.run_id)?
            .status
            != AutomationRunStatus::Running
        {
            return Ok(TurnEnd::TakenOver);
        }
        let Some(agent) = self.unattended_sender(chat_id)? else {
            return Ok(TurnEnd::TakenOver);
        };
        let (reply, sent) = oneshot::channel();
        let first = Command::SendUnattended {
            text: text.to_owned(),
            reply,
        };
        let not_sent = || {
            if *turned_off.borrow() {
                HostError::TurnedOff
            } else {
                HostError::Quitting
            }
        };
        agent.send(first).await.map_err(|_| not_sent())?;
        sent.await.map_err(|_| not_sent())??;
        let waiting = async {
            loop {
                if *turned_off.borrow() {
                    return Ok(TurnEnd::Stopped(Some(StopReason::TurnedOff)));
                }
                if !self.is_unattended(chat_id) {
                    return Ok(TurnEnd::TakenOver);
                }
                if agent.is_closed() {
                    let reason = self.serving().err();
                    return Ok(TurnEnd::Stopped(reason.as_ref().and_then(StopReason::of)));
                }
                if let Some(end) = self.turn_end(chat_id)? {
                    return Ok(end);
                }
                tokio::select! {
                    () = agent.closed() => {}
                    result = turned_off.changed() => result.map_err(|_| HostError::Quitting)?,
                    result = changed.changed() => result.map_err(|_| HostError::Quitting)?,
                }
            }
        };
        match timeout(time_limit, waiting).await {
            Ok(ended) => ended,
            Err(_) => Ok(TurnEnd::TimeLimitReached),
        }
    }

    /// How the Chat's turn ended, or `None` while it is still going or has not begun.
    fn turn_end(&self, chat_id: &str) -> Result<Option<TurnEnd>, HostError> {
        if let Some(end) = self
            .live()
            .get(chat_id)
            .map(live_end)
            .transpose()?
            .flatten()
        {
            return Ok(Some(end));
        }
        let turn = self.workspace()?.chat_latest_turn(chat_id)?;
        Ok(turn.as_ref().and_then(recorded_end))
    }

    /// Stops the Chat's supervisor and its harness process with bounded cleanup.
    /// Returns why the shutdown could not be confirmed, if it could not.
    pub(crate) async fn close_unattended(
        commands: mpsc::Sender<Command>,
        why: StopReason,
    ) -> Option<String> {
        let (reply, done) = oneshot::channel();
        if commands.send(Command::Shutdown(why, reply)).await.is_ok() {
            return done.await.ok().flatten();
        }
        None
    }
}

/// Keep the Automation's first Prompt in history without offering to send it as
/// the person's input. The exact ID also protects input saved during a takeover.
pub(crate) fn set_aside_first_message(
    workspace: &mut Workspace,
    chat_id: &str,
    message_id: &str,
    why: StopReason,
) {
    let set_aside = workspace
        .set_aside_queued_chat_input(chat_id, message_id)
        .is_ok()
        || workspace
            .discard_uncertain_chat_submission(chat_id, message_id)
            .is_ok();
    if set_aside {
        let notice = ChatObservation::Notice {
            notice_id: uuid::Uuid::new_v4().to_string(),
            text: format!("{}.", why.words()),
            from_harness: false,
        };
        let _ = workspace.record_chat_observations(chat_id, vec![notice]);
    }
}

/// What the supervisor's live state says ended the turn, if it does. Chat storage
/// failing is not the turn ending: what happened to the agent is unknown and nothing
/// more can be recorded. It is the error the runner treats as storage failing, as when
/// the Workspace cannot be read, and never a failure of the step.
fn live_end(live: &ChatLive) -> Result<Option<TurnEnd>, HostError> {
    match &live.problem {
        Some(ChatProblem::RuntimeLost { detail }) => {
            return Ok(Some(TurnEnd::Crashed {
                detail: detail.clone(),
            }));
        }
        Some(ChatProblem::OpenFailed { problem, .. }) => {
            return Ok(Some(TurnEnd::Failed {
                detail: problem.message.clone(),
            }));
        }
        Some(ChatProblem::StorageFailed { detail }) => {
            return Err(HostError::StorageFailed(detail.clone()));
        }
        Some(
            ChatProblem::DispatchRefused { detail }
            | ChatProblem::CleanupUnconfirmed { reason: detail },
        ) => {
            return Ok(Some(TurnEnd::Failed {
                detail: detail.clone(),
            }));
        }
        None => {}
    }
    // An unattended harness is told never to ask. One that asks anyway would wait
    // for ever, so the question itself ends the turn.
    Ok(
        (live.activity == Activity::WaitingForYou).then(|| TurnEnd::ToolDenied {
            detail: "The agent asked for an approval, and nobody is there to give one.".to_owned(),
        }),
    )
}

/// What a recorded turn says about how it ended, if it has.
fn recorded_end(turn: &ChatTurn) -> Option<TurnEnd> {
    Some(match TurnEnding::of(turn)? {
        TurnEnding::Completed => TurnEnd::Finished,
        TurnEnding::Failed { kind, message, .. } => {
            let detail = message.unwrap_or_default();
            match kind {
                ProblemKind::TurnLimitReached => TurnEnd::TurnLimitReached,
                ProblemKind::ToolDenied => TurnEnd::ToolDenied { detail },
                ProblemKind::PermissionUnavailable => TurnEnd::CommandsUnavailable { detail },
                ProblemKind::NotInstalled
                | ProblemKind::IncompatibleVersion
                | ProblemKind::LoginRequired
                | ProblemKind::QuotaExhausted
                | ProblemKind::NativeHistoryUnavailable
                | ProblemKind::SessionInUse
                | ProblemKind::Other => TurnEnd::Failed { detail },
            }
        }
        // Nothing here stops an unattended turn except the time limit, which does
        // not come through this path; a turn the person stopped did not finish.
        TurnEnding::StoppedByPerson => TurnEnd::Failed {
            detail: "The turn was stopped.".to_owned(),
        },
        TurnEnding::StoppedByTicketd(StopReason::TakenOver) => TurnEnd::TakenOver,
        // The Chat was trashed, or the person's resume replaced its harness, while the
        // agent worked: the agent's turn was cut off, which is the step failing.
        TurnEnding::StoppedByTicketd(
            reason @ (StopReason::Trashed | StopReason::ExplicitResume),
        ) => TurnEnd::Failed {
            detail: reason.words().to_owned(),
        },
        TurnEnding::StoppedByTicketd(reason) => TurnEnd::Stopped(Some(reason)),
        TurnEnding::ContactLost(detail) => TurnEnd::Crashed {
            detail: detail.unwrap_or_default(),
        },
    })
}
