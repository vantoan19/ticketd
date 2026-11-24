//! Lifecycle shared by harness runtimes. State changes are synchronous so the
//! connection can order them with incoming traffic and checked writes.

use std::collections::{HashMap, VecDeque};

use serde_json::Value;

use crate::json_rpc::{CallOutcome, Connection, Peer, RpcError, WriteFailure};
use crate::{
    DeliveryEvidence, DispatchOutcome, EventKind, InteractionResolution, InterruptOutcome,
    NativeRequestId, NativeTurnId, Refusal, RespondOutcome, RuntimeGeneration, SubmissionId,
    SubmissionKind, TurnEvidence, TurnOutcome,
};

// Checked commands for a runtime over JSON-RPC. The codec prepares frames and
// interprets replies. The connection handles bounded writes, loss and shutdown.
impl<P: Peer> Connection<P> {
    pub(crate) fn check_generation(&self, generation: RuntimeGeneration) -> Result<(), Refusal> {
        let current = self.generation();
        if generation != current {
            return Err(Refusal::StaleGeneration { current });
        }
        Ok(())
    }

    pub(crate) async fn submit(
        &self,
        generation: RuntimeGeneration,
        method: &str,
        prepare: impl FnOnce(&mut P) -> Result<(Value, P::Call), Refusal>,
        acknowledged_turn: impl FnOnce(&Value) -> Option<NativeTurnId>,
        rejection_reason: impl FnOnce(&RpcError) -> String,
    ) -> DispatchOutcome {
        if let Err(refusal) = self.check_generation(generation) {
            return DispatchOutcome::NotSent(refusal);
        }
        match self.call(method, prepare).await {
            CallOutcome::Refused(refusal) => DispatchOutcome::NotSent(refusal),
            CallOutcome::Reply(result) => match acknowledged_turn(&result) {
                Some(turn) => DispatchOutcome::Acknowledged { turn },
                None => DispatchOutcome::Written,
            },
            CallOutcome::Error(error) => DispatchOutcome::Rejected {
                reason: rejection_reason(&error),
            },
            CallOutcome::TimedOut => DispatchOutcome::Written,
            CallOutcome::Lost => DispatchOutcome::UnknownAfterLoss,
        }
    }

    pub(crate) async fn respond(
        &self,
        generation: RuntimeGeneration,
        prepare: impl FnOnce(&mut P) -> Result<Value, Refusal>,
    ) -> RespondOutcome {
        if let Err(refusal) = self.check_generation(generation) {
            return RespondOutcome::NotSent(refusal);
        }
        match self.write(prepare).await {
            Ok(()) => RespondOutcome::Sent,
            Err(WriteFailure::Refused(refusal)) => RespondOutcome::NotSent(refusal),
            Err(WriteFailure::Lost) => RespondOutcome::UnknownAfterLoss,
        }
    }

    pub(crate) async fn interrupt(
        &self,
        generation: RuntimeGeneration,
        method: &str,
        prepare: impl FnOnce(&mut P) -> Result<(Value, P::Call), Refusal>,
    ) -> InterruptOutcome {
        if let Err(refusal) = self.check_generation(generation) {
            return InterruptOutcome::NotSent(refusal);
        }
        match self.call(method, prepare).await {
            CallOutcome::Refused(refusal) => InterruptOutcome::NotSent(refusal),
            CallOutcome::Reply(_) => InterruptOutcome::Acknowledged,
            CallOutcome::Error(_) | CallOutcome::TimedOut | CallOutcome::Lost => {
                InterruptOutcome::Unconfirmed
            }
        }
    }
}

/// Recent turn endings and writes retained for late correlation.
const MAX_REMEMBERED: usize = 64;

#[derive(Debug)]
struct LiveRequest<R> {
    turn: Option<NativeTurnId>,
    payload: R,
    answered: bool,
}

/// State the codec updates while interpreting frames and preparing commands.
/// Request payloads carry only what its codec needs to encode a reply.
#[derive(Debug)]
pub(crate) struct RuntimeState<R> {
    active: Option<ActiveTurn>,
    ended_turns: VecDeque<NativeTurnId>,
    written_submissions: VecDeque<SubmissionId>,
    turn_submissions: HashMap<NativeTurnId, Vec<SubmissionId>>,
    requests: HashMap<NativeRequestId, LiveRequest<R>>,
    interrupted: Option<NativeTurnId>,
    marks: HashMap<NativeTurnId, TurnMarks>,
}

/// Observations the codec can turn into evidence when reporting a turn's outcome.
#[derive(Debug, Default)]
pub(crate) struct TurnMarks {
    pub(crate) interrupted: bool,
    pub(crate) denied: Vec<String>,
    pub(crate) not_started: Option<String>,
}

#[derive(Debug)]
enum ActiveTurn {
    Named(NativeTurnId),
    /// A start may be delivered, but the harness has not identified its turn.
    Unconfirmed(SubmissionId),
}

impl<R> Default for RuntimeState<R> {
    fn default() -> Self {
        Self {
            active: None,
            ended_turns: VecDeque::new(),
            written_submissions: VecDeque::new(),
            turn_submissions: HashMap::new(),
            requests: HashMap::new(),
            interrupted: None,
            marks: HashMap::new(),
        }
    }
}

impl<R> RuntimeState<R> {
    fn active_turn_id(&self) -> Option<&NativeTurnId> {
        match &self.active {
            Some(ActiveTurn::Named(id)) => Some(id),
            Some(ActiveTurn::Unconfirmed(_)) | None => None,
        }
    }

    pub(crate) fn check_submission(
        &self,
        kind: &SubmissionKind,
        steering: bool,
    ) -> Result<(), Refusal> {
        match kind {
            SubmissionKind::StartTurn if self.active.is_none() => Ok(()),
            SubmissionKind::Steer { .. } if !steering => Err(Refusal::Unsupported),
            SubmissionKind::Steer { expected_turn } => self.check_turn(expected_turn),
            SubmissionKind::StartTurn => Err(Refusal::TurnMismatch {
                active: self.active_turn_id().cloned(),
            }),
        }
    }

    fn check_turn(&self, expected: &NativeTurnId) -> Result<(), Refusal> {
        let active = self.active_turn_id();
        if active != Some(expected) {
            return Err(Refusal::TurnMismatch {
                active: active.cloned(),
            });
        }
        Ok(())
    }

    /// Completion can precede the reply that identifies the turn. A late reply
    /// must not reactivate it.
    pub(crate) fn turn_started(&mut self, turn: &NativeTurnId) {
        if !self.ended_turns.contains(turn) {
            self.active = Some(ActiveTurn::Named(turn.clone()));
        }
    }

    /// Reserve the turn as its write starts, including while the reply is late.
    pub(crate) fn start_written(&mut self, submission: &SubmissionId) {
        self.active = Some(ActiveTurn::Unconfirmed(submission.clone()));
        self.submission_written(submission);
    }

    pub(crate) fn resolve_start(&mut self, submission: &SubmissionId) -> bool {
        if matches!(&self.active, Some(ActiveTurn::Unconfirmed(written)) if written == submission) {
            self.active = None;
            return true;
        }
        false
    }

    /// Remembers a submission as its write starts so a provider echo can be
    /// recognized as evidence even while the RPC reply is outstanding.
    pub(crate) fn submission_written(&mut self, submission: &SubmissionId) {
        if self.written_submissions.len() == MAX_REMEMBERED {
            self.written_submissions.pop_front();
        }
        self.written_submissions.push_back(submission.clone());
    }

    pub(crate) fn acknowledged(
        &mut self,
        submission: &SubmissionId,
        turn: &NativeTurnId,
        late: bool,
    ) -> Option<EventKind> {
        self.correlate(turn, submission);
        late.then(|| EventKind::SubmissionEvidence {
            submission: submission.clone(),
            evidence: DeliveryEvidence::Acknowledged { turn: turn.clone() },
        })
    }

    pub(crate) fn processing(
        &mut self,
        submission: SubmissionId,
        turn: NativeTurnId,
    ) -> Option<EventKind> {
        if !self.written_submissions.contains(&submission) {
            return None;
        }
        let was_unconfirmed = self.resolve_start(&submission);
        if was_unconfirmed {
            self.turn_started(&turn);
        }
        (self.correlate(&turn, &submission) || was_unconfirmed).then_some(
            EventKind::SubmissionEvidence {
                submission,
                evidence: DeliveryEvidence::Processing { turn },
            },
        )
    }

    fn correlate(&mut self, turn: &NativeTurnId, submission: &SubmissionId) -> bool {
        if self.ended_turns.contains(turn) {
            return false;
        }
        let submissions = self.turn_submissions.entry(turn.clone()).or_default();
        if submissions.contains(submission) {
            return false;
        }
        submissions.push(submission.clone());
        true
    }

    pub(crate) fn mark_interrupt(&mut self, turn: &NativeTurnId) -> Result<(), Refusal> {
        self.check_turn(turn)?;
        self.interrupted = Some(turn.clone());
        Ok(())
    }

    pub(crate) fn interrupted(&self, turn: &NativeTurnId) -> bool {
        self.interrupted.as_ref() == Some(turn)
    }

    pub(crate) fn mark_denial(&mut self, turn: &NativeTurnId, reason: String) {
        if !self.ended_turns.contains(turn) {
            let denied = &mut self.marks.entry(turn.clone()).or_default().denied;
            if !denied.contains(&reason) {
                denied.push(reason);
            }
        }
    }

    pub(crate) fn mark_not_started(
        &mut self,
        turn: &NativeTurnId,
        reason: impl FnOnce() -> String,
    ) {
        if !self.ended_turns.contains(turn) {
            self.marks
                .entry(turn.clone())
                .or_default()
                .not_started
                .get_or_insert_with(reason);
        }
    }

    pub(crate) fn has_request(&self, request: &NativeRequestId) -> bool {
        self.requests.contains_key(request)
    }

    pub(crate) fn unanswered(&self) -> impl Iterator<Item = (&NativeRequestId, &R)> {
        self.requests
            .iter()
            .filter(|(_, live)| !live.answered)
            .map(|(id, live)| (id, &live.payload))
    }

    pub(crate) fn register_request(
        &mut self,
        request: NativeRequestId,
        turn: Option<&NativeTurnId>,
        payload: R,
    ) -> bool {
        match self.requests.entry(request) {
            std::collections::hash_map::Entry::Occupied(_) => false,
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(LiveRequest {
                    turn: turn.cloned(),
                    payload,
                    answered: false,
                });
                true
            }
        }
    }

    /// Only a valid answer consumes the request, immediately before the write
    /// starts. A request that may have been answered stays consumed after a loss.
    pub(crate) fn answer<T>(
        &mut self,
        request: &NativeRequestId,
        encode: impl FnOnce(&R) -> Result<T, Refusal>,
    ) -> Result<T, Refusal> {
        let live = self
            .requests
            .get_mut(request)
            .filter(|live| !live.answered)
            .ok_or(Refusal::UnknownRequest)?;
        let frame = encode(&live.payload)?;
        live.answered = true;
        Ok(frame)
    }

    pub(crate) fn resolve_request(&mut self, request: &NativeRequestId) -> Option<EventKind> {
        let live = self.requests.remove(request)?;
        let resolution = if live.answered {
            InteractionResolution::Answered
        } else {
            InteractionResolution::Withdrawn
        };
        Some(EventKind::InteractionResolved {
            request: request.clone(),
            resolution,
        })
    }

    /// Withdrawals and evidence precede the turn ending on the event stream.
    pub(crate) fn end_turn(
        &mut self,
        turn: NativeTurnId,
        outcome: TurnOutcome,
        evidence_from: impl FnOnce(TurnMarks) -> TurnEvidence,
    ) -> Vec<EventKind> {
        if self.active_turn_id() == Some(&turn) {
            self.active = None;
        }
        if self.ended_turns.len() == MAX_REMEMBERED {
            self.ended_turns.pop_front();
        }
        self.ended_turns.push_back(turn.clone());

        let mut events = Vec::new();
        self.requests.retain(|request, live| {
            if live.turn.as_ref() != Some(&turn) {
                return true;
            }
            if !live.answered {
                events.push(EventKind::InteractionResolved {
                    request: request.clone(),
                    resolution: InteractionResolution::Withdrawn,
                });
            }
            false
        });
        let mut marks = self.marks.remove(&turn).unwrap_or_default();
        marks.interrupted = self.interrupted(&turn);
        let evidence = evidence_from(marks);
        if !evidence.is_empty() {
            events.push(EventKind::TurnEvidence {
                turn: turn.clone(),
                evidence,
            });
        }
        let submissions = self.turn_submissions.remove(&turn).unwrap_or_default();
        events.push(EventKind::TurnEnded {
            turn,
            outcome,
            submissions,
        });
        events
    }

    /// Invalidates live commands. Retain correlation and evidence for terminal
    /// frames the connection may still drain during shutdown.
    pub(crate) fn disconnected(&mut self) {
        self.active = None;
        self.requests.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finishing_a_turn_withdraws_only_unanswered_requests_and_late_replies_do_not_reopen_it() {
        let mut runtime = RuntimeState::default();
        let turn = NativeTurnId::new("first");
        let granted = NativeRequestId::new("granted");
        let pending = NativeRequestId::new("pending");
        runtime.start_written(&SubmissionId::new("first-submission"));
        assert_eq!(
            runtime.check_submission(&SubmissionKind::StartTurn, false),
            Err(Refusal::TurnMismatch { active: None }),
        );
        runtime.turn_started(&turn);
        assert!(runtime.register_request(granted.clone(), Some(&turn), "first answer"));
        assert!(!runtime.register_request(granted.clone(), Some(&turn), "duplicate"));
        assert!(runtime.register_request(pending.clone(), Some(&turn), "no answer"));
        assert_eq!(
            runtime.answer(&granted, |_| Err::<(), _>(Refusal::Unsupported)),
            Err(Refusal::Unsupported),
        );
        assert_eq!(
            runtime.answer(&granted, |answer| Ok(*answer)),
            Ok("first answer")
        );

        assert_eq!(
            runtime.answer(&granted, |_| Ok(())),
            Err(Refusal::UnknownRequest)
        );

        runtime.mark_denial(&NativeTurnId::new("other"), "Other denial".to_owned());
        runtime.mark_denial(&turn, "Write declined".to_owned());
        runtime.mark_interrupt(&turn).expect("the turn is active");
        let events = runtime.end_turn(turn.clone(), TurnOutcome::Completed, |marks| TurnEvidence {
            interrupt_written: marks.interrupted,
            denied: marks.denied.into_iter().next(),
            not_started: marks.not_started,
        });
        assert_eq!(
            events,
            [
                EventKind::InteractionResolved {
                    request: pending.clone(),
                    resolution: InteractionResolution::Withdrawn,
                },
                EventKind::TurnEvidence {
                    turn: turn.clone(),
                    evidence: TurnEvidence {
                        interrupt_written: true,
                        denied: Some("Write declined".to_owned()),
                        not_started: None,
                    },
                },
                EventKind::TurnEnded {
                    turn: turn.clone(),
                    outcome: TurnOutcome::Completed,
                    submissions: Vec::new(),
                },
            ]
        );
        for request in [&granted, &pending] {
            assert_eq!(
                runtime.answer(request, |_| Ok(())),
                Err(Refusal::UnknownRequest)
            );
        }

        runtime.turn_started(&turn);
        assert_eq!(
            runtime.check_submission(&SubmissionKind::StartTurn, false),
            Ok(())
        );
    }
}
