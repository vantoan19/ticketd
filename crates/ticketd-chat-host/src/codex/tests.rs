//! Drives the adapter through its contract interface against scripted app-server
//! traffic. Each fixture is a JSON-lines transcript: `client` frames the adapter must
//! write, `server` frames app-server sends, and `mark` lines where the test acts.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::time::{sleep, timeout};

use super::mapping::Session;
use super::runtime::{Options, login_state, open_over, probe_login, probe_options};
use crate::scripted::{Peer, brief, pipes};
use crate::{
    ApprovalDecision, Capability, CloseOutcome, DispatchOutcome, EventKind, EventStream,
    HarnessRuntime, InteractionAnswer, InteractionResponse, InterruptOutcome, InterruptRequest,
    LoginState, NativeRequestId, NativeSessionId, NativeTurnId, NoticeKind, OpenRequest,
    OpenedRuntime, Problem, ProblemKind, QuestionAnswer, Refusal, RespondOutcome,
    RuntimeGeneration, SessionStart, StartSettings, Submission, SubmissionId, SubmissionKind,
    TurnOutcome,
};

const GENERATION: RuntimeGeneration = RuntimeGeneration(7);
/// The settings the handshake fixture's `thread/start` reply reports.
const SETTINGS: &str =
    "settings model=gpt-test[] permission=workspaceWrite[\"workspaceWrite\"] fixed";

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!("../../tests/fixtures/codex/", $name, ".jsonl"))
    };
}

fn options() -> Options {
    Options {
        client_version: "0.0.0-test".to_owned(),
        // Only the settings fixture plays the list requests.
        list_settings: false,
        ..Options::default()
    }
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
        settings: StartSettings::default(),
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
        ["session thr_1", SETTINGS, "notice EffectiveSettings"]
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
            "approval 0 \"ls\" Some(\"Needs approval\") [Allow, AllowForSession, Deny]",
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
            "approval 20 \"Write outside the workspace\" None [Allow, AllowForSession, Deny]",
            "resolved 20 Withdrawn",
            "question 21 q1 \"Which scope?\" [\"Small\", \"Large\"]",
            "approval 22 \"Fetch the changelog\" None [Allow, AllowForSession, Deny]",
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
        [
            "settings",
            "notice CapabilityUnavailable turn_1 \"Codex rerouted this turn to a different model\""
        ]
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
        "Codex could not start the MCP server github: exited with 1. Work that does not need it continues; MCP servers are set up in Codex's own MCP settings."
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
        ["session thr_1", SETTINGS, "notice EffectiveSettings"]
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
async fn a_codex_slow_to_start_is_not_checked_rather_than_checking_forever() {
    let (mut peer, io) = pipes();
    // Codex takes the request and never answers.
    peer.load(
        &fixture!("login")
            .lines()
            .take(2)
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let slow = Options {
        rpc_timeout: Duration::from_secs(600),
        ..options()
    };

    let (login, ()) = tokio::join!(probe_login(io, slow), async {
        peer.play().await;
        assert!(peer.stdin_closed().await);
        peer.exit(0);
    });

    assert_eq!(login, LoginState::Unknown);
}

#[tokio::test(start_paused = true)]
async fn the_options_probe_lists_every_page_of_models_with_their_efforts_and_closes() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("options"));

    let (options, ()) = tokio::join!(probe_options(io, options()), async {
        peer.play().await;
        assert!(peer.stdin_closed().await);
        peer.exit(0);
    });

    let options = options.expect("Codex listed its options");
    let models: Vec<_> = options
        .models
        .iter()
        .map(|choice| {
            let efforts: Vec<_> = choice.efforts.iter().map(|e| e.id.as_str()).collect();
            (
                choice.model.label.as_str(),
                choice.model.is_default,
                efforts,
            )
        })
        .collect();
    // Hidden models are not choices.
    assert_eq!(
        models,
        [
            ("GPT A", true, vec!["low", "medium", "high"]),
            ("GPT B", false, vec!["high"]),
        ]
    );
    let default_effort = options.models[0].efforts.iter().find(|e| e.is_default);
    assert_eq!(default_effort.map(|e| e.id.as_str()), Some("medium"));
    let permission = options.permission.expect("profiles were listed");
    assert_eq!(permission.current, None);
    assert!(permission.unchangeable.is_some(), "Codex sets permissions");
    assert_eq!(permission.options.len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_new_session_sends_the_chosen_model_and_effort_with_its_first_turn() {
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
        settings: StartSettings {
            model: Some("gpt-b".to_owned()),
            effort: Some("high".to_owned()),
            permission: None,
        },
    };
    let (opened, ()) = tokio::join!(open_over(io, &request, options()), peer.play());
    let runtime = opened.expect("the thread opens").runtime;

    let outcome = submit(&mut peer, &runtime, start_turn("sub-1", "Go")).await;

    assert_eq!(
        outcome,
        DispatchOutcome::Acknowledged {
            turn: turn("turn_1")
        }
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
    let other =
        json!({"name": "postman", "status": "failed", "error": "Run `codex mcp login postman`."});
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
            "Codex could not start the MCP server grafana: timed out. Work that does not need it continues; MCP servers are set up in Codex's own MCP settings."
        ]
    );
    assert!(again.is_empty(), "{again:?}");
    // N3, U18: the provider's own full stop is not doubled, and the shared sentence is
    // said once per session, not after every server.
    assert_eq!(
        messages(&other),
        ["Codex could not start the MCP server postman: Run `codex mcp login postman`."]
    );

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

/// #387 3B3: a command a Stop cuts off completes as failed before the turn ends
/// interrupted; it stays unfinished, which the turn then shows as "not finished".
#[test]
fn a_command_cut_off_by_a_stop_is_not_reported_as_failed() {
    let mut session = Session::default();
    session.notification("turn/started", &json!({"turn": {"id": "turn_1"}}));
    let command = |status: &str| json!({"turnId": "turn_1", "item": {"id": "cmd_1", "type": "commandExecution", "command": "ticketd list", "status": status, "processId": "42", "exitCode": null}});
    session.notification("item/started", &command("inProgress"));
    session.interrupt_asked(&NativeTurnId::new("turn_1"));

    let events = session.notification("item/completed", &command("failed"));

    assert!(
        events.iter().any(|event| matches!(
            event,
            EventKind::ToolUpdated {
                status: crate::ToolStatus::Running,
                ..
            }
        )),
        "{events:?}"
    );
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EventKind::ToolUpdated {
                status: crate::ToolStatus::Failed,
                ..
            }
        )),
        "{events:?}"
    );
}

fn unattended(edit_files: bool, use_web: bool) -> crate::Unattended {
    crate::Unattended {
        run_id: "run-1".into(),
        model: Some("gpt-test".into()),
        tools: ticketd_core::AutomationAgentTools {
            read_files: true,
            edit_files,
            run_commands: true,
            any_command: true,
            allowed_commands: Vec::new(),
            use_web,
        },
        turn_limit: 40,
        ticketd_folders: vec![PathBuf::from("/data/ticketd")],
    }
}

/// Codex cannot run read-only and still let the ticketd CLI record a result, so the
/// "Edit files" switch does not change the sandbox: it is always the step's folder
/// and the Workspace data folder, and nothing wider.
#[test]
fn an_unattended_sandbox_writes_to_the_steps_folder_and_the_workspace_data_folder_only() {
    for (edit_files, use_web) in [(false, false), (false, true), (true, false), (true, true)] {
        let (thread, turn) =
            super::unattended_params(&unattended(edit_files, use_web), Path::new("/work/chat-1"));
        assert_eq!(
            thread,
            json!({"approvalPolicy": "on-request", "sandbox": "workspace-write", "model": "gpt-test"})
        );
        assert_eq!(
            turn,
            json!({
                "approvalPolicy": "on-request",
                "sandboxPolicy": {
                    "type": "workspaceWrite",
                    "networkAccess": use_web,
                    "writableRoots": ["/work/chat-1", "/data/ticketd"],
                    "excludeTmpdirEnvVar": true,
                    "excludeSlashTmp": true,
                },
            })
        );
    }
}

/// The fixture checks that the thread and every turn are started with approvals off
/// and the sandbox, here for an agent with "Edit files" off; a command Codex declines then fails the turn as a denied tool.
#[tokio::test(start_paused = true)]
async fn an_unattended_thread_never_asks_and_a_declined_tool_fails_its_turn() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("unattended"));
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::New,
        unattended: Some(unattended(false, false)),
        ticketd_cli: None,
        taken_over: false,
        settings: StartSettings::default(),
    };
    let (opened, ()) = tokio::join!(open_over(io, &request, options()), peer.play());
    let mut opened = opened.expect("the thread opens");
    drain(&mut opened.events).await;

    submit(&mut peer, &opened.runtime, start_turn("sub-1", "Go")).await;

    match drain(&mut opened.events).await.pop() {
        Some(EventKind::TurnEnded {
            outcome: TurnOutcome::Failed(problem),
            ..
        }) => {
            assert_eq!(problem.kind, ProblemKind::ToolDenied);
            assert!(problem.message.contains("curl example.com"), "{problem:?}");
        }
        other => panic!("a failed turn, got {other:?}"),
    }
}

/// Codex reports a command the person declined as `declined`: it never ran, so it is
/// not a failure.
#[test]
fn a_declined_command_is_declined_not_failed() {
    let mut session = Session::default();
    let mut completed = |status: &str| {
        let item = json!({"type": "commandExecution", "id": "item_9", "command": "rm -rf node_modules", "status": status});
        let params = json!({"turnId": "turn_1", "item": item});
        match session.notification("item/completed", &params).as_slice() {
            [EventKind::ToolUpdated { status, .. }] => *status,
            other => panic!("one tool update, got {other:?}"),
        }
    };
    assert_eq!(completed("declined"), crate::ToolStatus::Declined);
    assert_eq!(completed("failed"), crate::ToolStatus::Failed);
}

/// L4: in an unattended session a command Codex could not start (the item seen live
/// when its Windows sandbox would not set up) fails the turn with Codex's own words,
/// though the agent then ended its turn. A command that ran and failed does not.
#[test]
fn a_command_codex_could_not_start_fails_an_unattended_turn() {
    let not_started = json!({
        "type": "commandExecution", "id": "exec-1", "command": "ticketd show T-1",
        "commandActions": [], "cwd": "/work", "status": "failed", "source": "unifiedExecStartup",
        "aggregatedOutput": "Failed to create unified exec process: helper_unknown_error: setup refresh had errors",
        "exitCode": -1, "durationMs": 0, "processId": null,
    });
    let mut ran = not_started.clone();
    ran["exitCode"] = json!(1);
    ran["durationMs"] = json!(840);
    ran["processId"] = json!("12");
    ran["aggregatedOutput"] = json!("1 test failed");

    let outcome = |item: &Value, unattended: bool| {
        let mut session = Session::default();
        session.turn_overrides = unattended.then(|| json!({}));
        let params = json!({"turnId": "turn_1", "item": item});
        session.notification("item/completed", &params);
        let turn = json!({"turn": {"id": "turn_1", "status": "completed"}});
        match session.notification("turn/completed", &turn).pop() {
            Some(EventKind::TurnEnded { outcome, .. }) => outcome,
            other => panic!("the turn ended, got {other:?}"),
        }
    };

    match outcome(&not_started, true) {
        TurnOutcome::Failed(problem) => {
            assert_eq!(problem.kind, ProblemKind::PermissionUnavailable);
            assert_eq!(
                problem.message,
                "Failed to create unified exec process: helper_unknown_error: setup refresh had errors"
            );
        }
        other => panic!("a failed turn, got {other:?}"),
    }
    assert_eq!(outcome(&ran, true), TurnOutcome::Completed);
    // A person's Chat is theirs to judge: Codex said the turn completed.
    assert_eq!(outcome(&not_started, false), TurnOutcome::Completed);
}

/// 4B1: a file change Codex declined (outside the writable folders) or failed to write
/// fails an unattended turn naming the file, though the agent then ended its turn. In
/// a person's Chat the same items fail nothing.
#[test]
fn a_file_change_codex_declined_or_could_not_write_fails_an_unattended_turn_naming_the_file() {
    let item = |status: &str| {
        json!({"type": "fileChange", "id": "fc_1", "status": status,
            "changes": [{"path": "/elsewhere/a.txt", "kind": {"type": "add"}, "diff": "hi\n"}]})
    };
    let outcome = |status: &str, unattended: bool| {
        let mut session = Session::default();
        session.turn_overrides = unattended.then(|| json!({}));
        let params = json!({"turnId": "turn_1", "item": item(status)});
        session.notification("item/completed", &params);
        let turn = json!({"turn": {"id": "turn_1", "status": "completed"}});
        match session.notification("turn/completed", &turn).pop() {
            Some(EventKind::TurnEnded { outcome, .. }) => outcome,
            other => panic!("the turn ended, got {other:?}"),
        }
    };
    for (status, message) in [
        (
            "declined",
            "Codex could not change /elsewhere/a.txt: it is outside the step's folder.",
        ),
        (
            "failed",
            "Codex could not change /elsewhere/a.txt: the file could not be written.",
        ),
    ] {
        match outcome(status, true) {
            TurnOutcome::Failed(problem) => {
                assert_eq!(problem.kind, ProblemKind::ToolDenied, "{status}");
                assert_eq!(problem.message, message);
            }
            other => panic!("{status}: a failed turn, got {other:?}"),
        }
        assert_eq!(outcome(status, false), TurnOutcome::Completed, "{status}");
    }
    assert_eq!(outcome("completed", true), TurnOutcome::Completed);

    // #387 5A3: the file leads, each denial is its own sentence, and ticketd's own
    // guide command, which the person never asked for, is not named.
    let reason = |commands: &[&str], files: bool| {
        let mut session = Session::default();
        session.turn_overrides = Some(json!({}));
        let mut items: Vec<Value> = commands
            .iter()
            .map(|command| {
                json!({"type": "commandExecution", "id": "c_1", "command": command,
                    "status": "declined"})
            })
            .collect();
        if files {
            items.push(item("declined"));
        }
        for item in items {
            session.notification("item/completed", &json!({"turnId": "turn_1", "item": item}));
        }
        let turn = json!({"turn": {"id": "turn_1", "status": "completed"}});
        match session.notification("turn/completed", &turn).pop() {
            Some(EventKind::TurnEnded {
                outcome: TurnOutcome::Failed(problem),
                ..
            }) => problem.message,
            other => panic!("a failed turn, got {other:?}"),
        }
    };
    let guide = "pwsh -Command 'ticketd skills get chat'";
    assert_eq!(
        reason(&["ls"], true),
        "Codex could not change /elsewhere/a.txt: it is outside the step's folder. Codex could not run ls."
    );
    assert_eq!(
        reason(&[guide], true),
        "Codex could not change /elsewhere/a.txt: it is outside the step's folder."
    );
    assert_eq!(reason(&[guide, "ls"], false), "Codex could not run ls.");
    // #387 6A2: Codex quotes a command like a POSIX shell, doubling its backslashes;
    // the reason shows the command as typed.
    assert_eq!(
        reason(
            &[r#""C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'echo "hi"'"#],
            false
        ),
        r#"Codex could not run "C:\Program Files\PowerShell\7\pwsh.exe" -Command 'echo "hi"'."#
    );
    // Only the guide was declined: the agent still could not do its work.
    assert_eq!(
        reason(&[guide], false),
        "Codex could not run commands in this step."
    );
}

/// 4B1: Codex reports nothing at all for a patch its sandbox policy rejects outright
/// (approvals off), so an unattended session lets Codex ask, and ticketd declines at
/// once: the declined item names the file. A person's Chat still waits for the person.
#[test]
fn an_unattended_session_declines_every_approval_request_at_once() {
    let ask = |session: &mut Session, method: &str| {
        let params = json!({"threadId": "thr_1", "turnId": "turn_1", "itemId": "fc_1"});
        session.server_request(&json!(0), method, &params)
    };
    let mut unattended = Session::default();
    unattended.turn_overrides = Some(json!({}));
    for (method, reply) in [
        (
            "item/fileChange/requestApproval",
            json!({"id": 0, "result": {"decision": "decline"}}),
        ),
        (
            "item/commandExecution/requestApproval",
            json!({"id": 0, "result": {"decision": "decline"}}),
        ),
        (
            "item/permissions/requestApproval",
            json!({"id": 0, "result": {"permissions": {}}}),
        ),
    ] {
        let (events, frame) = ask(&mut unattended, method);
        assert_eq!((events.len(), frame), (0, Some(reply)), "{method}");
    }
    let (events, frame) = ask(&mut Session::default(), "item/fileChange/requestApproval");
    assert_eq!((events.len(), frame), (1, None));
}

/// L5: an unattended thread starts none of the person's MCP servers (named from
/// their configuration), plugins or apps.
#[test]
fn an_unattended_thread_turns_off_each_of_the_persons_mcp_servers_plugins_and_apps() {
    let config =
        json!({"mcp_servers": {"docs": {"command": "docs-mcp"}, "web": {"url": "https://x"}}});
    assert_eq!(
        super::personal_tools_off(Some(&config)),
        json!({
            "features.plugins": false,
            "features.apps": false,
            "mcp_servers.docs.enabled": false,
            "mcp_servers.web.enabled": false,
        })
    );
    assert_eq!(
        super::personal_tools_off(None),
        json!({"features.plugins": false, "features.apps": false})
    );
}

/// L2: a Chat taken over from a run resumes with the person's own approval policy
/// and sandbox, and Codex's defaults for what their configuration leaves unset.
#[test]
fn a_taken_over_thread_resumes_with_the_persons_own_approvals() {
    let config = json!({"approval_policy": "untrusted", "sandbox_mode": null});
    assert_eq!(
        super::own_approvals(Some(&config)),
        json!({"approvalPolicy": "untrusted", "sandbox": "read-only"})
    );
    assert_eq!(
        super::own_approvals(None),
        json!({"approvalPolicy": "on-request", "sandbox": "read-only"})
    );
}

/// L2 and L5 through the protocol: the fixtures check that an unattended thread
/// reads the configuration and starts with the servers off, and that a taken-over
/// thread reads it and resumes with the person's approvals.
#[tokio::test(start_paused = true)]
async fn a_taken_over_thread_is_resumed_with_its_configuration_read_first() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("resume_taken_over"));
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::Resume(NativeSessionId::new("thr_1")),
        unattended: None,
        ticketd_cli: None,
        taken_over: true,
        settings: StartSettings::default(),
    };
    let (opened, ()) = tokio::join!(open_over(io, &request, options()), peer.play());
    let mut opened = opened.expect("the thread resumes");
    let events = drain(&mut opened.events).await;
    let notice = events.iter().find_map(|event| match event {
        EventKind::Notice { message, .. } => Some(message.clone()),
        _ => None,
    });
    assert_eq!(
        notice.as_deref(),
        Some("Model gpt-test, approval policy on-request, sandbox workspaceWrite")
    );
}

#[tokio::test(start_paused = true)]
async fn reasoning_plan_files_and_context_carry_only_what_codex_reported() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("reports"));

    submit(&mut peer, &runtime, start_turn("sub-1", "Add a limiter")).await;

    assert_eq!(
        seen(&mut events).await,
        [
            "turn-started turn_1",
            "reasoning rs_1 running Some(1730910000000) None None None",
            // A heading only once Codex closed the bold text it marked one with.
            "reasoning rs_1 running Some(1730910000000) None None Some(\"Reading the handler\")",
            "reasoning rs_1 done Some(1730910000000) Some(1730910012000) Some(\"**Reading the handler**\\n\\nThe handler has no limit.\") Some(\"Reading the handler\")",
            "plan [\"Completed Read the handler\", \"InProgress Add the limiter\", \"Pending Run the tests\"] Some(\"Small change\")",
            "tool fc_1 \"Edit /work/chat-1/src/limiter.ts, /work/chat-1/src/handler.ts\" Running None",
            "files [\"Added /work/chat-1/src/limiter.ts +2 -0 unconfirmed\", \"Modified /work/chat-1/src/handler.ts +1 -1 unconfirmed\"]",
            "tool fc_1 \"Edit /work/chat-1/src/limiter.ts, /work/chat-1/src/handler.ts\" Succeeded None",
            "files [\"Added /work/chat-1/src/limiter.ts +2 -0\", \"Modified /work/chat-1/src/handler.ts +1 -1\"]",
            // The turn's net diff replaces the counts of the files it names.
            "files [\"Added /work/chat-1/src/limiter.ts +2 -0\", \"Modified /work/chat-1/src/handler.ts +2 -1\"]",
            // The last request's tokens, of the window Codex gave.
            "context 124000 of 200000 [] None",
            "compacted",
            // A proposed plan is Markdown, shown like a response.
            "message pl_1 \"1. Add the limiter\\n2. Test it\"",
            "turn-ended turn_1 Completed [\"sub-1\"]",
        ]
    );
}

#[test]
fn a_failed_file_change_changed_nothing_and_usage_without_a_window_is_not_reported() {
    let mut session = Session::default();
    let item = |status: &str| {
        json!({"turnId": "turn_1", "item": {"type": "fileChange", "id": "fc_1", "status": status,
            "changes": [{"path": "a.ts", "kind": {"type": "update", "move_path": "b.ts"}, "diff": "+x\n"}]}})
    };
    session.notification("item/started", &item("inProgress"));
    let failed = session.notification("item/completed", &item("failed"));
    assert_eq!(failed.last().map(brief).as_deref(), Some("files []"));

    let started = session.notification("item/started", &item("inProgress"));
    assert_eq!(
        started.last().map(brief).as_deref(),
        Some("files [\"Renamed { from: \\\"a.ts\\\" } b.ts +1 -0 unconfirmed\"]")
    );

    let usage = json!({"turnId": "turn_1", "tokenUsage": {"last": {"totalTokens": 5}, "modelContextWindow": null}});
    assert!(
        session
            .notification("thread/tokenUsage/updated", &usage)
            .is_empty()
    );
}

#[tokio::test(start_paused = true)]
async fn settings_come_from_codex_lists_and_a_chosen_model_goes_out_with_the_next_turn() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("settings"));
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::New,
        unattended: None,
        ticketd_cli: None,
        taken_over: false,
        settings: StartSettings::default(),
    };
    let listing = Options {
        list_settings: true,
        ..options()
    };
    let (opened, ()) = tokio::join!(open_over(io, &request, listing), peer.play());
    let mut opened = opened.expect("the thread opens");

    let settings = drain(&mut opened.events).await;
    let models = "model=gpt-a[\"gpt-a\", \"gpt-b\"] effort=medium[\"low\", \"medium\", \"high\"]";
    let profiles = "[\":read-only\", \":workspace\", \":danger-no-sandbox\"] fixed";
    assert_eq!(
        settings.iter().map(brief).collect::<Vec<_>>(),
        [
            "session thr_1".to_owned(),
            // Before the lists: the thread's own answer, with no choices.
            "settings model=gpt-a[] permission=workspaceWrite[\"workspaceWrite\"] fixed".to_owned(),
            "notice EffectiveSettings".to_owned(),
            // Hidden models are not choices; efforts are the current model's, in order.
            format!("settings {models} permission=workspaceWrite[\"workspaceWrite\"] fixed"),
            format!("settings {models} permission=?{profiles}"),
            format!("settings {models} permission=:workspace{profiles}"),
        ]
    );
    let Some(EventKind::SettingsState(last)) = settings.last() else {
        panic!("settings last, got {settings:?}");
    };
    let profile_options = &last.permission.as_ref().expect("permission").options;
    assert!(
        !profile_options[2].allowed,
        "Codex's policy refuses this profile"
    );

    let runtime = opened.runtime;
    let change = |setting, value: &str| crate::SettingChange {
        generation: GENERATION,
        setting,
        value: value.to_owned(),
    };
    assert_eq!(
        runtime
            .change_setting(change(crate::SettingKey::Model, "gpt-b"))
            .await,
        crate::SettingOutcome::Applied
    );
    assert_eq!(
        runtime
            .change_setting(change(crate::SettingKey::Permission, ":read-only"))
            .await,
        crate::SettingOutcome::Unsupported
    );
    // Nothing was written for the change: the next turn carries it.
    let outcome = submit(&mut peer, &runtime, start_turn("sub-1", "Go")).await;
    assert_eq!(
        outcome,
        DispatchOutcome::Acknowledged {
            turn: turn("turn_1")
        }
    );
}
