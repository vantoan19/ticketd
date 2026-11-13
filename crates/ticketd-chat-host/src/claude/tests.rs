//! Drives the adapter through its contract interface against scripted bridge traffic.
//! Each fixture is a JSON-lines transcript: `client` commands the adapter must write,
//! `server` events the bridge sends, and `mark` lines where the test acts.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::time::{sleep, timeout};

use super::runtime::{Options, open_over, probe};
use super::{BRIDGE_SIDECAR_NAME, candidates, locate, verdict};
use crate::install::{LaunchEnvironment, Os};
use crate::scripted::{Peer, brief, pipes};
use crate::stdio::{Line, read_line, spawn};
use crate::{
    ApprovalDecision, Capability, CloseOutcome, DispatchOutcome, EventKind, EventStream,
    HarnessRuntime, Inspection, InteractionAnswer, InteractionResponse, InterruptOutcome,
    InterruptRequest, LoginState, NativeRequestId, NativeSessionId, NativeTurnId, OpenRequest,
    OpenedRuntime, Problem, ProblemKind, QuestionAnswer, Refusal, RespondOutcome,
    RuntimeGeneration, SessionStart, Submission, SubmissionId, SubmissionKind,
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
            "turn-started local-turn-1",
            "delta text-1 \"Here\"",
            &processing("sub-1", "local-turn-1"),
            "delta text-1 \" you go\"",
            "message text-1 \"Here you go\"",
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
            "turn-ended local-turn-1 Interrupted [\"sub-1\"]"
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
async fn losing_the_bridge_after_a_write_leaves_the_submission_unknown() {
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
    let responded = runtime
        .respond(approve("7-1", ApprovalDecision::Allow))
        .await;
    let interrupted = runtime.interrupt(interrupt("local-turn-1")).await;
    assert_eq!(submitted, DispatchOutcome::NotSent(closed.clone()));
    assert_eq!(responded, RespondOutcome::NotSent(closed.clone()));
    assert_eq!(interrupted, InterruptOutcome::NotSent(closed));
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
async fn a_refusal_after_the_wait_ran_out_is_late_evidence() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("late_rejection"));

    // Nothing was heard in time: the input may have been handed over.
    let outcome = runtime.submit(start_turn("sub-1", "Hello")).await;
    assert_eq!(outcome, DispatchOutcome::Written);

    peer.play().await;
    assert_eq!(
        seen(&mut events).await,
        [
            "evidence sub-1 Rejected { reason: \"duplicate_submission: submission is \
             unresolved\" }"
        ]
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
            "turn-ended local-turn-2 Completed [\"sub-2\"]",
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn stale_generations_requests_and_turns_write_nothing() {
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
            ..approve("7-1", ApprovalDecision::Allow)
        })
        .await;
    let interrupted = runtime
        .interrupt(InterruptRequest {
            generation: old,
            ..interrupt("local-turn-1")
        })
        .await;
    let never_asked = runtime
        .respond(approve("7-1", ApprovalDecision::Allow))
        .await;
    let no_turn = runtime.interrupt(interrupt("local-turn-1")).await;

    assert_eq!(submitted, DispatchOutcome::NotSent(stale.clone()));
    assert_eq!(responded, RespondOutcome::NotSent(stale.clone()));
    assert_eq!(interrupted, InterruptOutcome::NotSent(stale));
    assert_eq!(
        never_asked,
        RespondOutcome::NotSent(Refusal::UnknownRequest)
    );
    assert_eq!(
        no_turn,
        InterruptOutcome::NotSent(Refusal::TurnMismatch { active: None })
    );
    peer.assert_nothing_written().await;
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
async fn inspection_judges_the_pairing_without_opening_a_session() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("inspect"));

    let probing = probe(io, Path::new(CLAUDE), Options::default());
    let (inspection, ()) = tokio::join!(probing, async {
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
    // Sign-in is Claude Code's business; steering is unvalidated, so not offered.
    assert_eq!(login, LoginState::Unknown);
    assert!(matches!(capabilities.steering, Capability::Unknown { .. }));
    assert!(capabilities.native_resume.behavior().is_some());
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
            allowed_commands: vec!["npm test".into()],
            use_web: false,
        },
        turn_limit: 40,
        ticketd_cli: Some(PathBuf::from("/opt/ticketd/ticketd")),
        ticketd_folders: Vec::new(),
    }
}

#[test]
fn an_agent_with_every_switch_off_may_still_run_the_ticketd_cli_and_nothing_else() {
    let mut unattended = reader_that_tests();
    unattended.model = None;
    unattended.ticketd_cli = None;
    unattended.tools = ticketd_core::AutomationAgentTools {
        read_files: false,
        edit_files: false,
        run_commands: false,
        allowed_commands: vec!["npm test".into()],
        use_web: false,
    };

    assert_eq!(
        super::unattended_options(&unattended),
        json!({
            "allowed_tools": ["Bash(ticketd:*)"],
            "disallowed_tools": [
                "Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"
            ],
            "max_turns": 40,
        })
    );

    // Running commands with no list allows any command.
    unattended.tools.run_commands = true;
    unattended.tools.allowed_commands.clear();
    let options = super::unattended_options(&unattended);
    assert_eq!(options["allowed_tools"], json!(["Bash(ticketd:*)", "Bash"]));
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
        match drain(&mut opened.events).await.pop() {
            Some(EventKind::TurnEnded {
                outcome: crate::TurnOutcome::Failed(problem),
                ..
            }) => (problem.kind, problem.message),
            other => panic!("a failed turn, got {other:?}"),
        }
    };

    assert_eq!(
        ended(&mut peer, "sub-1").await.0,
        ProblemKind::TurnLimitReached
    );
    // The agent ended its turn itself, but without the tool it was denied.
    assert_eq!(
        ended(&mut peer, "sub-2").await,
        (
            ProblemKind::ToolDenied,
            "Claude Code was denied Write.".to_owned()
        )
    );
}
