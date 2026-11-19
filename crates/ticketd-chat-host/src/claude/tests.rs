//! Drives the adapter through its contract interface against scripted bridge traffic.
//! Each fixture is a JSON-lines transcript: `client` commands the adapter must write,
//! `server` events the bridge sends, and `mark` lines where the test acts.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::time::{sleep, timeout};

use super::runtime::{Options, open_over, probe, probe_options};
use super::{BRIDGE_SIDECAR_NAME, candidates, locate, verdict};
use crate::conformance::{NewTurn, Provider};
use crate::install::{LaunchEnvironment, Os};
use crate::outcome::read_end;
use crate::scripted::{Peer, brief, pipes};
use crate::stdio::{Line, read_line, spawn};
use crate::{
    ApprovalDecision, Capability, CloseOutcome, DeliveryEvidence, DispatchOutcome, EventKind,
    EventStream, HarnessRuntime, Inspection, InteractionAnswer, InteractionResponse,
    InterruptOutcome, InterruptRequest, LoginState, NativeRequestId, NativeSessionId, NativeTurnId,
    OpenRequest, OpenedRuntime, Problem, ProblemKind, QuestionAnswer, Refusal, RespondOutcome,
    RuntimeGeneration, SessionStart, StartSettings, Submission, SubmissionId, SubmissionKind,
};

const GENERATION: RuntimeGeneration = RuntimeGeneration(7);
const CLAUDE: &str = "/opt/claude/bin/claude";

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!("../../tests/fixtures/claude/", $name, ".jsonl"))
    };
}

async fn open_with(fixture: &str, session: SessionStart) -> (Peer, Result<OpenedRuntime, Problem>) {
    let (mut peer, io) = pipes();
    peer.load(fixture);
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session,
        unattended: None,
        ticketd_cli: None,
        taken_over: false,
        recorded_settings: None,
        settings: StartSettings::default(),
    };
    let opening = open_over(io, &request, Path::new(CLAUDE), Options::default());
    let (opened, ()) = tokio::join!(opening, peer.play());
    (peer, opened)
}

/// A new session. Opening reports nothing: the session has no identity yet.
async fn open() -> (Peer, Arc<dyn HarnessRuntime>, EventStream) {
    let (peer, opened) = open_with(fixture!("handshake"), SessionStart::New).await;
    let mut opened = opened.expect("the handshake succeeds");
    assert_eq!(seen(&mut opened.events).await, [] as [&str; 0]);
    (peer, opened.runtime, opened.events)
}

/// Runs everything until idle, then returns the events so far in short form.
async fn seen(events: &mut EventStream) -> Vec<String> {
    drain(events).await.iter().map(brief).collect()
}

async fn drain(events: &mut EventStream) -> Vec<EventKind> {
    sleep(Duration::from_millis(1)).await;
    let mut kinds = Vec::new();
    while let Ok(event) = events.try_recv() {
        assert_eq!(event.generation, GENERATION);
        kinds.push(event.kind);
    }
    kinds
}

fn start_turn(id: &str, text: &str) -> Submission {
    Submission {
        submission: SubmissionId::new(id),
        generation: GENERATION,
        kind: SubmissionKind::StartTurn,
        text: text.to_owned(),
    }
}

fn turn(id: &str) -> NativeTurnId {
    NativeTurnId::new(id)
}

fn answer(request: &str, answer: InteractionAnswer) -> InteractionResponse {
    InteractionResponse {
        generation: GENERATION,
        request: NativeRequestId::new(request),
        answer,
    }
}

fn approve(request: &str, decision: ApprovalDecision) -> InteractionResponse {
    answer(request, InteractionAnswer::Approval(decision))
}

fn interrupt(expected_turn: &str) -> InterruptRequest {
    InterruptRequest {
        generation: GENERATION,
        expected_turn: turn(expected_turn),
    }
}

fn processing(submission: &str, turn: &str) -> String {
    format!("evidence {submission} Processing {{ turn: NativeTurnId({turn:?}) }}")
}

/// Submits while the peer plays to its next mark, as the supervisor would while it
/// keeps receiving events.
async fn submit(
    peer: &mut Peer,
    runtime: &Arc<dyn HarnessRuntime>,
    submission: Submission,
) -> DispatchOutcome {
    let (outcome, ()) = tokio::join!(runtime.submit(submission), peer.play());
    outcome
}

#[tokio::test(start_paused = true)]
async fn handing_input_to_the_sdk_is_a_write_and_later_evidence_arrives_as_events() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("input_lifecycle"));

    let outcome = submit(&mut peer, &runtime, start_turn("sub-1", "List the files")).await;

    // The SDK took the input. That is not an acknowledgment and names no turn.
    assert_eq!(outcome, DispatchOutcome::Written);
    assert_eq!(seen(&mut events).await, [] as [&str; 0]);

    peer.play().await;
    assert_eq!(
        seen(&mut events).await,
        [
            "session sess-1",
            "notice EffectiveSettings",
            "settings model=claude-test[] permission=default[\"default\", \"acceptEdits\", \"plan\"]",
            "turn-started local-turn-1",
            "delta text-1 \"Here\"",
            &processing("sub-1", "local-turn-1"),
            "delta text-1 \" you go\"",
            "message text-1 \"Here you go\"",
            // Thinking whose start the bridge did not report has no times.
            "reasoning thinking-1 done None None Some(\"pondering\") None",
            "tool toolu_1 \"Bash\" Running None",
            "tool toolu_1 \"Bash\" Succeeded Some(\"a.txt\")",
            "message text-2 \"Done.\"",
        ]
    );

    // One turn at a time, and steering is not offered: neither writes anything.
    let second = runtime.submit(start_turn("sub-2", "And then?")).await;
    let steered = runtime
        .submit(Submission {
            kind: SubmissionKind::Steer {
                expected_turn: turn("local-turn-1"),
            },
            ..start_turn("sub-3", "Also this")
        })
        .await;
    assert_eq!(
        second,
        DispatchOutcome::NotSent(Refusal::TurnMismatch {
            active: Some(turn("local-turn-1"))
        })
    );
    assert_eq!(steered, DispatchOutcome::NotSent(Refusal::Unsupported));
    peer.assert_nothing_written().await;

    peer.play().await;
    assert_eq!(
        seen(&mut events).await,
        ["turn-ended local-turn-1 Completed [\"sub-1\"]"]
    );
}

#[tokio::test(start_paused = true)]
async fn a_permission_names_the_command_apart_from_why_it_is_asked() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("permission_command"));
    submit(&mut peer, &runtime, start_turn("sub-1", "Run the tests")).await;

    assert_eq!(
        seen(&mut events).await,
        [
            "turn-started local-turn-1",
            &processing("sub-1", "local-turn-1"),
            "approval 7-1 \"npm test\" Some(\"Runs the project's tests\") [Allow, Deny]",
            // With only a reason given, it is the request's one description.
            "approval 7-2 \"Fetching is not allowed by your settings\" None [Allow, Deny]",
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn output_keeps_flowing_while_a_permission_or_question_waits_for_its_answer() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("permission_wait"));
    submit(&mut peer, &runtime, start_turn("sub-1", "Change it")).await;

    assert_eq!(
        seen(&mut events).await,
        [
            "turn-started local-turn-1",
            &processing("sub-1", "local-turn-1"),
            "tool toolu_1 \"Write\" Running None",
            // Listed as soon as the edit starts; confirmed only by its result.
            "files [\"Modified /work/chat-1/a.txt unconfirmed\"]",
            "approval 7-1 \"Write to a.txt\" None [Allow, Deny]",
            "delta text-1 \"Waiting\"",
        ]
    );

    // Remembering a rule is not offered, and a request takes one answer.
    let remembered = runtime
        .respond(approve("7-1", ApprovalDecision::AllowForSession))
        .await;
    assert_eq!(remembered, RespondOutcome::NotSent(Refusal::Unsupported));
    peer.assert_nothing_written().await;
    let allowed = runtime
        .respond(approve("7-1", ApprovalDecision::Allow))
        .await;
    let again = runtime
        .respond(approve("7-1", ApprovalDecision::Deny))
        .await;
    assert_eq!(allowed, RespondOutcome::Sent);
    assert_eq!(again, RespondOutcome::NotSent(Refusal::UnknownRequest));

    peer.play().await;
    assert_eq!(
        seen(&mut events).await,
        [
            "resolved 7-1 Answered",
            "question 7-2 Which scope? \"Which scope?\" [\"Small\", \"Large\"]",
        ]
    );

    let answers = |scope: &[&str]| {
        let values = |values: &[&str]| values.iter().map(|value| (*value).to_owned()).collect();
        answer(
            "7-2",
            InteractionAnswer::Answers(vec![
                QuestionAnswer {
                    question_id: "Which scope?".to_owned(),
                    values: values(scope),
                },
                QuestionAnswer {
                    question_id: "Which files?".to_owned(),
                    values: values(&["a.txt", "b.txt"]),
                },
            ]),
        )
    };
    // A question is not a permission, and one choice means one value.
    let allowed = runtime
        .respond(approve("7-2", ApprovalDecision::Allow))
        .await;
    let two_scopes = runtime.respond(answers(&["Small", "Large"])).await;
    assert_eq!(allowed, RespondOutcome::NotSent(Refusal::Unsupported));
    assert_eq!(two_scopes, RespondOutcome::NotSent(Refusal::Unsupported));
    assert_eq!(
        runtime.respond(answers(&["Small"])).await,
        RespondOutcome::Sent
    );

    peer.play().await;
    assert_eq!(seen(&mut events).await, ["resolved 7-2 Answered"]);
}

#[tokio::test(start_paused = true)]
async fn cancellation_invalidates_answers_even_when_one_is_already_on_its_way() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("cancellation_race"));
    submit(&mut peer, &runtime, start_turn("sub-1", "Change it")).await;
    drain(&mut events).await;

    // Claude Code withdrew the first request itself.
    let withdrawn = runtime
        .respond(approve("7-1", ApprovalDecision::Allow))
        .await;
    assert_eq!(withdrawn, RespondOutcome::NotSent(Refusal::UnknownRequest));

    let (interrupted, ()) = tokio::join!(runtime.interrupt(interrupt("local-turn-1")), async {
        peer.play().await;
        sleep(Duration::from_millis(1)).await;
        // The interrupt's cancellation of 7-2 was read; that of 7-3 was not yet.
        let cancelled = runtime
            .respond(approve("7-2", ApprovalDecision::Allow))
            .await;
        let racing = runtime
            .respond(approve("7-3", ApprovalDecision::Allow))
            .await;
        assert_eq!(cancelled, RespondOutcome::NotSent(Refusal::UnknownRequest));
        assert_eq!(racing, RespondOutcome::Sent);
        peer.play().await;
    });

    // Acknowledged is not interrupted, and the racing approval resolved nothing.
    assert_eq!(interrupted, InterruptOutcome::Acknowledged);
    assert_eq!(
        seen(&mut events).await,
        ["resolved 7-2 Withdrawn", "resolved 7-3 Withdrawn"]
    );

    peer.play().await;
    assert_eq!(
        seen(&mut events).await,
        [
            "session sess-1",
            // Claude Code ends an interrupted turn with an unsuccessful result; that an
            // interrupt was written is evidence, and the supervisor reads the turn.
            "turn-evidence local-turn-1 interrupt-written",
            "turn-ended local-turn-1 Failed(Other) [\"sub-1\"]"
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn a_result_resolves_the_inputs_it_names_and_no_others() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("merged_inputs"));

    submit(&mut peer, &runtime, start_turn("sub-1", "First")).await;
    assert_eq!(
        seen(&mut events).await,
        [
            "turn-started local-turn-1",
            &processing("sub-1", "local-turn-1"),
            &processing("sub-2", "local-turn-1"),
            "session sess-1",
            "turn-ended local-turn-1 Completed [\"sub-1\", \"sub-2\"]",
        ]
    );

    // A result that names no input ends a turn without resolving the pending one.
    submit(&mut peer, &runtime, start_turn("sub-3", "Third")).await;
    assert_eq!(
        seen(&mut events).await,
        [
            "turn-started local-turn-2",
            "turn-ended local-turn-2 Failed(Other) []"
        ]
    );

    // The bridge still holds that input, and its refusal is reported as such.
    let refused = submit(&mut peer, &runtime, start_turn("sub-4", "Fourth")).await;
    assert_eq!(
        refused,
        DispatchOutcome::Rejected {
            reason: "turn_active: a turn is active".to_owned()
        }
    );
}

#[tokio::test(start_paused = true)]
async fn a_session_that_ends_on_its_own_is_a_loss_and_unread_input_was_not_sent() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("session_loss"));

    let outcome = submit(&mut peer, &runtime, start_turn("sub-1", "Deploy it")).await;

    // The bridge said the SDK never took the input.
    assert_eq!(outcome, DispatchOutcome::NotSent(Refusal::RuntimeClosed));
    let lost = drain(&mut events).await;
    let [
        EventKind::RuntimeLost {
            exit_code: None,
            diagnostics,
        },
    ] = lost.as_slice()
    else {
        panic!("only the loss, got {lost:?}");
    };
    assert!(diagnostics.contains("Claude Code process exited with code 1"));
    // The bridge is released, and nothing follows the loss.
    assert!(peer.stdin_closed().await);
    peer.exit(0);
    assert_eq!(events.recv().await, None);
    assert_eq!(
        runtime.close().await,
        CloseOutcome::Confirmed { exit_code: Some(0) }
    );
}

#[tokio::test(start_paused = true)]
/// Unmapped SDK frames (L5: status, hook lifecycle) are routine and not reported;
/// unknown bridge events and requests still are.
async fn unknown_traffic_is_reported_declined_and_never_ends_a_turn() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("unknown_frames"));

    submit(&mut peer, &runtime, start_turn("sub-1", "Go")).await;

    assert_eq!(
        seen(&mut events).await,
        [
            "turn-started local-turn-1",
            &processing("sub-1", "local-turn-1"),
            "unknown malformed",
            "unknown malformed",
            "unknown from_the_future",
            "unknown delta",
            "unknown command_rejected",
            "unknown server_tool_use",
            "unknown tool_result",
            // A question that cannot be shown is declined, as the transcript checks.
            "unknown question_request",
        ]
    );

    peer.play().await;
    assert_eq!(
        seen(&mut events).await,
        [
            "session sess-1",
            "turn-ended local-turn-1 Completed [\"sub-1\"]"
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn structured_failures_end_the_turn_and_thrown_ones_do_not() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("failures"));

    submit(&mut peer, &runtime, start_turn("sub-1", "Go")).await;
    let failed = drain(&mut events).await;
    let Some(EventKind::TurnEnded {
        outcome: crate::TurnOutcome::Failed(problem),
        ..
    }) = failed.last()
    else {
        panic!("a failed turn, got {failed:?}");
    };
    assert_eq!(problem.kind, ProblemKind::QuotaExhausted);
    assert_eq!(problem.message, "Rate limited");
    // The reset time Claude Code reported before failing travels with the problem,
    // and the report itself is not shown as traffic ticketd does not understand.
    assert_eq!(problem.resets_at, Some(1_730_948_100));
    let unknown = |event: &EventKind| matches!(event, EventKind::Unknown { .. });
    assert!(!failed.iter().any(unknown), "{failed:?}");

    submit(&mut peer, &runtime, start_turn("sub-2", "Again")).await;
    drain(&mut events).await;
    let interrupting = runtime.interrupt(interrupt("local-turn-2"));
    let (interrupted, ()) = tokio::join!(interrupting, peer.play());

    // The interrupt call threw: unconfirmed, and the turn is still running.
    assert_eq!(interrupted, InterruptOutcome::Unconfirmed);
    assert_eq!(seen(&mut events).await, [] as [&str; 0]);

    peer.play().await;
    assert_eq!(
        seen(&mut events).await,
        [
            "notice Warning local-turn-2 \"Claude Code reported a failure: late failure\"",
            "turn-evidence local-turn-2 interrupt-written",
            "turn-ended local-turn-2 Completed [\"sub-2\"]",
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn closing_ends_the_bridge_and_is_not_a_loss() {
    let (mut peer, runtime, mut events) = open().await;

    let (closed, ()) = tokio::join!(runtime.close(), async {
        assert!(peer.stdin_closed().await);
        let ended = json!({"v": 1, "event": "session_ended", "generation": 7,
            "reason": "closed", "error": null, "unresolved_inputs": []});
        peer.send(&format!("{ended}\n")).await;
        sleep(Duration::from_millis(1)).await;
        peer.exit(0);
    });

    assert_eq!(closed, CloseOutcome::Confirmed { exit_code: Some(0) });
    assert_eq!(events.recv().await, None);
    let after = runtime.submit(start_turn("sub-1", "Hello")).await;
    assert_eq!(after, DispatchOutcome::NotSent(Refusal::RuntimeClosed));
}

#[tokio::test(start_paused = true)]
async fn an_older_claude_code_or_another_protocol_opens_no_session() {
    let (mut peer, opened) = open_with(fixture!("open_incompatible"), SessionStart::New).await;
    let problem = opened.expect_err("an older Claude Code is refused");
    assert_eq!(problem.kind, ProblemKind::IncompatibleVersion);
    assert!(problem.message.contains("Claude Code 2.1.322 or newer"));
    // No `open` was written, and the bridge was released.
    assert!(peer.stdin_closed().await);

    let (_peer, opened) = open_with(fixture!("open_wrong_protocol"), SessionStart::New).await;
    let problem = opened.expect_err("another protocol is refused");
    assert_eq!(problem.kind, ProblemKind::Other);
    assert!(problem.message.contains("unsupported_protocol"));
}

#[tokio::test(start_paused = true)]
async fn resuming_a_missing_session_reports_unavailable_history() {
    let resume = SessionStart::Resume(NativeSessionId::new("sess-9"));

    let (_peer, opened) = open_with(fixture!("resume_missing"), resume).await;

    let problem = opened.expect_err("the session is gone");
    assert_eq!(problem.kind, ProblemKind::NativeHistoryUnavailable);
    assert!(problem.message.contains("No conversation found"));
}

#[tokio::test(start_paused = true)]
async fn the_options_probe_lists_models_with_their_efforts_and_closes_the_bridge() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("options"));

    let probing = probe_options(io, Path::new(CLAUDE), Options::default());
    let (options, ()) = tokio::join!(probing, async {
        peer.play().await;
        assert!(peer.stdin_closed().await);
        peer.exit(0);
    });

    let options = options.expect("Claude Code listed its models");
    let models: Vec<_> = options
        .models
        .iter()
        .map(|choice| {
            let efforts: Vec<_> = choice.efforts.iter().map(|e| e.id.as_str()).collect();
            (choice.model.id.as_str(), choice.model.is_default, efforts)
        })
        .collect();
    assert_eq!(
        models,
        [
            ("default", true, vec!["low", "medium", "high", "max"]),
            ("sonnet", false, vec![]),
        ]
    );
    // The default row names what it runs; a row of its own name names nothing.
    assert_eq!(options.models[0].runs_as.as_deref(), Some("Opus 5.5"));
    assert_eq!(options.models[1].runs_as, None);
    // Before a session Claude Code's own mode is unknown, and full access is no choice.
    let permission = options.permission.expect("Claude Code's modes");
    assert_eq!(permission.current, None);
    assert!(
        permission
            .options
            .iter()
            .all(|o| o.permission != Some(crate::PermissionKind::FullAccess))
    );
}

#[tokio::test(start_paused = true)]
async fn a_new_session_opens_with_new_chats_picks() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("start_settings"));
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::New,
        unattended: None,
        ticketd_cli: None,
        taken_over: false,
        recorded_settings: None,
        settings: StartSettings {
            model: Some("sonnet".to_owned()),
            effort: Some("high".to_owned()),
            permission: Some("acceptEdits".to_owned()),
        },
    };
    let opening = open_over(io, &request, Path::new(CLAUDE), Options::default());
    let (opened, ()) = tokio::join!(opening, peer.play());

    assert!(opened.is_ok(), "the session opens");
}

/// #387 M1, D11: a Chat taken over from a run resumes the agent's session with what
/// an untouched New Chat sends ("Ask before edits" on Claude Code's default model),
/// never the agent's "don't ask" nor whatever Claude Code's own `defaultMode` says.
#[tokio::test(start_paused = true)]
async fn a_chat_taken_over_from_a_run_resumes_with_new_chats_defaults() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("takeover_resume"));
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::Resume(NativeSessionId::new("sess-9")),
        unattended: None,
        ticketd_cli: None,
        taken_over: true,
        recorded_settings: None,
        settings: StartSettings::default(),
    };
    let opening = open_over(io, &request, Path::new(CLAUDE), Options::default());
    let (opened, ()) = tokio::join!(opening, peer.play());

    assert!(opened.is_ok(), "the session opens");
}

/// #387 5A1: the same when the run never got a session, so the Chat opens a fresh one.
#[tokio::test(start_paused = true)]
async fn a_chat_taken_over_before_its_session_exists_opens_with_new_chats_defaults() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("takeover_fresh"));
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::New,
        unattended: None,
        ticketd_cli: None,
        taken_over: true,
        recorded_settings: None,
        settings: StartSettings::default(),
    };
    let opening = open_over(io, &request, Path::new(CLAUDE), Options::default());
    let (opened, ()) = tokio::join!(opening, peer.play());

    assert!(opened.is_ok(), "the session opens");
}

/// #408: Claude Code resumes a session's history but not its model or permission
/// mode. A person's Chat resumed after a restart opens with what it last reported in
/// effect, not with Claude Code's own `defaultMode`.
#[tokio::test(start_paused = true)]
async fn a_resumed_chat_opens_with_the_settings_it_last_ran_with() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("resume_recorded"));
    let recorded = json!({
        "claude_code_version": "2.1.322",
        "cwd": "/work/chat-1",
        "model": "claude-opus-test",
        "permission_mode": "plan",
        "reopen_with": {"permission_mode": "plan"},
    });
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::Resume(NativeSessionId::new("sess-9")),
        unattended: None,
        ticketd_cli: None,
        taken_over: false,
        recorded_settings: Some(recorded.to_string()),
        settings: StartSettings::default(),
    };
    let opening = open_over(io, &request, Path::new(CLAUDE), Options::default());
    let (opened, ()) = tokio::join!(opening, peer.play());

    assert!(opened.is_ok(), "the session opens");
}

/// #408: an earlier ticketd recorded only a session's first report, so its record can
/// name a mode the person has left since, such as Accept edits after they chose Ask
/// before edits. Its mode is not reopened with: the Chat asks before edits.
#[tokio::test(start_paused = true)]
async fn a_record_from_an_earlier_ticketd_reopens_asking_before_edits() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("resume_unrecorded"));
    let earlier = json!({
        "claude_code_version": "2.1.322",
        "cwd": "/work/chat-1",
        "model": "claude-opus-test",
        "permission_mode": "acceptEdits",
    });
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::Resume(NativeSessionId::new("sess-9")),
        unattended: None,
        ticketd_cli: None,
        taken_over: false,
        recorded_settings: Some(earlier.to_string()),
        settings: StartSettings::default(),
    };
    let opening = open_over(io, &request, Path::new(CLAUDE), Options::default());
    let (opened, ()) = tokio::join!(opening, peer.play());

    assert!(opened.is_ok(), "the session opens");
}

/// #408: what the Chat runs with is recorded each time it changes, so the record a
/// resumed session opens with is the latest, including a change the person made.
#[test]
fn the_settings_in_effect_are_recorded_each_time_they_change() {
    use super::session::Session;
    fn recorded(events: Vec<EventKind>) -> Vec<String> {
        events
            .into_iter()
            .filter_map(|event| match event {
                EventKind::Notice {
                    kind: crate::NoticeKind::EffectiveSettings,
                    detail,
                    ..
                } => detail.map(|detail| detail.payload().to_owned()),
                _ => None,
            })
            .collect()
    }
    let mut session = Session::default();
    let info = |mode: &str| {
        json!({"v": 1, "event": "session_info", "generation": 7, "session_id": "sess-1",
               "model": "claude-opus-test", "permission_mode": mode})
    };
    let mut said = |event: Value| recorded(session.event("session_info", &event).expect("known").0);

    assert_eq!(said(info("auto")).len(), 1, "the first report is recorded");
    assert!(said(info("auto")).is_empty(), "an unchanged report is not");
    let changed = said(info("acceptEdits"));
    assert!(
        changed[0].contains(r#""permission_mode":"acceptEdits""#),
        "{changed:?}"
    );

    let applied = recorded(
        session
            .setting_applied(crate::SettingKey::Permission, "default")
            .into_iter()
            .collect(),
    );
    assert!(
        applied[0].contains(r#""permission_mode":"default""#),
        "{applied:?}"
    );
    assert!(
        applied[0].contains(r#""model":"claude-opus-test""#),
        "{applied:?}"
    );
    assert!(
        applied[0].contains(r#""reopen_with":{"permission_mode":"default"}"#),
        "the mode a reopened session asks with is the one applied: {applied:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn inspection_judges_the_pairing_without_opening_a_session() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("inspect"));

    let probing = probe(io, Path::new(CLAUDE), Options::default());
    let ((inspection, offered), ()) = tokio::join!(probing, async {
        peer.play().await;
        assert!(peer.stdin_closed().await);
        peer.exit(0);
    });

    let Inspection::Installed {
        executable,
        version,
        login,
        capabilities,
    } = inspection
    else {
        panic!("installed, got {inspection:?}");
    };
    assert_eq!(executable, PathBuf::from(CLAUDE));
    assert_eq!(version.as_deref(), Some("2.1.322"));
    // Sign-in is what Claude Code says of its account; steering is unvalidated.
    assert_eq!(login, LoginState::SignedIn);
    assert!(
        offered.is_some_and(|listed| listed.is_ok()),
        "the check lists its options too"
    );
    assert!(matches!(capabilities.steering, Capability::Unknown { .. }));
    assert!(capabilities.native_resume.behavior().is_some());
}

#[test]
fn sign_in_is_read_from_how_claude_code_describes_its_account() {
    use super::runtime::account_login;
    let login = |account: Value| account_login(&account);
    assert_eq!(
        login(json!({"subscription_type": "pro"})),
        LoginState::SignedIn
    );
    assert_eq!(
        login(json!({"api_key_source": "ANTHROPIC_API_KEY"})),
        LoginState::NonSubscription
    );
    assert_eq!(
        login(json!({"api_provider": "bedrock"})),
        LoginState::NonSubscription
    );
    assert_eq!(login(Value::Null), LoginState::Unknown);
}

#[test]
fn a_failed_probe_is_not_a_verdict_and_an_older_version_is() {
    let inspection = |version: Value, error: Value| {
        json!({"claude_version": version, "sdk_version": "0.3.322",
            "sdk_claude_code_version": "2.1.322", "error": error})
    };
    let judge = |version, error| verdict(Path::new(CLAUDE), &inspection(version, error));

    assert!(matches!(
        judge(json!("2.1.321"), Value::Null),
        Inspection::Incompatible { .. }
    ));
    assert!(matches!(
        judge(json!("2.2.0"), Value::Null),
        Inspection::Installed { .. }
    ));
    assert_eq!(
        judge(Value::Null, json!("spawn ENOENT")),
        Inspection::ProbeFailed {
            reason: "spawn ENOENT".to_owned()
        }
    );
}

#[test]
fn path_wins_over_the_installer_folders_and_shims_are_not_selected() {
    let environment = LaunchEnvironment {
        path: Some(OsString::from("/launcher/bin")),
        home: Some(PathBuf::from("/home/sam")),
        ..LaunchEnvironment::default()
    };
    let native = PathBuf::from("/home/sam/.local/bin/claude");
    let on_path = PathBuf::from("/launcher/bin/claude");

    let from_known = locate(Os::Linux, &environment, |path| path == native);
    let from_path = locate(Os::Linux, &environment, |path| {
        path == native || path == on_path
    });
    let windows = candidates(
        Os::Windows,
        &LaunchEnvironment {
            home: Some(PathBuf::from("H")),
            ..LaunchEnvironment::default()
        },
    );

    assert_eq!(from_known, Some(native.clone()));
    assert_eq!(from_path, Some(on_path.clone()));
    assert_eq!(
        windows,
        vec![
            PathBuf::from("H/.local/bin/claude.exe"),
            PathBuf::from("H/.claude/local/claude.exe"),
        ]
    );
}

/// Runs the compiled bridge when `npm run build:bridge` has produced it. Only
/// `hello` is sent: no session is opened and Claude Code is never started.
#[tokio::test]
async fn the_built_bridge_answers_hello() {
    let triple = if cfg!(all(windows, target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc.exe"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else {
        return;
    };
    let bridge = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/chat-bridge-claude/dist")
        .join(format!("{BRIDGE_SIDECAR_NAME}-{triple}"));
    if !bridge.is_file() {
        eprintln!("skipped: {} has not been built", bridge.display());
        return;
    }
    let mut io = spawn(&bridge, &[], crate::stdio::Serving::Nothing).expect("the bridge starts");
    let hello = b"{\"id\":\"t1\",\"cmd\":\"hello\",\"protocol\":1}\n";
    io.stdin.write_all(hello).await.expect("stdin");
    io.stdin.flush().await.expect("stdin");

    let mut stdout = BufReader::new(io.stdout);
    let line = timeout(Duration::from_secs(30), read_line(&mut stdout, 64 * 1024))
        .await
        .expect("the bridge answers")
        .expect("stdout");

    let Some(Line::Complete(line)) = line else {
        panic!("one event, got {line:?}");
    };
    let event: Value = serde_json::from_slice(&line).expect("an event");
    assert_eq!(event["event"], "hello");
    assert_eq!(event["id"], "t1");
    assert_eq!(event["protocol"], 1);
    assert!(event["sdk_claude_code_version"].is_string());
    // Closing its input makes the bridge exit.
    drop(io.stdin);
    assert_eq!(io.child.wait().await, Some(0));
}

#[test]
fn a_shortened_tool_result_says_its_start_is_missing() {
    use super::session::tool_output;
    assert_eq!(tool_output("all of it", false), "all of it");
    assert_eq!(
        tool_output("the end", true),
        "[earlier output truncated]\nthe end"
    );
}

#[tokio::test(start_paused = true)]
async fn closing_kills_a_process_that_stopped_reading_its_input_within_the_bound() {
    let (peer, runtime, _events) = open().await;
    // More than the pipe holds, and nothing reads it: the write cannot finish.
    let stuck = start_turn("sub-1", &"x".repeat(256 * 1024));
    let writing = tokio::spawn({
        let runtime = Arc::clone(&runtime);
        async move { runtime.submit(stuck).await }
    });
    sleep(Duration::from_millis(1)).await;

    let started = tokio::time::Instant::now();
    let closed = runtime.close().await;

    assert!(matches!(closed, CloseOutcome::Unconfirmed { .. }));
    assert_eq!(started.elapsed(), crate::ADAPTER_CLOSE_TIMEOUT);
    assert!(crate::ADAPTER_CLOSE_TIMEOUT < crate::CLOSE_TIMEOUT);
    assert_eq!(*peer.exit.borrow(), Some(None), "the process was killed");
    // The write is bounded too, so the submission is settled instead of hanging.
    let outcome = timeout(crate::WRITE_TIMEOUT, writing).await;
    let outcome = outcome.expect("the write gives up").expect("the task ends");
    assert_eq!(outcome, DispatchOutcome::UnknownAfterLoss);
}

/// An agent that may read files and run `npm test`, on a named model.
fn reader_that_tests() -> crate::Unattended {
    crate::Unattended {
        run_id: "run-1".into(),
        model: Some("claude-test".into()),
        tools: ticketd_core::AutomationAgentTools {
            read_files: true,
            edit_files: false,
            run_commands: true,
            any_command: false,
            allowed_commands: vec!["npm test".into()],
            use_web: false,
        },
        turn_limit: 40,
    }
}

/// The ticketd CLI by its name, in both shells: the rules every agent has.
const CLI_RULES: [&str; 4] = [
    "Bash(ticketd *)",
    "PowerShell(ticketd *)",
    "Bash(ticketd.exe *)",
    "PowerShell(ticketd.exe *)",
];

#[test]
fn an_agent_with_every_switch_off_may_still_run_the_ticketd_cli_and_nothing_else() {
    let mut unattended = reader_that_tests();
    unattended.model = None;
    unattended.tools = ticketd_core::AutomationAgentTools {
        read_files: false,
        edit_files: false,
        run_commands: false,
        any_command: true,
        allowed_commands: vec!["npm test".into()],
        use_web: false,
    };

    assert_eq!(
        super::unattended_options(&unattended),
        json!({
            "allowed_tools": CLI_RULES,
            "disallowed_tools": [
                "Read", "Glob", "Grep", "LSP", "Edit", "Write", "NotebookEdit", "WebFetch",
                "WebSearch"
            ],
            "max_turns": 40,
        })
    );

    // Running commands allows any command only when the agent says so outright.
    unattended.tools.run_commands = true;
    let options = super::unattended_options(&unattended);
    let mut any = CLI_RULES.to_vec();
    any.extend(["Bash", "PowerShell"]);
    assert_eq!(options["allowed_tools"], json!(any));

    // An empty list is not "any command": it allows none but the ticketd CLI.
    unattended.tools.any_command = false;
    unattended.tools.allowed_commands.clear();
    let options = super::unattended_options(&unattended);
    assert_eq!(options["allowed_tools"], json!(CLI_RULES));
}

/// #387 M12, D15: Claude Code's `Edit` refuses a file it has not read, so "Edit
/// files" also leaves `Read` on (not `Glob` or `Grep`), even with "Read files" off.
/// 3B1: edits are allowed only below the step's folder, Claude Code's working
/// directory, by the one rule that covers Edit, Write and NotebookEdit there.
#[test]
fn an_agent_that_edits_files_may_read_the_files_it_changes() {
    let mut unattended = reader_that_tests();
    unattended.tools.read_files = false;
    unattended.tools.edit_files = true;
    let options = super::unattended_options(&unattended);

    let mut expected = vec!["Edit(./**)"];
    expected.extend(CLI_RULES);
    expected.extend(["Bash(npm test *)", "PowerShell(npm test *)"]);
    assert_eq!(options["allowed_tools"], json!(expected));
    assert_eq!(
        options["disallowed_tools"],
        json!(["Glob", "Grep", "LSP", "WebFetch", "WebSearch"])
    );
}

/// #387 3B1: no switch allows a file tool by its bare name, which Claude Code reads
/// as "on any path". Reading needs no rule in the step's folder (and is refused
/// outside it); editing is allowed below the folder only.
#[test]
fn no_switch_allows_a_file_tool_outside_the_steps_folder() {
    for (read_files, edit_files) in [(true, false), (false, true), (true, true)] {
        let mut unattended = reader_that_tests();
        unattended.tools.read_files = read_files;
        unattended.tools.edit_files = edit_files;
        let options = super::unattended_options(&unattended);
        let file_rules: Vec<_> = options["allowed_tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|rule| rule.as_str())
            .filter(|rule| !rule.starts_with("Bash(") && !rule.starts_with("PowerShell("))
            .collect();
        let expected: &[&str] = if edit_files { &["Edit(./**)"] } else { &[] };
        assert_eq!(file_rules, expected, "read {read_files}, edit {edit_files}");
    }
}

/// #387 M19: a denied command's control characters (here a backspace, as `\b` in a
/// Windows path written into JSON becomes) never reach the run's reason.
#[test]
fn a_denied_commands_control_characters_are_not_printed() {
    let denied = super::session::denials(&json!({"denials": [
        {"tool_name": "PowerShell", "command": "& \"C:\\x\u{8}in\\ticketd.exe\" add-tag\u{7}"}
    ]}));
    assert_eq!(denied, ["PowerShell `& \"C:\\x in\\ticketd.exe\" add-tag`"]);
}

/// #387 3B1: a file tool refused outside the step's folder is named with its path,
/// so the run's reason says what the agent tried to reach.
#[test]
fn a_denied_file_tool_is_named_with_its_path() {
    let denied = super::session::denials(&json!({"denials": [
        {"tool_name": "Write", "command": null, "path": "C:\\outside\\w.txt"},
        {"tool_name": "Read", "command": null, "path": "C:\\Users\\me\\notes.txt"},
        {"tool_name": "WebSearch", "command": null, "path": null},
    ]}));
    assert_eq!(
        denied,
        [
            "Write `C:\\outside\\w.txt`",
            "Read `C:\\Users\\me\\notes.txt`",
            "WebSearch"
        ]
    );
}

/// L1: a list of commands allows exactly those, in both shells, besides the CLI.
/// No rule names the CLI's path: the agent runs it by name from its `PATH`.
#[test]
fn an_agent_with_a_command_list_may_run_those_and_the_ticketd_cli_by_name() {
    let mut unattended = reader_that_tests();
    unattended.tools.read_files = false;
    let mut expected = CLI_RULES.to_vec();
    expected.extend(["Bash(npm test *)", "PowerShell(npm test *)"]);
    assert_eq!(
        super::unattended_options(&unattended)["allowed_tools"],
        json!(expected)
    );
}

/// The open command carries the agent's model, tools and turn limit (the fixture
/// checks the frame), and the two endings only an unattended session has are told
/// apart: the turn limit, and a tool Claude Code denied.
#[tokio::test(start_paused = true)]
async fn an_unattended_session_opens_with_the_agents_settings_and_reports_limit_and_denial() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("unattended"));
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::New,
        unattended: Some(reader_that_tests()),
        ticketd_cli: None,
        taken_over: false,
        recorded_settings: None,
        settings: StartSettings::default(),
    };
    let opening = open_over(io, &request, Path::new(CLAUDE), Options::default());
    let (opened, ()) = tokio::join!(opening, peer.play());
    let mut opened = opened.expect("the session opens");
    drain(&mut opened.events).await;

    let mut ended = async |peer: &mut Peer, id: &str| {
        submit(
            peer,
            &opened.runtime,
            start_turn(id, if id == "sub-1" { "Go" } else { "Again" }),
        )
        .await;
        match read_end(&drain(&mut opened.events).await) {
            Some(crate::TurnOutcome::Failed(problem)) => (problem.kind, problem.message),
            other => panic!("a failed turn, got {other:?}"),
        }
    };

    assert_eq!(
        ended(&mut peer, "sub-1").await.0,
        ProblemKind::TurnLimitReached
    );
    // The agent ended its turn itself, but without the tool it was denied. L6: each
    // distinct denial is named once, a shell's with its command on one line.
    assert_eq!(
        ended(&mut peer, "sub-2").await,
        (
            ProblemKind::ToolDenied,
            "Claude Code was denied: PowerShell `node test.js`; Write.".to_owned()
        )
    );
}
/// A tool the person declined comes back as an error result; it is told as declined,
/// and a later failure of another tool is still a failure.
#[test]
fn a_tool_the_person_declined_is_declined_not_failed() {
    use super::session::Session;
    use crate::ToolStatus;
    let mut session = Session::default();
    let tool_use = |id: &str| json!({"blocks": [{"type": "tool_use", "id": id, "name": "Bash", "input": {"command": "rm -rf node_modules"}}], "parent_tool_use_id": null});
    let result = |id: &str| json!({"tool_use_id": id, "is_error": true, "text": "denied"});
    let status = |events: Vec<EventKind>| match events.as_slice() {
        [EventKind::ToolUpdated { status, .. }] => *status,
        other => panic!("one tool update, got {other:?}"),
    };
    session.event("assistant_content", &tool_use("toolu_1"));
    let (asked, _) = session
        .event(
            "permission_request",
            &json!({"request_id": "req-1", "tool_name": "Bash", "tool_use_id": "toolu_1", "input": {"command": "rm -rf node_modules"}}),
        )
        .expect("modeled");
    // The request names the tool use it is about, so its decision folds into that step.
    assert!(asked.iter().any(|event| matches!(
        event,
        EventKind::InteractionRequested(request) if request.item == Some(crate::NativeItemId::new("toolu_1"))
    )));
    let deny = InteractionAnswer::Approval(ApprovalDecision::Deny);
    session
        .answer(&NativeRequestId::new("req-1"), &deny)
        .expect("the request is live");
    let (events, _) = session
        .event("tool_result", &result("toolu_1"))
        .expect("modeled");
    assert_eq!(status(events), ToolStatus::Declined);

    session.event("assistant_content", &tool_use("toolu_2"));
    let (events, _) = session
        .event("tool_result", &result("toolu_2"))
        .expect("modeled");
    assert_eq!(status(events), ToolStatus::Failed);
}

/// #387 3B3: Claude Code answers the tool a Stop cuts off with an error result ("The
/// user doesn't want to proceed with this tool use", seen in live transcripts). It
/// is left unfinished, which the turn then shows as "not finished", not failed.
#[test]
fn a_tool_that_failed_after_a_stop_is_reported_as_such() {
    use super::session::Session;
    use crate::ToolStatus;
    let mut session = Session::default();
    session.event("assistant_content", &json!({"blocks": [{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ticketd list"}}], "parent_tool_use_id": null}));
    session.interrupt_written();
    let (events, _) = session
        .event(
            "tool_result",
            &json!({"tool_use_id": "toolu_1", "is_error": true, "text": "The user doesn't want to proceed with this tool use."}),
        )
        .expect("modeled");

    assert!(
        events.iter().any(|event| matches!(
            event,
            EventKind::ToolUpdated {
                status: ToolStatus::FailedAfterInterrupt,
                ..
            }
        )),
        "{events:?}"
    );
}

/// The lines an edit added and removed, from its result, stay with the tool so its
/// step row can show them.
#[test]
fn an_edit_keeps_the_lines_its_result_counted() {
    use super::session::Session;
    let mut session = Session::default();
    session.event("assistant_content", &json!({"blocks": [{"type": "tool_use", "id": "toolu_1", "name": "Edit", "input": {"file_path": "/w/a.ts"}}], "parent_tool_use_id": null}));
    let (events, _) = session
        .event(
            "tool_result",
            &json!({"tool_use_id": "toolu_1", "text": "ok", "outcome": {"kind": "file", "change": "update", "added_lines": 48, "removed_lines": 6}}),
        )
        .expect("modeled");
    let kept = events.iter().find_map(|event| match event {
        EventKind::ToolUpdated {
            detail: Some(detail),
            ..
        } => serde_json::from_str::<serde_json::Value>(detail.payload()).ok(),
        _ => None,
    });
    assert_eq!(
        kept.map(|input| input["ticketd_lines"].clone()),
        Some(json!({"added": 48, "removed": 6}))
    );
}

#[tokio::test(start_paused = true)]
async fn thinking_the_plan_files_and_context_carry_only_what_claude_code_reported() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("reports"));
    submit(&mut peer, &runtime, start_turn("sub-1", "Add a limiter")).await;
    peer.play().await;

    let seen = seen(&mut events).await;
    let shown: Vec<&str> = seen
        .iter()
        .map(String::as_str)
        .filter(|event| !event.starts_with("notice") && !event.starts_with("session"))
        .collect();
    assert_eq!(
        shown,
        [
            "settings model=claude-opus-test[] permission=default[\"default\", \"acceptEdits\", \"plan\"]",
            "turn-started local-turn-1",
            &processing("sub-1", "local-turn-1"),
            "reasoning thinking-1 running Some(1730910000000) None None None",
            "reasoning thinking-1 done Some(1730910000000) Some(1730910012000) None None",
            "reasoning thinking-1 done Some(1730910000000) Some(1730910012000) Some(\"The handler has no limit.\") None",
            // Redacted thinking is timed and has no text.
            "reasoning thinking-2 running Some(1730910013000) None None None",
            "reasoning thinking-2 done Some(1730910013000) Some(1730910014000) None None",
            // The to-do list is the plan, never a step row.
            "plan [\"Completed Read the handler (Reading the handler)\", \"InProgress Add the limiter (Adding the limiter)\"] None",
            "tool toolu_edit \"Edit\" Running None",
            "files [\"Modified /work/chat-1/src/handler.ts unconfirmed\"]",
            "tool toolu_edit \"Edit\" Succeeded Some(\"edited\")",
            "files [\"Modified /work/chat-1/src/handler.ts +2 -1\"]",
            "tool toolu_write \"Write\" Running None",
            "files [\"Modified /work/chat-1/src/handler.ts +2 -1\", \"Modified /work/chat-1/src/limiter.ts unconfirmed\"]",
            "tool toolu_write \"Write\" Succeeded Some(\"created\")",
            "files [\"Modified /work/chat-1/src/handler.ts +2 -1\", \"Added /work/chat-1/src/limiter.ts +1 -0\"]",
            "tool toolu_bad \"Edit\" Running None",
            "files [\"Modified /work/chat-1/src/handler.ts +2 -1\", \"Added /work/chat-1/src/limiter.ts +1 -0\", \"Modified /work/chat-1/README.md unconfirmed\"]",
            "tool toolu_bad \"Edit\" Failed Some(\"String not found\")",
            // A failed edit changed nothing.
            "files [\"Modified /work/chat-1/src/handler.ts +2 -1\", \"Added /work/chat-1/src/limiter.ts +1 -0\"]",
            "compacted",
            "turn-ended local-turn-1 Completed [\"sub-1\"]",
            "context 124000 of 200000 [\"Messages 100000\"] Some(167000)",
        ]
    );

    let refused = tokio::join!(
        runtime.change_setting(crate::SettingChange {
            generation: GENERATION,
            setting: crate::SettingKey::Model,
            value: "sonnet".to_owned(),
        }),
        peer.play()
    )
    .0;
    assert_eq!(
        refused,
        crate::SettingOutcome::Refused {
            reason: "model not available".to_owned()
        }
    );
}

#[test]
fn the_slash_commands_claude_code_lists_reach_the_host() {
    use super::session::Session;
    let mut session = Session::default();
    let init = json!({"models": [], "commands": [
        {"name": "review", "description": "Review a pull request"},
        {"name": "compact", "description": null},
        {"name": "", "description": "nameless"},
    ]});
    let listed = session
        .initialized(&init)
        .into_iter()
        .find_map(|event| match event {
            EventKind::CommandsListed(commands) => Some(commands),
            _ => None,
        });
    assert_eq!(
        listed,
        Some(vec![
            crate::HarnessCommand {
                name: "review".to_owned(),
                description: Some("Review a pull request".to_owned()),
            },
            crate::HarnessCommand {
                name: "compact".to_owned(),
                description: None,
            },
        ])
    );
}

/// LIVE2-2: Claude Code's `session_info` may leave its effort out; the effort the
/// session was opened with stays the one shown until Claude Code says another.
#[test]
fn the_picked_effort_stays_until_claude_code_reports_another() {
    use super::session::Session;
    let mut session = Session::default();
    session.effort_in_effect(Some("medium".to_owned()));
    let models = json!({"models": [
        {"value": "default", "resolved_model": "claude-opus-test", "display_name": "Default", "description": "", "effort_levels": ["low", "medium", "high"]},
    ]});
    let _ = session.initialized(&models);
    let effort = |info: Value, session: &mut Session| {
        let (events, _) = session.event("session_info", &info).expect("modeled");
        let Some(EventKind::SettingsState(settings)) = events.last() else {
            panic!("settings, got {events:?}");
        };
        settings.effort.as_ref().and_then(|e| e.current.clone())
    };
    assert_eq!(
        effort(
            json!({"model": "claude-opus-test", "permission_mode": "default"}),
            &mut session
        )
        .as_deref(),
        Some("medium")
    );
    assert_eq!(
        effort(
            json!({"model": "claude-opus-test", "permission_mode": "plan", "effort": "high"}),
            &mut session
        )
        .as_deref(),
        Some("high")
    );
}

#[test]
fn settings_offer_the_sdk_models_and_never_offer_skipping_permissions() {
    use super::session::Session;
    let mut session = Session::default();
    let models = json!({"models": [
        {"value": "default", "resolved_model": "claude-opus-test", "display_name": "Default", "description": "Recommended", "effort_levels": ["low", "medium", "high"]},
        {"value": "haiku", "resolved_model": null, "display_name": "Haiku", "description": "", "effort_levels": []},
    ]});
    assert!(
        !session
            .initialized(&models)
            .iter()
            .any(|event| matches!(event, EventKind::SettingsState(_))),
        "nothing in effect yet"
    );
    let info = |mode: &str| json!({"model": "claude-opus-test", "permission_mode": mode, "effort": "medium"});
    let (events, _) = session
        .event("session_info", &info("default"))
        .expect("modeled");
    let Some(EventKind::SettingsState(settings)) = events.last() else {
        panic!("settings, got {events:?}");
    };
    // The model in effect is the option that resolves to it.
    assert_eq!(
        settings.model.as_ref().and_then(|m| m.current.as_deref()),
        Some("default")
    );
    let effort = settings.effort.as_ref().expect("the model takes effort");
    assert_eq!(effort.current.as_deref(), Some("medium"));
    let permission = settings.permission.as_ref().expect("permission");
    assert!(
        permission
            .options
            .iter()
            .all(|option| option.id != "bypassPermissions")
    );

    let (events, _) = session
        .event("session_info", &info("bypassPermissions"))
        .expect("modeled");
    let Some(EventKind::SettingsState(settings)) = events.last() else {
        panic!("settings, got {events:?}");
    };
    let permission = settings.permission.as_ref().expect("permission");
    assert_eq!(
        permission.unchangeable.as_deref(),
        Some("Set in Claude Code's settings")
    );
    assert_eq!(
        permission.refusal("acceptEdits").as_deref(),
        Some("Set in Claude Code's settings")
    );
}

/// #387 M15: modes ticketd does not offer are named in words, and a run's agent
/// reports its settings read-only, with why, instead of offering refused choices.
#[test]
fn a_runs_agent_reports_its_settings_read_only_and_named() {
    use super::session::Session;
    let label = |settings: &crate::HarnessSettings| {
        let permission = settings.permission.as_ref().expect("permission");
        let current = permission.current.clone().unwrap();
        let option = permission.options.iter().find(|o| o.id == current).unwrap();
        (option.label.clone(), permission.unchangeable.clone())
    };
    let settings_after = |session: &mut Session, mode: &str| {
        let info = json!({"model": "claude-haiku-test", "permission_mode": mode});
        let (events, _) = session.event("session_info", &info).expect("modeled");
        match events.last() {
            Some(EventKind::SettingsState(settings)) => settings.clone(),
            other => panic!("settings, got {other:?}"),
        }
    };

    let mut agent = Session::default();
    agent.mark_unattended();
    let settings = settings_after(&mut agent, "dontAsk");
    let locked = Some(
        "An Automation is running this Chat. Reply or stop it to take it over first.".to_owned(),
    );
    assert_eq!(label(&settings), ("Never asks".to_owned(), locked.clone()));
    assert_eq!(settings.model.as_ref().unwrap().unchangeable, locked);

    let mut chat = Session::default();
    let settings = settings_after(&mut chat, "auto");
    assert_eq!(label(&settings), ("Auto".to_owned(), None));
    assert_eq!(settings.model.as_ref().unwrap().unchangeable, None);
}

/// LIVE2-11: a question names the AskUserQuestion tool use it was asked from, so
/// that call's running row gives way to the question's card.
#[test]
fn a_question_names_the_tool_use_it_was_asked_from() {
    use super::session::Session;
    let mut session = Session::default();
    let asked = json!({
        "request_id": "q1",
        "tool_use_id": "toolu_ask",
        "questions": [{"question": "Which color?", "options": [{"label": "Blue"}]}],
    });
    let (events, _) = session.event("question_request", &asked).expect("modeled");
    let item = events.iter().find_map(|event| match event {
        EventKind::InteractionRequested(request) => Some(request.item.clone()),
        _ => None,
    });
    assert_eq!(item, Some(Some(crate::NativeItemId::new("toolu_ask"))));
}

/// The Claude bridge as the conformance suite's provider: it plays the bridge's side
/// of each scenario.
pub(crate) struct Bridge {
    peer: Peer,
    runtime: Arc<dyn HarnessRuntime>,
    events: EventStream,
    /// The id of the next command the adapter writes.
    next_command: u32,
}

pub(crate) async fn provider() -> Box<dyn Provider> {
    let (peer, runtime, events) = open().await;
    Box::new(Bridge {
        peer,
        runtime,
        events,
        next_command: 4,
    })
}

impl Bridge {
    fn command(&mut self) -> u32 {
        self.next_command += 1;
        self.next_command - 1
    }

    /// The `submit` command the adapter writes for `id`.
    fn submitted(&mut self, id: &str) -> String {
        let command = self.command();
        format!(
            r#"{{"client":{{"id":"c{command}","cmd":"submit","generation":7,"submission_id":"{id}","text":"hello"}}}}"#
        )
    }
}

#[async_trait]
impl Provider for Bridge {
    fn new_turn(&self) -> NewTurn {
        NewTurn::WrittenThenProcessing
    }

    fn loss(&self) -> (Option<i32>, &'static str) {
        (Some(1), "fatal: connection reset")
    }

    fn runtime(&self) -> Arc<dyn HarnessRuntime> {
        Arc::clone(&self.runtime)
    }

    fn events(&mut self) -> &mut EventStream {
        &mut self.events
    }

    async fn start_turn(&mut self, id: &str) -> DispatchOutcome {
        let client = self.submitted(id);
        let handed = format!(
            r#"{{"server":{{"v":1,"event":"input_handed_to_sdk","generation":7,"submission_id":"{id}"}}}}"#
        );
        self.peer.load(&format!("{client}\n{handed}\n"));
        submit(&mut self.peer, &self.runtime, start_turn(id, "hello")).await
    }

    async fn show_processing(&mut self, id: &str) -> NativeTurnId {
        self.peer.load(&format!(
            r#"{{"server":{{"v":1,"event":"input_processing","generation":7,"submission_ids":["{id}"]}}}}"#
        ));
        self.peer.play().await;
        let shown = drain(&mut self.events).await;
        shown
            .into_iter()
            .find_map(|event| match event {
                EventKind::SubmissionEvidence {
                    submission,
                    evidence: DeliveryEvidence::Processing { turn },
                } if submission == SubmissionId::new(id) => Some(turn),
                _ => None,
            })
            .expect("the bridge showed the input processing")
    }

    async fn submit_unanswered(&mut self, id: &str) -> DispatchOutcome {
        let client = self.submitted(id);
        self.peer.load(&client);
        submit(&mut self.peer, &self.runtime, start_turn(id, "hello")).await
    }

    async fn refuse_late(&mut self, _id: &str) {
        // The refusal answers the command that carried the input: the last one.
        let command = self.next_command - 1;
        self.peer.load(&format!(
            r#"{{"server":{{"v":1,"event":"command_rejected","id":"c{command}","code":"duplicate_submission","message":"submission is unresolved"}}}}"#
        ));
        self.peer.play().await;
    }

    async fn submit_and_lose_process(&mut self, id: &str) -> DispatchOutcome {
        let client = self.submitted(id);
        self.peer.load(&client);
        let (outcome, ()) = tokio::join!(self.runtime.submit(start_turn(id, "hello")), async {
            self.peer.play().await;
            let stderr = b"warning: noisy\nfatal: connection reset\n";
            self.peer.stderr.write_all(stderr).await.expect("stderr");
            sleep(Duration::from_millis(1)).await;
            self.peer.exit(1);
        });
        outcome
    }

    async fn request_approval(&mut self) -> NativeRequestId {
        self.peer.load(
            r#"{"server":{"v":1,"event":"permission_request","generation":7,"request_id":"7-1","tool_name":"Bash","tool_use_id":"toolu_1","input":{"command":"npm test"},"title":null,"display_name":"Bash","description":null,"decision_reason":null,"blocked_path":null,"agent_id":null,"default_to_no":false,"can_remember":true}}"#,
        );
        self.peer.play().await;
        drain(&mut self.events)
            .await
            .into_iter()
            .find_map(|event| match event {
                EventKind::InteractionRequested(request) => Some(request.request),
                _ => None,
            })
            .expect("the bridge asked for approval")
    }

    async fn respond(&mut self, response: InteractionResponse) -> RespondOutcome {
        let request = response.request.0.clone();
        let (outcome, frame) = tokio::join!(
            self.runtime.respond(response),
            timeout(Duration::from_millis(100), self.peer.written())
        );
        if outcome == RespondOutcome::Sent {
            let command = self.command();
            let expected = json!({"id": format!("c{command}"), "cmd": "respond", "generation": 7,
                "request_id": request, "decision": {"kind": "allow"}});
            assert_eq!(frame.expect("the answer was written"), expected);
        } else {
            assert!(frame.is_err(), "a refused answer wrote {frame:?}");
        }
        outcome
    }

    async fn assert_nothing_else_written(&mut self) {
        self.peer.assert_nothing_written().await;
    }
}

#[tokio::test(start_paused = true)]
async fn claude_code_s_version_is_asked_once_until_the_executable_changes() {
    let dir = tempfile::tempdir().unwrap();
    let claude = dir.path().join("claude");
    std::fs::write(&claude, "v1").unwrap();
    let path = claude.to_string_lossy().into_owned();
    let hello = json!({"client": {"id": "c1", "cmd": "hello", "protocol": 1}});
    let welcome = json!({"server": {"v": 1, "event": "hello", "id": "c1", "protocol": 1,
        "sdk_version": "0.3.322", "sdk_claude_code_version": "2.1.322"}});
    let inspect = |id: &str| {
        [
            json!({"client": {"id": id, "cmd": "inspect", "claude_executable": path}}),
            json!({"server": {"v": 1, "event": "inspection", "id": id, "claude_executable": path,
                "claude_version": "2.1.322", "sdk_version": "0.3.322",
                "sdk_claude_code_version": "2.1.322", "pairing": "matched", "error": null}}),
        ]
    };
    let open = |id: &str| {
        [
            json!({"client": {"id": id, "cmd": "open", "generation": 7, "cwd": "/work/chat-1",
                "claude_executable": path}}),
            json!({"server": {"v": 1, "event": "session_opened", "generation": 7, "id": id}}),
            json!({"server": {"v": 1, "event": "session_initialized", "generation": 7,
                "claude_code_version": "2.1.322"}}),
        ]
    };
    let lines = |frames: Vec<Value>| {
        frames
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    };
    let asked = lines(
        [
            vec![hello.clone(), welcome.clone()],
            inspect("c2").into(),
            open("c3").into(),
        ]
        .concat(),
    );
    let cached = lines([vec![hello, welcome], open("c2").into()].concat());
    let options = Options::default();
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::New,
        unattended: None,
        ticketd_cli: None,
        taken_over: false,
        recorded_settings: None,
        settings: StartSettings::default(),
    };
    let session = |fixture: String| {
        let options = options.clone();
        let (claude, request) = (claude.clone(), request.clone());
        async move {
            let (mut peer, io) = pipes();
            peer.load(&fixture);
            let (opened, ()) = tokio::join!(open_over(io, &request, &claude, options), peer.play());
            assert!(opened.is_ok(), "the session opens: {:?}", opened.err());
        }
    };

    session(asked.clone()).await;
    session(cached).await;
    // A replaced executable is asked again.
    std::fs::write(&claude, "version 2").unwrap();
    session(asked).await;
}
