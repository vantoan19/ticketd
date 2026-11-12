//! Drives the adapter through its contract interface against scripted app-server
//! traffic. Each fixture is a JSON-lines transcript: `client` frames the adapter must
//! write, `server` frames app-server sends, and `mark` lines where the test acts.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::time::{sleep, timeout};

use super::mapping::Session;
use super::runtime::{Options, login_state, open_over, probe_login};
use crate::scripted::{Peer, brief, pipes};
use crate::{
    ApprovalDecision, Capability, CloseOutcome, DispatchOutcome, EventKind, EventStream,
    HarnessRuntime, InteractionAnswer, InteractionResponse, InterruptOutcome, InterruptRequest,
    LoginState, NativeRequestId, NativeSessionId, NativeTurnId, NoticeKind, OpenRequest,
    OpenedRuntime, Problem, ProblemKind, QuestionAnswer, Refusal, RespondOutcome,
    RuntimeGeneration, SessionStart, Submission, SubmissionId, SubmissionKind, TurnOutcome,
};

const GENERATION: RuntimeGeneration = RuntimeGeneration(7);

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!("../../tests/fixtures/codex/", $name, ".jsonl"))
    };
}

fn options() -> Options {
    Options {
        client_version: "0.0.0-test".to_owned(),
        ..Options::default()
    }
}

async fn open_with(fixture: &str, session: SessionStart) -> (Peer, Result<OpenedRuntime, Problem>) {
    let (mut peer, io) = pipes();
    peer.load(fixture);
    let request = OpenRequest {
        generation: GENERATION,
        working_directory: PathBuf::from("/work/chat-1"),
        session,
    };
    let (opened, ()) = tokio::join!(open_over(io, &request, options()), peer.play());
    (peer, opened)
}

/// A new thread, with the handshake events already consumed.
async fn open() -> (Peer, Arc<dyn HarnessRuntime>, EventStream) {
    let (peer, opened) = open_with(fixture!("handshake"), SessionStart::New).await;
    let mut opened = opened.expect("the handshake succeeds");
    assert_eq!(
        seen(&mut opened.events).await,
        ["session thr_1", "notice EffectiveSettings"]
    );
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

fn steer(id: &str, expected_turn: &str, text: &str) -> Submission {
    Submission {
        kind: SubmissionKind::Steer {
            expected_turn: turn(expected_turn),
        },
        ..start_turn(id, text)
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

fn turn_mismatch<T: From<Refusal>>(active: &str) -> T {
    T::from(Refusal::TurnMismatch {
        active: Some(turn(active)),
    })
}

impl From<Refusal> for DispatchOutcome {
    fn from(refusal: Refusal) -> Self {
        Self::NotSent(refusal)
    }
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
async fn a_turn_keeps_provider_order_while_its_start_reply_is_outstanding() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("turn_ordering"));

    let outcome = submit(&mut peer, &runtime, start_turn("sub-1", "List the files")).await;

    // The reply arrived last; everything before it was already reported in order.
    assert_eq!(
        outcome,
        DispatchOutcome::Acknowledged {
            turn: turn("turn_1")
        }
    );
    assert_eq!(
        seen(&mut events).await,
        [
            "turn-started turn_1",
            "evidence sub-1 Processing { turn: NativeTurnId(\"turn_1\") }",
            "delta item_1 \"Looking\"",
            "tool item_2 \"ls\" Running None",
            "approval 0 \"ls\\nNeeds approval\" [Allow, AllowForSession, Deny]",
        ]
    );

    let (sent, ()) = tokio::join!(
        runtime.respond(approve("0", ApprovalDecision::Allow)),
        peer.play()
    );

    // Answering is not completion: the tool result and the turn end arrive separately.
    assert_eq!(sent, RespondOutcome::Sent);
    assert_eq!(
        seen(&mut events).await,
        [
            "resolved 0 Answered",
            "tool item_2 \"ls\" Running Some(\"README.md\\n\")",
            "tool item_2 \"ls\" Succeeded Some(\"README.md\\n\")",
            "message item_1 \"Looking. One file: README.md\"",
            "turn-ended turn_1 Completed [\"sub-1\"]",
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn a_late_reply_reconciles_as_evidence_and_nothing_is_resent() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("late_reply"));

    let outcome = submit(&mut peer, &runtime, start_turn("sub-1", "Hello")).await;

    assert_eq!(outcome, DispatchOutcome::Written);
    peer.play().await;
    assert_eq!(
        seen(&mut events).await,
        [
            "turn-started turn_1",
            "evidence sub-1 Acknowledged { turn: NativeTurnId(\"turn_1\") }",
            "unknown reply to an unknown request",
        ]
    );

    // The late reply made the turn known: a new turn is refused, interruption works.
    let second = runtime.submit(start_turn("sub-1b", "Hello again")).await;
    assert_eq!(second, turn_mismatch("turn_1"));
    let (interrupted, ()) = tokio::join!(runtime.interrupt(interrupt("turn_1")), peer.play());
    assert_eq!(interrupted, InterruptOutcome::Acknowledged);
    assert_eq!(
        seen(&mut events).await,
        ["turn-ended turn_1 Interrupted [\"sub-1\"]"]
    );

    // A refusal that arrives late is evidence too.
    let outcome = submit(&mut peer, &runtime, start_turn("sub-2", "Again")).await;
    assert_eq!(outcome, DispatchOutcome::Written);
    peer.play().await;
    assert_eq!(
        seen(&mut events).await,
        ["evidence sub-2 Rejected { reason: \"server is shutting down (code -32600)\" }"]
    );
    peer.assert_nothing_written().await;
}

#[tokio::test(start_paused = true)]
async fn unknown_traffic_is_reported_and_unknown_requests_are_never_approved() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("unknown_traffic"));

    peer.play().await;
    peer.send("this is not json\n").await;

    assert_eq!(
        seen(&mut events).await,
        [
            "unknown thread/futureThing/updated",
            "unknown item/tool/call",
            "unknown mcpServer/elicitation/request",
            "unknown future/approval/request",
            "unknown item/holoDeck",
            "unknown turn/completed",
            "unknown a line that is not JSON-RPC",
        ]
    );
    // The refused requests were answered by the adapter and are not live.
    let late = runtime
        .respond(approve("srv-7", ApprovalDecision::Allow))
        .await;
    assert_eq!(late, RespondOutcome::NotSent(Refusal::UnknownRequest));
    // Neither the unknown turn status nor another thread's turn became the active turn.
    let (outcome, ()) = tokio::join!(runtime.submit(start_turn("sub-1", "Hi")), async {
        let written = peer.written().await;
        assert_eq!(written["method"], "turn/start");
    });
    assert_eq!(outcome, DispatchOutcome::Written);
}

#[tokio::test(start_paused = true)]
async fn steering_checks_the_expected_turn_and_separates_refusal_from_acknowledgment() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("steer"));
    submit(&mut peer, &runtime, start_turn("sub-1", "Start")).await;

    let stale = runtime.submit(steer("sub-2", "turn_0", "Too late")).await;
    let second_turn = runtime.submit(start_turn("sub-2", "Another")).await;
    let wrong_interrupt = runtime.interrupt(interrupt("turn_0")).await;

    assert_eq!(stale, turn_mismatch("turn_1"));
    assert_eq!(second_turn, turn_mismatch("turn_1"));
    assert_eq!(
        wrong_interrupt,
        InterruptOutcome::NotSent(Refusal::TurnMismatch {
            active: Some(turn("turn_1"))
        })
    );

    // The harness refuses the first steer and acknowledges the second.
    let ((refused, accepted), ()) = tokio::join!(
        async {
            let refused = runtime.submit(steer("sub-3", "turn_1", "Also check tests"));
            let refused = refused.await;
            let accepted = runtime.submit(steer("sub-4", "turn_1", "Also check docs"));
            (refused, accepted.await)
        },
        peer.play()
    );

    assert_eq!(
        refused,
        DispatchOutcome::Rejected {
            reason: "expected turn turn_0 but the active turn is turn_1 (code -32600)".to_owned()
        }
    );
    assert_eq!(
        accepted,
        DispatchOutcome::Acknowledged {
            turn: turn("turn_1")
        }
    );
    assert_eq!(
        seen(&mut events).await,
        [
            "turn-started turn_1",
            "turn-ended turn_1 Completed [\"sub-1\", \"sub-4\"]"
        ]
    );
    peer.assert_nothing_written().await;
}

#[tokio::test(start_paused = true)]
async fn a_withdrawn_or_answered_request_refuses_later_answers() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("approval_cancellation"));
    submit(&mut peer, &runtime, start_turn("sub-1", "Change it")).await;
    assert_eq!(
        seen(&mut events).await,
        [
            "turn-started turn_1",
            "approval 20 \"Write outside the workspace\" [Allow, AllowForSession, Deny]",
            "resolved 20 Withdrawn",
            "question 21 q1 \"Which scope?\" [\"Small\", \"Large\"]",
            "approval 22 \"Fetch the changelog\" [Allow, AllowForSession, Deny]",
        ]
    );
    let small = InteractionAnswer::Answers(vec![QuestionAnswer {
        question_id: "q1".to_owned(),
        values: vec!["Small".to_owned()],
    }]);

    let withdrawn = runtime
        .respond(approve("20", ApprovalDecision::Allow))
        .await;
    let misfit = runtime
        .respond(approve("21", ApprovalDecision::Allow))
        .await;
    let (answered, ()) = tokio::join!(runtime.respond(answer("21", small.clone())), peer.play());
    let repeated = runtime.respond(answer("21", small)).await;

    assert_eq!(withdrawn, RespondOutcome::NotSent(Refusal::UnknownRequest));
    assert_eq!(misfit, RespondOutcome::NotSent(Refusal::Unsupported));
    assert_eq!(answered, RespondOutcome::Sent);
    assert_eq!(repeated, RespondOutcome::NotSent(Refusal::UnknownRequest));
    assert_eq!(seen(&mut events).await, ["resolved 21 Answered"]);

    // Interrupting ends the turn, which withdraws the approval still on screen.
    let (interrupted, ()) = tokio::join!(runtime.interrupt(interrupt("turn_1")), peer.play());
    let stale = runtime
        .respond(approve("22", ApprovalDecision::Allow))
        .await;

    assert_eq!(interrupted, InterruptOutcome::Acknowledged);
    assert_eq!(
        seen(&mut events).await,
        [
            "resolved 22 Withdrawn",
            "turn-ended turn_1 Interrupted [\"sub-1\"]"
        ]
    );
    assert_eq!(stale, RespondOutcome::NotSent(Refusal::UnknownRequest));
    peer.assert_nothing_written().await;
}

#[tokio::test(start_paused = true)]
async fn a_retrying_harness_keeps_the_turn_active_until_the_terminal_error() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("retry_then_failure"));
    submit(&mut peer, &runtime, start_turn("sub-1", "Go")).await;

    assert_eq!(
        seen(&mut events).await,
        [
            "turn-started turn_1",
            "notice Retrying turn_1 \"Reconnecting... 1/5\""
        ]
    );
    let retry = runtime.submit(start_turn("sub-2", "Go")).await;
    assert_eq!(retry, turn_mismatch("turn_1"));

    peer.play().await;

    let ended = drain(&mut events).await;
    assert_eq!(
        brief(&ended[0]),
        "turn-ended turn_1 Failed(QuotaExhausted) [\"sub-1\"]"
    );
    let [
        EventKind::TurnEnded {
            outcome: TurnOutcome::Failed(problem),
            ..
        },
    ] = ended.as_slice()
    else {
        panic!("one terminal event, got {ended:?}");
    };
    assert_eq!(problem.message, "You've hit your usage limit.");
    // The reset time from the rate-limit snapshot travels with the problem.
    assert_eq!(problem.resets_at, Some(1_730_948_100));
    let detail = problem.detail.as_ref().map(|detail| detail.payload());
    assert!(detail.is_some_and(|payload| payload.contains("\"resetsAt\":1730948100")));
    peer.assert_nothing_written().await;
}

#[test]
fn a_usage_limit_carries_a_reset_time_only_when_the_provider_gave_one() {
    let resets_at = |limits: Option<Value>| {
        let mut session = Session::default();
        if let Some(limits) = limits {
            session.notification("account/rateLimits/updated", &json!({"rateLimits": limits}));
        }
        let failed = json!({"threadId": "thr_1", "turn": {
            "id": "turn_1",
            "status": "failed",
            "error": {"message": "limit", "codexErrorInfo": "usageLimitExceeded"},
        }});
        match session.notification("turn/completed", &failed).as_slice() {
            [
                EventKind::TurnEnded {
                    outcome: TurnOutcome::Failed(problem),
                    ..
                },
            ] => problem.resets_at,
            other => panic!("one failed turn, got {other:?}"),
        }
    };
    let window = |used: u64, resets: Value| json!({"usedPercent": used, "resetsAt": resets});

    assert_eq!(resets_at(None), None);
    // The limit lifts when the last exhausted window resets; others say nothing of it.
    let both =
        json!({"primary": window(100, json!(1_000)), "secondary": window(100, json!(2_000))});
    assert_eq!(resets_at(Some(both)), Some(2_000));
    let one = json!({"primary": window(100, json!(1_000)), "secondary": window(40, json!(2_000))});
    assert_eq!(resets_at(Some(one)), Some(1_000));
    let none = json!({"primary": window(40, json!(1_000))});
    assert_eq!(resets_at(Some(none)), None);
    // Not a time: text, a negative number, a year past 9999.
    for bad in [json!("soon"), json!(-5), json!(9_999_999_999_999_999_i64)] {
        assert_eq!(resets_at(Some(json!({"primary": window(100, bad)}))), None);
    }
    // Milliseconds are read as the same moment in seconds.
    let millis = json!({"primary": window(100, json!(1_730_948_100_000_i64))});
    assert_eq!(resets_at(Some(millis)), Some(1_730_948_100));
}

#[test]
fn an_unavailable_model_or_mcp_server_is_reported_as_a_capability_not_a_warning() {
    let mut session = Session::default();
    let rerouted = session.notification("model/rerouted", &json!({"turnId": "turn_1"}));
    let failed = json!({"name": "github", "status": "failed", "error": "exited with 1"});
    let failed = session.notification("mcpServer/startupStatus/updated", &failed);
    let ready = json!({"name": "github", "status": "ready"});
    let ready = session.notification("mcpServer/startupStatus/updated", &ready);

    let kinds = |events: &[EventKind]| -> Vec<String> { events.iter().map(brief).collect() };
    assert_eq!(
        kinds(&rerouted),
        ["notice CapabilityUnavailable turn_1 \"Codex rerouted this turn to a different model\""]
    );
    let [
        EventKind::Notice {
            kind: NoticeKind::CapabilityUnavailable,
            message,
            ..
        },
    ] = failed.as_slice()
    else {
        panic!("one capability notice, got {failed:?}");
    };
    assert_eq!(
        message,
        "Codex could not start the MCP server github: exited with 1. Work that does not need it continues; the server is set up in Codex's own MCP settings."
    );
    assert!(ready.is_empty(), "{ready:?}");
}

#[test]
fn terminal_errors_keep_their_provider_meaning() {
    let kind_of = |info: Value| {
        let failed = json!({"threadId": "thr_1", "turn": {
            "id": "turn_1",
            "status": "failed",
            "error": {"message": "failed", "codexErrorInfo": info},
        }});
        match Session::default()
            .notification("turn/completed", &failed)
            .pop()
        {
            Some(EventKind::TurnEnded {
                outcome: TurnOutcome::Failed(problem),
                ..
            }) => problem.kind,
            other => panic!("expected a failed turn, got {other:?}"),
        }
    };

    assert_eq!(kind_of(json!("unauthorized")), ProblemKind::LoginRequired);
    assert_eq!(
        kind_of(json!("sandboxError")),
        ProblemKind::PermissionUnavailable
    );
    assert_eq!(
        kind_of(json!("usageLimitExceeded")),
        ProblemKind::QuotaExhausted
    );
    assert_eq!(kind_of(json!("contextWindowExceeded")), ProblemKind::Other);
    assert_eq!(
        kind_of(json!({"httpConnectionFailed": {"httpStatusCode": 503}})),
        ProblemKind::Other
    );
}

#[tokio::test(start_paused = true)]
async fn losing_the_process_after_a_write_leaves_the_submission_unknown() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("process_loss"));

    let (outcome, ()) = tokio::join!(runtime.submit(start_turn("sub-1", "Deploy it")), async {
        peer.play().await;
        let stderr = b"warning: noisy\nfatal: connection reset\n";
        peer.stderr.write_all(stderr).await.expect("stderr");
        sleep(Duration::from_millis(1)).await;
        peer.exit(1);
    });

    assert_eq!(outcome, DispatchOutcome::UnknownAfterLoss);
    let lost = drain(&mut events).await;
    let [
        EventKind::RuntimeLost {
            exit_code: Some(1),
            diagnostics,
        },
    ] = lost.as_slice()
    else {
        panic!("only the loss, got {lost:?}");
    };
    assert!(diagnostics.ends_with("fatal: connection reset"));
    assert_eq!(events.recv().await, None);

    let closed = Refusal::RuntimeClosed;
    let submitted = runtime.submit(start_turn("sub-1", "Deploy it")).await;
    let responded = runtime.respond(approve("0", ApprovalDecision::Allow)).await;
    let interrupted = runtime.interrupt(interrupt("turn_1")).await;
    assert_eq!(submitted, DispatchOutcome::NotSent(closed.clone()));
    assert_eq!(responded, RespondOutcome::NotSent(closed.clone()));
    assert_eq!(interrupted, InterruptOutcome::NotSent(closed));
}

#[tokio::test(start_paused = true)]
async fn commands_from_another_generation_write_nothing() {
    let (mut peer, runtime, _events) = open().await;
    let old = RuntimeGeneration(6);
    let stale = Refusal::StaleGeneration {
        current: GENERATION,
    };

    let submitted = runtime
        .submit(Submission {
            generation: old,
            ..start_turn("sub-1", "Hello")
        })
        .await;
    let responded = runtime
        .respond(InteractionResponse {
            generation: old,
            ..approve("0", ApprovalDecision::Allow)
        })
        .await;
    let interrupted = runtime
        .interrupt(InterruptRequest {
            generation: old,
            ..interrupt("turn_1")
        })
        .await;

    assert_eq!(submitted, DispatchOutcome::NotSent(stale.clone()));
    assert_eq!(responded, RespondOutcome::NotSent(stale.clone()));
    assert_eq!(interrupted, InterruptOutcome::NotSent(stale));
    peer.assert_nothing_written().await;
}

#[tokio::test(start_paused = true)]
async fn closing_ends_the_stream_without_reporting_a_loss() {
    let (mut peer, runtime, mut events) = open().await;

    let (closed, ()) = tokio::join!(runtime.close(), async {
        assert!(peer.stdin_closed().await);
        peer.exit(0);
    });

    assert_eq!(closed, CloseOutcome::Confirmed { exit_code: Some(0) });
    assert_eq!(events.recv().await, None);
    let after = runtime.submit(start_turn("sub-1", "Hello")).await;
    assert_eq!(after, DispatchOutcome::NotSent(Refusal::RuntimeClosed));
}

#[tokio::test(start_paused = true)]
async fn a_process_that_ignores_close_is_killed_and_reported_unconfirmed() {
    let (peer, runtime, _events) = open().await;

    let closed = runtime.close().await;

    assert!(matches!(closed, CloseOutcome::Unconfirmed { .. }));
    assert_eq!(*peer.exit.borrow(), Some(None));
}

#[tokio::test(start_paused = true)]
async fn resuming_reports_the_native_session_and_a_missing_one_as_unavailable_history() {
    let resume = |thread: &str| SessionStart::Resume(NativeSessionId::new(thread));

    let (_peer, opened) = open_with(fixture!("resume"), resume("thr_1")).await;
    let mut opened = opened.expect("the thread resumes");

    assert_eq!(
        seen(&mut opened.events).await,
        ["session thr_1", "notice EffectiveSettings"]
    );
    assert!(matches!(
        opened.capabilities.native_resume,
        Capability::Supported { .. }
    ));

    let (mut peer, missing) = open_with(fixture!("resume_missing"), resume("thr_gone")).await;

    let problem = missing.expect_err("the thread is gone");
    assert_eq!(problem.kind, ProblemKind::NativeHistoryUnavailable);
    assert!(problem.message.contains("thread not found: thr_gone"));
    // The failed open let go of the process and never started a fresh thread.
    assert!(peer.stdin_closed().await);
}

#[tokio::test(start_paused = true)]
async fn the_effective_settings_notice_carries_what_codex_reported() {
    let (_peer, opened) = open_with(fixture!("handshake"), SessionStart::New).await;
    let mut events = opened.expect("the handshake succeeds").events;

    let handshake = drain(&mut events).await;

    let Some(EventKind::Notice {
        kind: NoticeKind::EffectiveSettings,
        message,
        detail: Some(detail),
        ..
    }) = handshake.last()
    else {
        panic!("a settings notice, got {handshake:?}");
    };
    assert_eq!(
        message,
        "Model gpt-test, approval policy on-request, sandbox workspaceWrite"
    );
    assert!(
        detail
            .payload()
            .contains("\"instructionSources\":[\"/work/chat-1/AGENTS.md\"]")
    );
}

#[tokio::test(start_paused = true)]
async fn the_login_probe_reads_the_account_kind_and_closes_the_process() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("login"));

    let (login, ()) = tokio::join!(probe_login(io, options()), async {
        peer.play().await;
        assert!(peer.stdin_closed().await);
        peer.exit(0);
    });

    assert_eq!(login, LoginState::SignedIn);
    let api_key = json!({"account": {"type": "apiKey"}, "requiresOpenaiAuth": true});
    let signed_out = json!({"account": null, "requiresOpenaiAuth": true});
    let other_provider = json!({"account": null, "requiresOpenaiAuth": false});
    assert_eq!(login_state(&api_key), LoginState::NonSubscription);
    assert_eq!(login_state(&signed_out), LoginState::SignedOut);
    assert_eq!(login_state(&other_provider), LoginState::Unknown);
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

/// L5: one line per failed MCP server per session, saying where it is fixed; a reroute
/// names both models; routine goal notifications are not shown.
#[test]
fn a_failed_mcp_server_is_said_once_with_its_recovery_and_a_reroute_names_the_models() {
    let mut session = Session::default();
    let failed =
        json!({"threadId": null, "name": "grafana", "status": "failed", "error": "timed out"});
    let first = session.notification("mcpServer/startupStatus/updated", &failed);
    let again = json!({"threadId": "t1", "name": "grafana", "status": "failed", "error": "exited"});
    let again = session.notification("mcpServer/startupStatus/updated", &again);
    let other = json!({"name": "postman", "status": "failed", "error": "exited"});
    let other = session.notification("mcpServer/startupStatus/updated", &other);

    let messages = |events: &[EventKind]| -> Vec<String> {
        events
            .iter()
            .filter_map(|event| match event {
                EventKind::Notice { message, .. } => Some(message.clone()),
                _ => None,
            })
            .collect()
    };
    assert_eq!(
        messages(&first),
        [
            "Codex could not start the MCP server grafana: timed out. Work that does not need it continues; the server is set up in Codex's own MCP settings."
        ]
    );
    assert!(again.is_empty(), "{again:?}");
    assert_eq!(messages(&other).len(), 1);

    let rerouted = json!({"turnId": "turn_1", "fromModel": "gpt-5", "toModel": "gpt-5-mini", "reason": "highRiskCyberActivity"});
    let rerouted = session.notification("model/rerouted", &rerouted);
    assert_eq!(
        messages(&rerouted),
        ["Codex rerouted this turn from gpt-5 to gpt-5-mini."]
    );
    for routine in ["thread/goal/cleared", "thread/goal/updated"] {
        assert!(
            session.notification(routine, &json!({})).is_empty(),
            "{routine}"
        );
    }
}
