//! Drives the adapter through its contract interface against scripted app-server
//! traffic. Each fixture is a JSON-lines transcript: `client` frames the adapter must
//! write, `server` frames app-server sends, and `mark` lines where the test acts.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::time::{sleep, timeout};

use super::CodexAdapter;
use super::mapping::Session;
use super::runtime::{Options, login_state, open_over, probe_login, probe_options, probe_skills};
use crate::conformance::{NewTurn, Provider, SubAgentApprovals};
use crate::outcome::read_end;
use crate::scripted::{Peer, brief, pipes};
use crate::{
    ApprovalDecision, CloseOutcome, DispatchOutcome, EventKind, EventStream, HarnessAdapter,
    HarnessRuntime, HarnessSkill, InteractionAnswer, InteractionResponse, InterruptOutcome,
    InterruptRequest, LoginState, NativeRequestId, NativeSessionId, NativeTurnId, NoticeKind,
    OpenRequest, OpenedRuntime, Problem, ProblemKind, QuestionAnswer, Refusal, RespondOutcome,
    RuntimeGeneration, SessionStart, StartSettings, Submission, SubmissionId, SubmissionKind,
    TurnOutcome,
};

const GENERATION: RuntimeGeneration = RuntimeGeneration(7);
/// The settings the handshake fixture's `thread/start` reply reports.
const SETTINGS: &str = "settings model=gpt-test[] permission=own[\"own\", \"full-access\"]";

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!("../../tests/fixtures/codex/", $name, ".jsonl"))
    };
}

#[test]
fn a_recorded_command_keeps_its_input_while_output_streams() {
    let mut session = Session::default();
    let mut inputs = std::collections::HashMap::new();
    let mut streamed = 0;
    for line in fixture!("recorded-steps").lines() {
        let frame: Value = serde_json::from_str(line).expect("recorded frame");
        let Some(method) = frame["server"]["method"].as_str() else {
            continue;
        };
        let params = &frame["server"]["params"];
        if !matches!(method, "item/started" | "item/commandExecution/outputDelta") {
            continue;
        }
        for event in session.notification(method, params) {
            let EventKind::ToolUpdated { item, detail, .. } = event else {
                continue;
            };
            let input = detail.expect("running tool keeps its native input");
            if method == "item/started" {
                inputs.insert(item.0, input);
            } else {
                assert_eq!(&input, &inputs[&item.0]);
                streamed += 1;
            }
        }
    }
    assert_eq!(streamed, 2);
}

#[test]
fn recorded_steps_keep_actions_and_counts_after_mapping() {
    use crate::{
        FileTargets, LineCounts, StepAction, StepOutcomeOverride, ToolEvidence, read_tool_steps,
    };
    use ticketd_core::ChatToolState;

    let mut session = Session::default();
    let mut steps = Vec::new();
    for line in fixture!("recorded-steps").lines() {
        let frame: Value = serde_json::from_str(line).expect("recorded frame");
        let Some(method @ ("item/started" | "item/completed")) = frame["server"]["method"].as_str()
        else {
            continue;
        };
        for event in session.notification(method, &frame["server"]["params"]) {
            let EventKind::ToolUpdated {
                detail: Some(detail),
                title,
                output,
                status,
                ..
            } = event
            else {
                continue;
            };
            let state = match status {
                crate::ToolStatus::Running => continue,
                crate::ToolStatus::Succeeded => ChatToolState::Completed,
                crate::ToolStatus::Failed | crate::ToolStatus::Declined => ChatToolState::Failed,
                other => panic!("unexpected recorded status {other:?}"),
            };
            let _: Value = serde_json::from_str(detail.payload()).expect("valid stored JSON");
            steps.extend(read_tool_steps(
                "codex",
                ToolEvidence {
                    name: &title,
                    input: detail.payload(),
                    output: output.as_deref(),
                    state,
                    working_directory: "/fixture/work",
                },
            ));
        }
    }
    assert_eq!(steps.len(), 6);
    assert!(matches!(steps[0].action, StepAction::Read(_)));
    assert!(matches!(
        steps[1].action,
        StepAction::Search {
            no_matches: true,
            ..
        }
    ));
    assert!(matches!(
        steps[2].action,
        StepAction::Edit {
            counts: LineCounts {
                added: Some(1),
                removed: Some(1)
            },
            ..
        }
    ));
    assert!(matches!(
        &steps[3].action,
        StepAction::Create {
            targets: FileTargets::Paths(paths),
            counts: LineCounts { added: Some(220), removed: Some(0) },
        } if paths == &["/fixture/work/large.txt"]
    ));
    assert!(steps[4].command.is_some());
    assert_eq!(steps[5].outcome, Some(StepOutcomeOverride::Declined));
}

#[test]
fn a_bounded_patch_keeps_the_actions_for_files_it_could_not_keep() {
    use crate::{
        FileTargets, MAX_PROVIDER_DETAIL_BYTES, OmittedFiles, StepAction, ToolEvidence,
        read_tool_steps,
    };
    use ticketd_core::ChatToolState;

    let mut changes: Vec<Value> = (0..150)
        .map(|index| {
            json!({"path": format!("/work/{index}-{}.txt", "x".repeat(120)),
                "kind": {"type": "add"}, "diff": "new line"})
        })
        .collect();
    changes.push(json!({"path": "/work/old.txt", "kind": {"type": "delete"}, "diff": "old"}));
    let events = Session::default().notification(
        "item/started",
        &json!({"turnId": "turn_1", "item": {
            "type": "fileChange", "id": "patch", "status": "inProgress", "changes": changes,
        }}),
    );
    let (title, detail) = events
        .iter()
        .find_map(|event| match event {
            EventKind::ToolUpdated {
                title,
                detail: Some(detail),
                ..
            } => Some((title, detail)),
            _ => None,
        })
        .expect("patch tool evidence");
    assert!(detail.payload().len() <= MAX_PROVIDER_DETAIL_BYTES);

    let steps = read_tool_steps(
        "codex",
        ToolEvidence {
            name: title,
            input: detail.payload(),
            output: None,
            state: ChatToolState::Running,
            working_directory: "/work",
        },
    );
    let [created, deleted] = steps.as_slice() else {
        panic!("expected a create and a delete action");
    };
    let StepAction::Create {
        targets: FileTargets::Paths(paths),
        counts,
    } = &created.action
    else {
        panic!("expected a create action");
    };
    let Some(OmittedFiles::Count(omitted)) = created.omitted_files else {
        panic!("expected a count of unlisted creations");
    };
    assert_eq!(paths.len() + omitted.get() as usize, 150);
    assert_eq!(counts.added, Some(paths.len() as u32));
    assert!(matches!(&deleted.action, StepAction::Delete { paths, .. } if paths.is_empty()));
    assert!(matches!(
        deleted.omitted_files,
        Some(OmittedFiles::Count(count)) if count.get() == 1
    ));
}

#[test]
fn a_legacy_patch_reports_omissions_only_when_the_saved_inventory_is_partial() {
    use crate::{FileTargets, LineCounts, OmittedFiles, StepAction, ToolEvidence, read_tool_steps};
    use ticketd_core::ChatToolState;

    let input = r#"{"type":"fileChange","changes":[
        {"path":"/work/a, b.txt","kind":{"type":"update"},"ticketd_lines":{"added":2,"removed":1}}
    ]}"#;
    for (name, expected) in [
        ("Edit /work/a, b.txt", None),
        (
            "Edit /work/a, b.txt, /work/c.txt",
            Some(OmittedFiles::Unknown),
        ),
    ] {
        let steps = read_tool_steps(
            "codex",
            ToolEvidence {
                name,
                input,
                output: None,
                state: ChatToolState::Completed,
                working_directory: "/work",
            },
        );
        let [step] = steps.as_slice() else {
            panic!("expected a single edit step");
        };
        assert_eq!(step.omitted_files, expected);
        assert_eq!(
            step.action,
            StepAction::Edit {
                targets: FileTargets::Paths(vec!["/work/a, b.txt".to_owned()]),
                counts: LineCounts {
                    added: Some(2),
                    removed: Some(1)
                },
            }
        );
    }
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
        recorded_settings: None,
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
        attachments: Vec::new(),
    }
}

#[tokio::test(start_paused = true)]
async fn a_screenshot_is_native_visual_input_with_or_without_text() {
    let url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    let image =
        ticketd_core::ChatAttachmentContent::from_image_data_url("Screenshot.png", url).unwrap();
    for (text, expected) in [
        ("", json!([{"type": "image", "url": url}])),
        (
            "Which color?",
            json!([
                {"type": "text", "text": "Which color?", "text_elements": []},
                {"type": "image", "url": url},
            ]),
        ),
    ] {
        let (mut peer, runtime, _events) = open().await;
        let submission = Submission {
            attachments: vec![image.clone()],
            ..start_turn("sub-1", text)
        };
        let (outcome, ()) = tokio::join!(runtime.submit(submission), async {
            let written = peer.written().await;
            assert_eq!(written["method"], "turn/start");
            assert_eq!(written["params"]["input"], expected);
        });
        assert_eq!(outcome, DispatchOutcome::Written);
    }
}

#[tokio::test(start_paused = true)]
async fn a_local_file_reaches_codex_as_a_readable_copy_of_the_snapshot() {
    let source = tempfile::tempdir().unwrap();
    let path = source.path().join("details.txt");
    std::fs::write(&path, b"original bytes\r\n").unwrap();
    let file = ticketd_core::ChatAttachmentContent::from_data_url(
        "details.txt",
        "data:text/plain;base64,b3JpZ2luYWwgYnl0ZXMNCg==",
        100,
    )
    .unwrap();
    std::fs::write(&path, b"changed after capture").unwrap();

    for text in ["", "What does details.txt say?"] {
        let (mut peer, runtime, _events) = open().await;
        let submission = Submission {
            attachments: vec![file.clone()],
            ..start_turn("sub-1", text)
        };
        let (outcome, written) = tokio::join!(runtime.submit(submission), peer.written());
        assert_eq!(outcome, DispatchOutcome::Written);
        assert_eq!(written["method"], "turn/start");
        assert!(written["params"]["sandboxPolicy"].is_null());
        let input = written["params"]["input"].as_array().unwrap();
        if !text.is_empty() {
            assert_eq!(input[0]["text"], text);
        }
        assert_eq!(input.len(), 1 + usize::from(!text.is_empty()));
        let reference = input.last().unwrap();
        assert_eq!(reference["type"], "text");
        let reference: Value = serde_json::from_str(
            reference["text"]
                .as_str()
                .unwrap()
                .strip_prefix("Read this Chat attachment snapshot: ")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(reference["name"], "details.txt");
        let staged = Path::new(reference["path"].as_str().unwrap());
        assert_ne!(staged, path);
        assert!(staged.is_absolute());
        // The runtime returned from submission; the harness can still open it.
        assert_eq!(std::fs::read(staged).unwrap(), b"original bytes\r\n");
        let (closed, ()) = tokio::join!(runtime.close(), async {
            assert!(peer.stdin_closed().await);
            peer.exit(0);
        });
        assert!(matches!(closed, CloseOutcome::Confirmed { .. }));
        assert!(!staged.exists());
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

#[tokio::test(start_paused = true)]
async fn a_steer_carries_text_native_images_and_readable_file_snapshots_in_order() {
    let (mut peer, runtime, _events) = open().await;
    peer.load(fixture!("steer"));
    submit(&mut peer, &runtime, start_turn("sub-1", "Start")).await;
    let url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    let image =
        ticketd_core::ChatAttachmentContent::from_image_data_url("Screenshot.png", url).unwrap();
    let file = ticketd_core::ChatAttachmentContent::from_data_url(
        "details.txt",
        "data:text/plain;base64,c2F2ZWQgYnl0ZXM=",
        100,
    )
    .unwrap();
    let submission = Submission {
        attachments: vec![file, image],
        ..steer("sub-2", "turn_1", "Read both")
    };
    let sending = runtime.submit(submission);
    tokio::pin!(sending);
    let written = tokio::select! {
        outcome = &mut sending => panic!("steer finished before writing: {outcome:?}"),
        written = peer.written() => written,
    };
    let reply = json!({"id": written["id"], "result": {"turnId": "turn_1"}});
    peer.send(&format!("{reply}\n")).await;
    let outcome = sending.await;
    assert_eq!(
        outcome,
        DispatchOutcome::Acknowledged {
            turn: turn("turn_1")
        }
    );
    assert_eq!(written["method"], "turn/steer");
    assert_eq!(written["params"]["expectedTurnId"], "turn_1");
    let input = written["params"]["input"].as_array().unwrap();
    assert_eq!(input.len(), 3);
    assert_eq!(input[0]["text"], "Read both");
    assert_eq!(input[2], json!({"type": "image", "url": url}));
    let reference: Value = serde_json::from_str(
        input[1]["text"]
            .as_str()
            .unwrap()
            .strip_prefix("Read this Chat attachment snapshot: ")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(reference["name"], "details.txt");
    assert_eq!(
        std::fs::read(reference["path"].as_str().unwrap()).unwrap(),
        b"saved bytes"
    );
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
    assert_eq!(
        runtime.submit(start_turn("sub-1b", "Hello again")).await,
        DispatchOutcome::NotSent(Refusal::StartUnconfirmed)
    );
    peer.assert_nothing_written().await;
    peer.play().await;
    assert_eq!(
        seen(&mut events).await,
        [
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
    peer.assert_nothing_written().await;
}

#[tokio::test(start_paused = true)]
async fn a_late_start_rejection_allows_another_turn() {
    let mut peer = provider().await;
    assert_eq!(
        peer.submit_unanswered("sub-1").await,
        DispatchOutcome::Written
    );

    peer.refuse_late("sub-1").await;
    assert_eq!(
        seen(peer.events()).await,
        ["evidence sub-1 Rejected { reason: \"server is shutting down (code -32600)\" }"]
    );
    peer.assert_nothing_else_written().await;
    assert_eq!(
        peer.start_turn("sub-2").await,
        DispatchOutcome::Acknowledged {
            turn: turn("turn_1")
        }
    );
}

#[tokio::test(start_paused = true)]
async fn a_correlated_turn_can_finish_before_its_start_reply() {
    let (mut peer, runtime, mut events) = open().await;
    peer.load(fixture!("late_start_after_completion"));
    assert_eq!(
        submit(&mut peer, &runtime, start_turn("sub-1", "First")).await,
        DispatchOutcome::Written,
    );

    peer.play().await;
    assert_eq!(seen(&mut events).await, ["turn-ended older Completed []"]);
    assert_eq!(
        runtime.submit(start_turn("sub-2", "Second")).await,
        DispatchOutcome::NotSent(Refusal::StartUnconfirmed),
    );
    peer.assert_nothing_written().await;

    peer.play().await;
    assert_eq!(
        seen(&mut events).await,
        ["evidence sub-1 Processing { turn: NativeTurnId(\"turn_1\") }"],
    );
    assert_eq!(
        runtime.submit(start_turn("sub-2", "Second")).await,
        turn_mismatch("turn_1"),
    );

    peer.play().await;
    assert_eq!(
        seen(&mut events).await,
        ["turn-ended turn_1 Completed [\"sub-1\"]"],
    );
    assert_eq!(
        submit(&mut peer, &runtime, start_turn("sub-2", "Second")).await,
        DispatchOutcome::Acknowledged {
            turn: turn("turn_2")
        },
    );

    peer.play().await;
    assert_eq!(
        seen(&mut events).await,
        ["evidence sub-1 Acknowledged { turn: NativeTurnId(\"turn_1\") }"],
    );
    assert_eq!(
        runtime.submit(start_turn("sub-3", "Third")).await,
        turn_mismatch("turn_2"),
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
            // Another thread's turn is a sub-agent's, not unknown traffic and not the Chat's turn.
            "sub-agent-started thr_other run Some(\"turn_x\") parent None tool None background true {\"root_turn\":null}",
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
    // The person's own Codex settings, or Full access.
    let permission = options.permission.expect("the permission choices");
    assert_eq!(permission.current, None);
    assert_eq!(permission.unchangeable, None);
    let choices: Vec<_> = permission
        .options
        .iter()
        .map(|o| (o.id.as_str(), o.is_default, o.allowed))
        .collect();
    assert_eq!(choices, [("own", true, true), ("full-access", false, true)]);
}

#[tokio::test(start_paused = true)]
async fn the_skills_probe_lists_enabled_skills_for_the_chat_folder_and_closes() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("skills"));

    let (skills, ()) = tokio::join!(
        probe_skills(io, options(), Path::new("/work/chat-1")),
        async {
            peer.play().await;
            assert!(peer.stdin_closed().await);
            peer.exit(0);
        }
    );
    assert_eq!(
        skills.expect("Codex listed its skills"),
        [HarnessSkill {
            name: "check-logs".to_owned(),
            description: "Inspect logs".to_owned(),
        }]
    );
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
        recorded_settings: None,
        settings: StartSettings {
            model: Some("gpt-b".to_owned()),
            effort: Some("high".to_owned()),
            ..StartSettings::default()
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

fn permission_shown(events: &[EventKind]) -> Option<String> {
    events.iter().rev().find_map(|event| match event {
        EventKind::SettingsState(settings) => settings.permission.as_ref()?.current.clone(),
        _ => None,
    })
}

/// Full access goes out with every turn while it is chosen, and the turn after leaving
/// it gives the thread back the approval policy and sandbox it opened with, which are
/// recorded with the Chat for a later session.
#[tokio::test(start_paused = true)]
async fn full_access_goes_out_with_each_turn_and_leaving_it_restores_the_threads_own() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("full_access"));
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
            permission: Some("full-access".to_owned()),
            ..StartSettings::default()
        },
    };
    let (opened, ()) = tokio::join!(open_over(io, &request, options()), peer.play());
    let mut opened = opened.expect("the thread opens");
    let events = drain(&mut opened.events).await;
    // The pick shows before the turn that carries it.
    assert_eq!(permission_shown(&events).as_deref(), Some("full-access"));
    let recorded = events.iter().find_map(|event| match event {
        EventKind::Notice {
            kind: NoticeKind::EffectiveSettings,
            detail: Some(detail),
            ..
        } => serde_json::from_str::<Value>(detail.payload()).ok(),
        _ => None,
    });
    let recorded = recorded.expect("the settings are recorded");
    assert_eq!(recorded["own"]["approvalPolicy"], json!("on-request"));
    // The Chat's choice, which a session opened for it again applies.
    assert_eq!(recorded["reopen_with"]["permission"], json!("full-access"));

    let runtime = opened.runtime;
    for (submission, text) in [("sub-1", "Go"), ("sub-2", "Go on")] {
        let outcome = submit(&mut peer, &runtime, start_turn(submission, text)).await;
        assert!(matches!(outcome, DispatchOutcome::Acknowledged { .. }));
        drain(&mut opened.events).await;
    }
    let change = crate::SettingChange {
        generation: GENERATION,
        setting: crate::SettingKey::Permission,
        value: "own".to_owned(),
    };
    assert_eq!(
        runtime.change_setting(change).await,
        crate::SettingOutcome::Applied
    );
    let file = ticketd_core::ChatAttachmentContent::from_data_url(
        "details.txt",
        "data:text/plain;base64,c2F2ZWQ=",
        100,
    )
    .unwrap();
    let (outcome, ()) = tokio::join!(
        runtime.submit(Submission {
            attachments: vec![file],
            ..start_turn("sub-3", "Careful now")
        }),
        async {
            let written = peer.written().await;
            assert_eq!(written["method"], "turn/start");
            let params = &written["params"];
            assert_eq!(params["clientUserMessageId"], "sub-3");
            assert_eq!(params["approvalPolicy"], "on-request");
            assert_eq!(
                params["sandboxPolicy"],
                json!({"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false})
            );
            assert_eq!(params["input"][0]["text"], "Careful now");
            assert!(
                params["input"][1]["text"]
                    .as_str()
                    .unwrap()
                    .contains("details.txt")
            );
            peer.play().await;
        }
    );
    assert!(matches!(outcome, DispatchOutcome::Acknowledged { .. }));
    // The turn that carried the change records it with the Chat.
    let rerecorded = drain(&mut opened.events)
        .await
        .into_iter()
        .find_map(|event| match event {
            EventKind::Notice {
                kind: NoticeKind::EffectiveSettings,
                detail: Some(detail),
                ..
            } => serde_json::from_str::<Value>(detail.payload()).ok(),
            _ => None,
        });
    assert_eq!(
        rerecorded.map(|settings| settings["reopen_with"]["permission"].clone()),
        Some(json!("own"))
    );
}

/// T-QZ66: a Chat shows, before any session, the choice its record kept, and the
/// session opened for it applies that choice, whatever the thread itself kept.
#[tokio::test(start_paused = true)]
async fn a_reopened_chat_shows_and_applies_the_choice_its_record_kept() {
    let shown = |recorded: Option<Value>, picked: Option<&str>| {
        let recorded = recorded.map(|recorded| recorded.to_string());
        CodexAdapter::new()
            .permission_before_session(recorded.as_deref(), picked)
            .and_then(|setting| setting.current)
    };
    let kept = json!({"approvalPolicy": "on-request", "sandbox": {"type": "workspaceWrite"},
                      "reopen_with": {"permission": "full-access"}});
    assert_eq!(
        shown(Some(kept.clone()), None).as_deref(),
        Some("full-access")
    );
    assert_eq!(
        shown(Some(kept.clone()), Some("own")).as_deref(),
        Some("own")
    );
    // A record from before the choice was kept: how the thread last opened.
    let never = json!({"approvalPolicy": "never", "sandbox": {"type": "dangerFullAccess"}});
    assert_eq!(shown(Some(never), None).as_deref(), Some("full-access"));
    let asks = json!({"approvalPolicy": "on-request", "sandbox": {"type": "readOnly"}});
    assert_eq!(shown(Some(asks), None).as_deref(), Some("own"));
    assert_eq!(shown(None, None), None, "no record: nothing to say yet");
    // A change the person makes is saved over the choice; their own policies stay.
    let own = json!({"approvalPolicy": "on-request", "sandboxPolicy": {"type": "workspaceWrite"}});
    let mut with_own = kept.clone();
    with_own["own"] = own.clone();
    let saved: Value = serde_json::from_str(
        &CodexAdapter::new()
            .record_permission(Some(&with_own.to_string()), "own")
            .expect("the record changes"),
    )
    .unwrap();
    assert_eq!(saved["reopen_with"]["permission"], json!("own"));
    assert_eq!(saved["own"], own);
    assert_eq!(CodexAdapter::new().record_permission(None, "own"), None);

    let (mut peer, io) = pipes();
    peer.load(fixture!("resume_recorded_choice"));
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::Resume(NativeSessionId::new("thr_1")),
        unattended: None,
        ticketd_cli: None,
        taken_over: false,
        recorded_settings: Some(kept.to_string()),
        settings: StartSettings::default(),
    };
    let (opened, ()) = tokio::join!(open_over(io, &request, options()), peer.play());
    let mut opened = opened.expect("the thread resumes");
    let events = drain(&mut opened.events).await;
    assert_eq!(permission_shown(&events).as_deref(), Some("full-access"));
    // The thread itself reports asking: the first turn says Full access again.
    let outcome = submit(&mut peer, &opened.runtime, start_turn("sub-1", "Go")).await;
    assert!(matches!(outcome, DispatchOutcome::Acknowledged { .. }));
}

/// After a restart the thread still runs in Full access, which is what the Chat
/// shows, and leaving it restores the person's settings as the Chat recorded them.
#[tokio::test(start_paused = true)]
async fn a_resumed_chat_in_full_access_leaves_it_for_the_recorded_own_settings() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("resume_full_access"));
    let own = json!({
        "approvalPolicy": "on-request",
        "sandboxPolicy": {"type": "workspaceWrite", "writableRoots": [], "networkAccess": false,
                          "excludeTmpdirEnvVar": false, "excludeSlashTmp": false},
    });
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::Resume(NativeSessionId::new("thr_1")),
        unattended: None,
        ticketd_cli: None,
        taken_over: false,
        recorded_settings: Some(json!({"model": "gpt-test", "own": own}).to_string()),
        settings: StartSettings::default(),
    };
    let (opened, ()) = tokio::join!(open_over(io, &request, options()), peer.play());
    let mut opened = opened.expect("the thread resumes");
    let events = drain(&mut opened.events).await;
    assert_eq!(permission_shown(&events).as_deref(), Some("full-access"));

    let runtime = opened.runtime;
    let change = crate::SettingChange {
        generation: GENERATION,
        setting: crate::SettingKey::Permission,
        value: "own".to_owned(),
    };
    assert_eq!(
        runtime.change_setting(change).await,
        crate::SettingOutcome::Applied
    );
    let outcome = submit(&mut peer, &runtime, start_turn("sub-1", "Careful now")).await;
    assert!(matches!(outcome, DispatchOutcome::Acknowledged { .. }));
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
fn a_command_that_failed_after_a_stop_is_reported_as_such() {
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
                status: crate::ToolStatus::FailedAfterInterrupt,
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
    }
}

fn agent(
    read_files: bool,
    edit_files: bool,
    run_commands: bool,
    use_web: bool,
) -> crate::Unattended {
    let mut agent = unattended(edit_files, use_web);
    agent.tools.read_files = read_files;
    agent.tools.run_commands = run_commands;
    agent
}

/// Edit off is a read-only sandbox, Edit on writes only in the step's folder (the
/// ticketd tool needs no other), Run off removes Codex's shell, and with neither Edit
/// nor Run the agent has no environment at all: only ticketd's tool. "Read files"
/// changes nothing here: Codex reads through its shell, which only Run switches.
#[test]
fn the_switches_become_codex_sandbox_shell_and_environment_settings() {
    for (edit_files, run_commands, use_web) in [
        (false, false, false),
        (false, true, true),
        (true, false, false),
        (true, true, true),
    ] {
        let reading = |read_files| agent(read_files, edit_files, run_commands, use_web);
        assert_eq!(
            super::unattended_params(&reading(true), Path::new("/work/chat-1")),
            super::unattended_params(&reading(false), Path::new("/work/chat-1")),
            "reading is not a Codex setting"
        );
        let (thread, turn) = super::unattended_params(&reading(true), Path::new("/work/chat-1"));
        let policy = if edit_files {
            json!({
                "type": "workspaceWrite",
                "networkAccess": use_web,
                "writableRoots": ["/work/chat-1"],
                "excludeTmpdirEnvVar": true,
                "excludeSlashTmp": true,
            })
        } else {
            json!({"type": "readOnly", "networkAccess": use_web})
        };
        assert_eq!(
            thread,
            json!({
                "approvalPolicy": "on-request",
                "sandbox": if edit_files { "workspace-write" } else { "read-only" },
                "model": "gpt-test",
            })
        );
        assert_eq!(
            turn,
            json!({"approvalPolicy": "on-request", "sandboxPolicy": policy})
        );
        let overrides = super::switch_overrides(&reading(true).tools);
        assert_eq!(overrides["features.shell_tool"], json!(run_commands));
        assert_eq!(
            overrides.get("features.view_image"),
            (!run_commands).then_some(&json!(false))
        );
        assert_eq!(
            super::has_no_environment(&reading(true).tools),
            !edit_files && !run_commands
        );
    }
}

#[test]
fn a_command_policy_without_an_explicit_grant_leaves_the_codex_shell_disabled() {
    let mut agent = unattended(false, false);
    agent.tools.any_command = false;
    agent.tools.allowed_commands = vec!["fixture-command".into()];

    let overrides = super::switch_overrides(&agent.tools);
    assert_eq!(overrides["features.shell_tool"], json!(false));
    assert_eq!(overrides["features.view_image"], json!(false));
    assert!(super::has_no_environment(&agent.tools));
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
        recorded_settings: None,
        settings: StartSettings::default(),
    };
    let (opened, ()) = tokio::join!(open_over(io, &request, options()), peer.play());
    let mut opened = opened.expect("the thread opens");
    drain(&mut opened.events).await;

    submit(&mut peer, &opened.runtime, start_turn("sub-1", "Go")).await;

    match read_end(&drain(&mut opened.events).await) {
        Some(TurnOutcome::Failed(problem)) => {
            assert_eq!(problem.kind, ProblemKind::ToolDenied);
            assert!(problem.message.contains("curl example.com"), "{problem:?}");
        }
        other => panic!("a failed turn, got {other:?}"),
    }
}

async fn open_unattended(fixture: &str) -> Result<OpenedRuntime, Problem> {
    let (mut peer, io) = pipes();
    peer.load(fixture);
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::New,
        unattended: Some(unattended(false, false)),
        ticketd_cli: None,
        taken_over: false,
        recorded_settings: None,
        settings: StartSettings::default(),
    };
    tokio::join!(open_over(io, &request, options()), peer.play()).0
}

/// An unattended thread with the ticketd CLI opts into the experimental API, declares
/// ticketd's own tool and tells the agent to use it. The tool refuses what could leave
/// the run's Workspace or the step. Calls require the opened thread's ID and the
/// ticketd tool name. The early call uses invalid arguments so it can never spawn a CLI.
#[tokio::test(start_paused = true)]
async fn an_unattended_thread_declares_ticketds_own_tool_and_answers_only_it() {
    let (mut peer, _opened) =
        open_with_ticketd_tool(fixture!("unattended_ticket_tool"), unattended(true, false)).await;

    // Every call in the rest of the script is answered as it is written.
    peer.play().await;
    peer.assert_nothing_written().await;
}

/// With neither Run commands nor Edit files on, the agent has no shell, a read-only
/// sandbox and no Codex environment at all: only ticketd's tool is left.
#[tokio::test(start_paused = true)]
async fn an_agent_with_run_and_edit_off_gets_no_shell_and_no_environment() {
    let (_peer, _opened) = open_with_ticketd_tool(
        fixture!("unattended_no_environment"),
        agent(true, false, false, false),
    )
    .await;
}

#[cfg(unix)]
#[tokio::test]
async fn excess_ticketd_calls_get_a_busy_result_while_rpc_stays_live() {
    use std::{fs, os::unix::fs::PermissionsExt};

    let directory = tempfile::tempdir().unwrap();
    let working_directory = directory.path();
    let cli = working_directory.join("fixture-cli");
    fs::write(
        &cli,
        concat!(
            "#!/bin/sh\n",
            ": > \"started-$1\"\n",
            "while [ ! -f release ]; do sleep 0.01; done\n",
            "printf 'fixture output %s' \"$1\"\n",
        ),
    )
    .unwrap();
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
    let (mut peer, opened) = open_with_ticketd_tool_at(
        fixture!("unattended_ticket_tool"),
        unattended(true, false),
        working_directory,
        cli,
    )
    .await;

    let call = |id: u32| {
        format!(
            "{}\n",
            json!({"id": format!("cli-{id}"), "method": "item/tool/call", "params": {
                "threadId": "thr_1", "turnId": "turn_1", "callId": format!("call-{id}"),
                "namespace": null, "tool": "ticketd", "arguments": {"arguments": [id.to_string()]},
            }})
        )
    };
    let (outcome, ()) = tokio::join!(opened.runtime.submit(start_turn("sub-1", "Go")), async {
        let start = peer.written().await;
        assert_eq!(start["method"], "turn/start");
        for id in 1..=5 {
            peer.send(&call(id)).await;
        }
        let busy = peer.written().await;
        assert_eq!(busy["id"], "cli-5");
        assert_eq!(busy["result"]["success"], false);
        assert!(
            busy["result"]["contentItems"][0]["text"]
                .as_str()
                .unwrap()
                .contains("busy")
        );
        peer.send(&format!(
            "{}\n",
            json!({"id": start["id"], "result": {"turn": {"id": "turn_1", "status": "inProgress"}}})
        ))
        .await;
    });
    assert_eq!(
        outcome,
        DispatchOutcome::Acknowledged {
            turn: turn("turn_1")
        }
    );

    fs::write(working_directory.join("release"), "").unwrap();
    let mut completed = Vec::new();
    for _ in 1..=4 {
        let reply = peer.written().await;
        assert_eq!(reply["result"]["success"], true, "{reply}");
        let id = reply["id"].as_str().unwrap();
        let number = id.strip_prefix("cli-").unwrap();
        assert_eq!(
            reply["result"]["contentItems"][0]["text"],
            format!("fixture output {number}")
        );
        completed.push(number.to_owned());
    }
    completed.sort();
    assert_eq!(completed, ["1", "2", "3", "4"]);
    assert!(!working_directory.join("started-5").exists());

    peer.send(&call(6)).await;
    let retry = peer.written().await;
    assert_eq!(retry["id"], "cli-6");
    assert_eq!(retry["result"]["success"], true, "{retry}");
}

/// Opens an unattended thread for `agent` with the ticketd CLI over a fixture that
/// holds `$CONFIG`, `$SPEC` and `$INSTRUCTIONS` where ticketd fills in what it sends.
async fn open_with_ticketd_tool(fixture: &str, agent: crate::Unattended) -> (Peer, OpenedRuntime) {
    open_with_ticketd_tool_at(
        fixture,
        agent,
        Path::new("/work/chat-1"),
        PathBuf::from("/bin/ticketd"),
    )
    .await
}

async fn open_with_ticketd_tool_at(
    fixture: &str,
    agent: crate::Unattended,
    working_directory: &Path,
    cli: PathBuf,
) -> (Peer, OpenedRuntime) {
    let mut config = super::personal_tools_off(None);
    let switches = super::switch_overrides(&agent.tools);
    config
        .as_object_mut()
        .unwrap()
        .extend(switches.as_object().unwrap().clone());
    let script = fixture
        .replace("\"/work/chat-1\"", &json!(working_directory).to_string())
        .replace("$CONFIG", &config.to_string())
        .replace("$SPEC", &super::ticket_tool::spec().to_string())
        .replace(
            "$INSTRUCTIONS",
            &json!(super::ticket_tool::INSTRUCTIONS).to_string(),
        );
    let (mut peer, io) = pipes();
    peer.load(&script);
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: working_directory.to_owned(),
        session: SessionStart::New,
        unattended: Some(agent),
        ticketd_cli: Some(cli),
        taken_over: false,
        recorded_settings: None,
        settings: StartSettings::default(),
    };
    let (opened, ()) = tokio::join!(open_over(io, &request, options()), peer.play());
    (peer, opened.expect("the thread opens"))
}

/// The agent's ticketd tool call shows as the command it asked for, with its output.
#[test]
fn a_ticketd_tool_call_shows_as_the_command_with_its_output() {
    let mut session = Session::default();
    let item = json!({"type": "dynamicToolCall", "id": "item_3", "tool": "ticketd", "namespace": null,
        "arguments": {"arguments": ["show", "T-1"]}, "status": "completed", "success": true,
        "contentItems": [{"type": "inputText", "text": "T-1 Fix it"}]});
    let params = json!({"turnId": "turn_1", "item": item});
    match session.notification("item/completed", &params).as_slice() {
        [
            EventKind::ToolUpdated {
                title,
                output,
                status,
                ..
            },
        ] => {
            assert_eq!(title, "ticketd show T-1");
            assert_eq!(output.as_deref(), Some("T-1 Fix it"));
            assert_eq!(*status, crate::ToolStatus::Succeeded);
        }
        other => panic!("one tool update, got {other:?}"),
    }
}

/// A person's Chat, taken over or not, declares no tool and opts into nothing.
#[tokio::test(start_paused = true)]
async fn a_persons_chat_declares_no_tool_and_stays_off_the_experimental_api() {
    let (_peer, opened) = open_with(fixture!("handshake"), SessionStart::New).await;
    // The handshake fixture asks for no capabilities, so it fails if any were sent.
    assert!(opened.is_ok());
}

/// On Windows an unattended run asks Codex whether its sandbox can start, and a
/// Codex that says it cannot fails the run before any thread starts.
#[tokio::test(start_paused = true)]
async fn an_unattended_run_fails_at_once_when_the_windows_sandbox_is_not_ready() {
    let Err(problem) = open_unattended(fixture!("unattended_sandbox_not_ready")).await else {
        panic!("the run fails");
    };
    assert_eq!(
        problem.message,
        "Codex could not start its sandbox on this computer. Update Codex (`codex update`) and try again."
    );
}

/// A Codex that does not know the readiness method is carried on with as before.
#[tokio::test(start_paused = true)]
async fn a_codex_without_the_readiness_method_is_not_blocked() {
    assert!(
        open_unattended(fixture!("unattended_readiness_unknown"))
            .await
            .is_ok()
    );
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
        match read_end(&session.notification("turn/completed", &turn)) {
            Some(outcome) => outcome,
            None => panic!("the turn ended"),
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

/// The adapter reports what Codex said and what it saw; it does not decide that the
/// turn failed. That is the supervisor's rule (see `outcome`).
#[test]
fn a_declined_tool_is_reported_as_evidence_and_the_outcome_stays_codexs() {
    let mut session = Session::default();
    session.turn_overrides = Some(json!({}));
    let item = json!({"type": "commandExecution", "id": "c_1", "command": "curl example.com",
        "status": "declined"});
    session.notification("item/completed", &json!({"turnId": "turn_1", "item": item}));

    let events = session.notification(
        "turn/completed",
        &json!({"turn": {"id": "turn_1", "status": "completed"}}),
    );

    assert_eq!(
        events.iter().map(brief).collect::<Vec<_>>(),
        [
            "turn-evidence turn_1 denied \"Codex could not run curl example.com.\"",
            "turn-ended turn_1 Completed []"
        ]
    );
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
        match read_end(&session.notification("turn/completed", &turn)) {
            Some(outcome) => outcome,
            None => panic!("the turn ended"),
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
        match read_end(&session.notification("turn/completed", &turn)) {
            Some(TurnOutcome::Failed(problem)) => problem.message,
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
/// their configuration), plugins or apps, and runs none of their hooks, notify
/// program, project instructions, memories, sub-agents, computer or browser use, or
/// skills that Codex lets a thread switch off.
#[test]
fn an_unattended_thread_turns_off_what_codex_lets_it_of_the_persons_setup() {
    let always = json!({
        "features.plugins": false,
        "features.apps": false,
        "features.hooks": false,
        "features.memories": false,
        "agents.enabled": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
        "features.computer_use": false,
        "features.browser_use": false,
        "notify": [],
        "project_doc_max_bytes": 0,
        "skills.bundled.enabled": false,
        "skills.include_instructions": false,
    });
    let config =
        json!({"mcp_servers": {"docs": {"command": "docs-mcp"}, "web": {"url": "https://x"}}});
    let mut with_servers = always.clone();
    with_servers["mcp_servers.docs.enabled"] = json!(false);
    with_servers["mcp_servers.web.enabled"] = json!(false);
    assert_eq!(super::personal_tools_off(Some(&config)), with_servers);
    assert_eq!(super::personal_tools_off(None), always);
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
        recorded_settings: None,
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

/// The thread of a run keeps the ticketd tool Codex was given, so the Chat the person
/// took over still answers it, without declaring anything on resume.
#[tokio::test(start_paused = true)]
async fn a_taken_over_chat_still_answers_the_ticketd_tool() {
    let (mut peer, io) = pipes();
    peer.load(fixture!("resume_taken_over_tool"));
    let request = OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::Resume(NativeSessionId::new("thr_1")),
        unattended: None,
        ticketd_cli: Some(PathBuf::from("/bin/ticketd")),
        taken_over: true,
        recorded_settings: None,
        settings: StartSettings::default(),
    };
    let (opened, ()) = tokio::join!(open_over(io, &request, options()), peer.play());
    let _opened = opened.expect("the thread resumes");
    peer.play().await;
    peer.assert_nothing_written().await;
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
        recorded_settings: None,
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
    let permission = "permission=own[\"own\", \"full-access\"]";
    assert_eq!(
        settings.iter().map(brief).collect::<Vec<_>>(),
        [
            "session thr_1".to_owned(),
            // Before the lists: the thread's own answer, with no model choices.
            format!("settings model=gpt-a[] {permission}"),
            "notice EffectiveSettings".to_owned(),
            // Hidden models are not choices; efforts are the current model's, in order.
            format!("settings {models} {permission}"),
            format!("settings {models} {permission}"),
            format!("settings {models} {permission}"),
        ]
    );
    let Some(EventKind::SettingsState(last)) = settings.last() else {
        panic!("settings last, got {settings:?}");
    };
    let full = &last.permission.as_ref().expect("permission").options[1];
    assert!(
        !full.allowed,
        "Codex's requirements refuse the no-sandbox profile, so Full access too"
    );

    let runtime = opened.runtime;
    let change = |setting, value: &str| crate::SettingChange {
        generation: GENERATION,
        setting,
        value: value.to_owned(),
    };
    assert_eq!(runtime.supports_image_input(), Some(true));
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
    let image = ticketd_core::ChatAttachmentContent::from_image_data_url(
        "Screenshot.png",
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
    ).unwrap();
    let refused = runtime
        .submit(Submission {
            attachments: vec![image.clone()],
            ..start_turn("with-attachment", "Look at this")
        })
        .await;
    assert_eq!(
        refused,
        DispatchOutcome::NotSent(Refusal::ImageInputUnsupported)
    );
    peer.assert_nothing_written().await;
    // Nothing was written for the change: the next turn carries it.
    let outcome = submit(&mut peer, &runtime, start_turn("sub-1", "Go")).await;
    assert_eq!(
        outcome,
        DispatchOutcome::Acknowledged {
            turn: turn("turn_1")
        }
    );
    assert_eq!(
        runtime
            .change_setting(change(crate::SettingKey::Model, "gpt-a"))
            .await,
        crate::SettingOutcome::Applied
    );
    assert_eq!(runtime.supports_image_input(), Some(true));
    assert_eq!(runtime.supports_steer_image_input(), Some(false));
    assert_eq!(
        runtime
            .submit(Submission {
                attachments: vec![image.clone()],
                ..steer("unsupported-steer", "turn_1", "Look at this")
            })
            .await,
        DispatchOutcome::NotSent(Refusal::ImageInputUnsupported)
    );
    peer.assert_nothing_written().await;
    assert_eq!(
        runtime
            .change_setting(change(crate::SettingKey::Model, "gpt-b"))
            .await,
        crate::SettingOutcome::Applied
    );
    let rerouted = json!({"method": "model/rerouted", "params": {
        "threadId": "thr_1", "turnId": "turn_1", "fromModel": "gpt-b", "toModel": "gpt-a"
    }});
    peer.send(&format!("{rerouted}\n")).await;
    drain(&mut opened.events).await;
    assert_eq!(runtime.supports_image_input(), Some(false));
    assert_eq!(runtime.supports_steer_image_input(), Some(true));
    let (outcome, ()) = tokio::join!(
        runtime.submit(Submission {
            attachments: vec![image],
            ..steer("with-attachment", "turn_1", "Look at this")
        }),
        async {
            let written = peer.written().await;
            assert_eq!(written["method"], "turn/steer");
            assert_eq!(written["params"]["input"][1]["type"], "image");
            let reply = json!({"id": written["id"], "result": {"turnId": "turn_1"}});
            peer.send(&format!("{reply}\n")).await;
        }
    );
    assert_eq!(
        outcome,
        DispatchOutcome::Acknowledged {
            turn: turn("turn_1")
        }
    );
}

#[test]
fn image_steering_uses_the_active_turn_model_and_observes_model_updates() {
    let mut session = Session::default();
    session
        .reports
        .thread_opened(&json!({"model": "text-only"}));
    session.reports.models_listed(Ok(&json!({"data": [
        {"id": "text-only", "inputModalities": ["text"]},
        {"id": "vision", "inputModalities": ["text", "image"]}
    ]})));
    session
        .reports
        .override_setting(crate::SettingKey::Model, "vision");
    session.reports.turn_start_written();
    session.notification("turn/started", &json!({"turn": {"id": "turn_1"}}));
    session
        .reports
        .override_setting(crate::SettingKey::Model, "text-only");

    assert_eq!(session.reports.supports_image_input(false), Some(false));
    assert_eq!(session.reports.supports_image_input(true), Some(true));

    session.notification(
        "thread/settings/updated",
        &json!({
            "threadSettings": {"model": "text-only"}
        }),
    );
    assert_eq!(session.reports.supports_image_input(true), Some(false));
}

#[test]
fn open_refuses_a_codex_below_the_floor_with_the_picker_reason() {
    let problem = super::too_old("codex-cli 0.162.1\n").unwrap();
    assert_eq!(problem.kind, ProblemKind::IncompatibleVersion);
    assert_eq!(
        problem.message,
        "ticketd needs Codex 0.163.0 or newer (run `codex update`)."
    );
    assert!(super::too_old("codex-cli 0.163.0").is_none());
    assert!(super::too_old("codex-cli unknown").is_none());
}

/// Codex app-server as the conformance suite's provider: it plays app-server's side
/// of each scenario.
pub(crate) struct AppServer {
    peer: Peer,
    runtime: Arc<dyn HarnessRuntime>,
    events: EventStream,
    /// The id of the next request the adapter writes.
    next_request: u32,
}

pub(crate) async fn provider() -> Box<dyn Provider> {
    let (peer, runtime, events) = open().await;
    Box::new(AppServer {
        peer,
        runtime,
        events,
        next_request: 3,
    })
}

impl AppServer {
    fn request(&mut self) -> u32 {
        self.next_request += 1;
        self.next_request - 1
    }

    /// The `turn/start` request the adapter writes for `id`, as a transcript line.
    fn started(&mut self, id: &str) -> (u32, String) {
        let request = self.request();
        let line = format!(
            r#"{{"client":{{"id":{request},"method":"turn/start","params":{{"threadId":"thr_1","clientUserMessageId":"{id}","input":[{{"type":"text","text":"hello","text_elements":[]}}]}}}}}}"#
        );
        (request, line)
    }
}

#[async_trait]
impl Provider for AppServer {
    fn new_turn(&self) -> NewTurn {
        NewTurn::Acknowledged
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

    fn sub_agent_approvals(&self) -> SubAgentApprovals {
        SubAgentApprovals::Owned
    }

    async fn play_sub_agent_approval(&mut self, _id: &str) -> NativeRequestId {
        self.peer.load(
            r#"{"server":{"method":"turn/started","params":{"threadId":"thr_a","turn":{"id":"turn_2","rootTurnId":"turn_1","items":[],"itemsView":"notLoaded","status":"inProgress","error":null}}}}
{"server":{"id":0,"method":"item/commandExecution/requestApproval","params":{"threadId":"thr_a","turnId":"turn_2","itemId":"exec_1","startedAtMs":1,"command":"touch notes.txt","cwd":"/work/chat-1","reason":"Needs approval"}}}"#,
        );
        self.peer.play().await;
        let shown = drain(&mut self.events).await;
        shown
            .into_iter()
            .find_map(|event| match event {
                EventKind::InteractionRequested(request) => {
                    assert_eq!(request.turn, None, "a sub-agent's request has no turn");
                    assert_eq!(
                        request.owner,
                        Some(crate::NativeSubAgentId::new("thr_a")),
                        "it names the child thread"
                    );
                    Some(request.request)
                }
                _ => None,
            })
            .expect("app-server asked on the child's behalf")
    }

    async fn end_parent_turn(&mut self, _id: &str) {
        self.peer.load(
            r#"{"server":{"method":"turn/completed","params":{"threadId":"thr_1","turn":{"id":"turn_1","status":"completed","items":[],"error":null}}}}"#,
        );
        self.peer.play().await;
    }

    async fn end_sub_agent(&mut self) {
        self.peer.load(
            r#"{"server":{"method":"turn/completed","params":{"threadId":"thr_a","turn":{"id":"turn_2","status":"interrupted","items":[],"error":null}}}}"#,
        );
        self.peer.play().await;
    }

    async fn start_turn(&mut self, id: &str) -> DispatchOutcome {
        let (request, client) = self.started(id);
        let turn = r#"{"id":"turn_1","status":"inProgress","items":[],"error":null}"#;
        self.peer.load(&format!(
            r#"{client}
{{"server":{{"method":"turn/started","params":{{"threadId":"thr_1","turn":{turn}}}}}}}
{{"server":{{"id":{request},"result":{{"turn":{turn}}}}}}}
"#
        ));
        submit(&mut self.peer, &self.runtime, start_turn(id, "hello")).await
    }

    async fn show_processing(&mut self, _id: &str) -> NativeTurnId {
        unreachable!("Codex acknowledges a new turn")
    }

    async fn submit_unanswered(&mut self, id: &str) -> DispatchOutcome {
        let (_, client) = self.started(id);
        self.peer.load(&client);
        submit(&mut self.peer, &self.runtime, start_turn(id, "hello")).await
    }

    async fn refuse_late(&mut self, _id: &str) {
        // The refusal answers the request that carried the input: the last one.
        let request = self.next_request - 1;
        self.peer.load(&format!(
            r#"{{"server":{{"id":{request},"error":{{"code":-32600,"message":"server is shutting down","data":{{"reason":"serverShuttingDown"}}}}}}}}"#
        ));
        self.peer.play().await;
    }

    async fn submit_and_lose_process(&mut self, id: &str) -> DispatchOutcome {
        let (_, client) = self.started(id);
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
            r#"{"server":{"id":0,"method":"item/commandExecution/requestApproval","params":{"threadId":"thr_1","turnId":"turn_1","itemId":"item_2","startedAtMs":2,"command":"ls","cwd":"/work/chat-1","reason":"Needs approval"}}}"#,
        );
        self.peer.play().await;
        drain(&mut self.events)
            .await
            .into_iter()
            .find_map(|event| match event {
                EventKind::InteractionRequested(request) => Some(request.request),
                _ => None,
            })
            .expect("app-server asked for approval")
    }

    async fn respond(&mut self, response: InteractionResponse) -> RespondOutcome {
        let (outcome, frame) = tokio::join!(
            self.runtime.respond(response),
            timeout(Duration::from_millis(100), self.peer.written())
        );
        if outcome == RespondOutcome::Sent {
            let expected = json!({"id": 0, "result": {"decision": "accept"}});
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
