//! How a turn and its tools read, decided once for every harness.
//!
//! Adapters report what their harness said and the evidence they saw (see
//! [`TurnEvidence`] and [`ToolStatus::FailedAfterInterrupt`]); they do not decide what
//! it means. The supervisor asks here, so Claude Code, Codex and any later harness are
//! read by the same rules, and a rule is changed in one place.

use ticketd_core::ChatToolState;

use crate::{Problem, ProblemKind, ToolStatus, TurnEvidence, TurnOutcome};

/// The outcome of a turn once its evidence is weighed, in this order:
///
/// 1. A turn that hit its turn limit stays that: it is the harness's own verdict.
/// 2. An interrupted turn stays interrupted.
/// 3. A turn the harness called completed, or failed without a cause it could name,
///    after an unattended session's allowed tools denied something, failed on the
///    denial: the agent could not do its work. A failure with a cause the person can
///    act on (sign in, a usage limit) keeps it.
/// 4. A completed turn in which the harness could not start a command failed for want
///    of that permission.
/// 5. A failure after an interrupt was written is the interrupt: the turn was
///    interrupted.
pub(crate) fn settle(outcome: TurnOutcome, evidence: &TurnEvidence) -> TurnOutcome {
    let failed_with = |kind, message: &String| {
        TurnOutcome::Failed(Problem {
            kind,
            message: message.clone(),
            detail: None,
            resets_at: None,
        })
    };
    match (&outcome, &evidence.denied, &evidence.not_started) {
        (
            TurnOutcome::Failed(Problem {
                kind: ProblemKind::TurnLimitReached,
                ..
            })
            | TurnOutcome::Interrupted,
            _,
            _,
        ) => outcome,
        (
            TurnOutcome::Completed
            | TurnOutcome::Failed(Problem {
                kind: ProblemKind::Other,
                ..
            }),
            Some(denied),
            _,
        ) => failed_with(ProblemKind::ToolDenied, denied),
        (TurnOutcome::Completed, _, Some(why)) => {
            failed_with(ProblemKind::PermissionUnavailable, why)
        }
        (TurnOutcome::Failed(_), _, _) if evidence.interrupt_written => TurnOutcome::Interrupted,
        _ => outcome,
    }
}

/// The state a tool is stored in. A tool that failed after its turn was interrupted
/// was cut off, not broken: it stays unfinished, and the turn shows it as not finished.
pub(crate) fn tool_state(status: ToolStatus) -> ChatToolState {
    match status {
        ToolStatus::Running | ToolStatus::FailedAfterInterrupt => ChatToolState::Running,
        ToolStatus::Succeeded => ChatToolState::Completed,
        ToolStatus::Failed => ChatToolState::Failed,
        ToolStatus::Declined => ChatToolState::Declined,
    }
}

/// How the turn that `events` end reads: the harness's outcome with the evidence sent
/// before it, settled by the supervisor's rules. For adapter tests, which assert what
/// a harness's traffic comes to without a supervisor.
#[cfg(test)]
pub(crate) fn read_end(events: &[crate::EventKind]) -> Option<TurnOutcome> {
    use crate::EventKind;
    let evidence = events
        .iter()
        .find_map(|event| match event {
            EventKind::TurnEvidence { evidence, .. } => Some(evidence.clone()),
            _ => None,
        })
        .unwrap_or_default();
    events.iter().find_map(|event| match event {
        EventKind::TurnEnded { outcome, .. } => Some(settle(outcome.clone(), &evidence)),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed(kind: ProblemKind) -> TurnOutcome {
        TurnOutcome::Failed(Problem {
            kind,
            message: "it failed".to_owned(),
            detail: None,
            resets_at: None,
        })
    }

    fn denied() -> TurnEvidence {
        TurnEvidence {
            denied: Some("Bash `rm -rf` was denied.".to_owned()),
            ..TurnEvidence::default()
        }
    }

    fn kind_of(outcome: &TurnOutcome) -> Option<ProblemKind> {
        match outcome {
            TurnOutcome::Failed(problem) => Some(problem.kind),
            _ => None,
        }
    }

    #[test]
    fn without_evidence_the_harnesss_outcome_stands() {
        let none = TurnEvidence::default();
        assert_eq!(
            settle(TurnOutcome::Completed, &none),
            TurnOutcome::Completed
        );
        assert_eq!(
            settle(TurnOutcome::Interrupted, &none),
            TurnOutcome::Interrupted
        );
        assert_eq!(
            settle(failed(ProblemKind::Other), &none),
            failed(ProblemKind::Other)
        );
    }

    #[test]
    fn a_denial_fails_a_turn_that_otherwise_completed_and_names_it() {
        let settled = settle(TurnOutcome::Completed, &denied());

        assert_eq!(kind_of(&settled), Some(ProblemKind::ToolDenied));
        let TurnOutcome::Failed(problem) = settled else {
            unreachable!("checked above");
        };
        assert_eq!(problem.message, "Bash `rm -rf` was denied.");
    }

    #[test]
    fn a_denial_outranks_an_interrupt_but_not_a_cause_the_person_can_act_on() {
        let both = TurnEvidence {
            interrupt_written: true,
            ..denied()
        };

        assert_eq!(
            kind_of(&settle(failed(ProblemKind::Other), &both)),
            Some(ProblemKind::ToolDenied)
        );
        assert_eq!(
            settle(failed(ProblemKind::QuotaExhausted), &denied()),
            failed(ProblemKind::QuotaExhausted)
        );
        assert_eq!(
            settle(failed(ProblemKind::TurnLimitReached), &both),
            failed(ProblemKind::TurnLimitReached)
        );
        assert_eq!(
            settle(TurnOutcome::Interrupted, &denied()),
            TurnOutcome::Interrupted
        );
    }

    #[test]
    fn a_command_that_could_not_start_fails_a_completed_turn_only() {
        let evidence = TurnEvidence {
            not_started: Some("sandbox not ready".to_owned()),
            ..TurnEvidence::default()
        };

        assert_eq!(
            kind_of(&settle(TurnOutcome::Completed, &evidence)),
            Some(ProblemKind::PermissionUnavailable)
        );
        assert_eq!(
            settle(TurnOutcome::Interrupted, &evidence),
            TurnOutcome::Interrupted
        );
        assert_eq!(
            settle(failed(ProblemKind::LoginRequired), &evidence),
            failed(ProblemKind::LoginRequired)
        );
    }

    #[test]
    fn a_failure_after_an_interrupt_was_written_is_the_interrupt() {
        let interrupted = TurnEvidence {
            interrupt_written: true,
            ..TurnEvidence::default()
        };

        assert_eq!(
            settle(failed(ProblemKind::Other), &interrupted),
            TurnOutcome::Interrupted
        );
        assert_eq!(
            settle(failed(ProblemKind::LoginRequired), &interrupted),
            TurnOutcome::Interrupted
        );
        assert_eq!(
            settle(TurnOutcome::Completed, &interrupted),
            TurnOutcome::Completed
        );
    }

    #[test]
    fn a_tool_that_failed_after_an_interrupt_is_left_unfinished() {
        assert_eq!(
            tool_state(ToolStatus::FailedAfterInterrupt),
            ChatToolState::Running
        );
        assert_eq!(tool_state(ToolStatus::Failed), ChatToolState::Failed);
        assert_eq!(tool_state(ToolStatus::Declined), ChatToolState::Declined);
    }
}
