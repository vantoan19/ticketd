use std::{path::PathBuf, time::Duration};

use serde_json::{Value, json};

use crate::conformance::{GENERATION, drain, open_request, start_turn};
use crate::scripted::{Peer, pipes};
use crate::{
    DispatchOutcome, EventKind, HarnessSettings, InteractionAnswer, InteractionKind,
    InteractionResponse, NativeSessionId, OpenRequest, OpenedRuntime, ProblemKind, Refusal,
    RespondOutcome, SessionStart, SettingChange, SettingKey, SettingOutcome, TurnOutcome,
};

use super::{ANTIGRAVITY, runtime, settings};

const PROMPT: &str = include_str!("../../tests/fixtures/antigravity/prompt.jsonl");
const QUESTION: &str = include_str!("../../tests/fixtures/antigravity/question.jsonl");
const MODES: &str = include_str!("../../tests/fixtures/antigravity/session-modes.jsonl");
const RESUME: &str = include_str!("../../tests/fixtures/antigravity/resume-own-settings.jsonl");
const MISSING_RESUME: &str =
    include_str!("../../tests/fixtures/antigravity/resume-missing-session.jsonl");
const SIGNED_OUT: &str = include_str!("../../tests/fixtures/antigravity/signed-out.jsonl");
const QUOTA_DIAGNOSTIC: &str = "\n⚠ agent executor error: generating and executing: Error 429, Message: Synthetic fixture quota exhausted for this test., Status: RESOURCE_EXHAUSTED, Details: []\n";

#[cfg(unix)]
#[tokio::test]
async fn inspection_disables_auto_updates_for_its_version_probe() {
    use std::fs::{self, Permissions};
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    use crate::{HarnessAdapter, Inspection};

    const CHILD: &str = "TICKETD_TEST_ANTIGRAVITY_VERSION_PROBE";
    const TEST: &str = "antigravity::tests::inspection_disables_auto_updates_for_its_version_probe";
    if std::env::var_os(CHILD).is_some() {
        let inspection = super::Antigravity.inspect().await;
        assert!(
            matches!(
                &inspection,
                Inspection::Installed { version: Some(version), .. } if version == "agy 1.5.15"
            ),
            "{inspection:?}"
        );
        assert_eq!(std::env::var("AGY_CLI_DISABLE_AUTO_UPDATE").unwrap(), "0");
        return;
    }

    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("agy");
    fs::write(
        &executable,
        "#!/bin/sh\n[ \"$1\" = --version ] || exit 2\n\
         [ \"$AGY_CLI_DISABLE_AUTO_UPDATE\" = 1 ] || exit 3\n\
         [ \"$TICKETD_TEST_ANTIGRAVITY_VERSION_PROBE\" = inherited ] || exit 4\n\
         printf 'agy 1.5.15\\n'\n",
    )
    .unwrap();
    fs::set_permissions(&executable, Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST])
        .env("PATH", directory.path())
        .env("HOME", directory.path())
        .env(CHILD, "inherited")
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "0")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr),
    );
}

#[cfg(unix)]
#[tokio::test]
async fn inspection_rejects_oversized_version_output_on_either_stream() {
    use std::fs::{self, Permissions};
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    use crate::{HarnessAdapter, Inspection};

    const CHILD: &str = "TICKETD_TEST_ANTIGRAVITY_VERSION_OUTPUT_DIRECTORY";
    const TEST: &str =
        "antigravity::tests::inspection_rejects_oversized_version_output_on_either_stream";
    const BUDGET: usize = 64 * 1024;
    if let Some(directory) = std::env::var_os(CHILD) {
        let directory = PathBuf::from(directory);
        let stdout = directory.join("stdout");
        let stderr = directory.join("stderr");
        let mut version = b"agy 1.5.15\n".to_vec();
        version.resize(BUDGET, b' ');
        fs::write(&stdout, &version).unwrap();
        fs::write(&stderr, vec![b' '; BUDGET]).unwrap();
        assert!(matches!(
            super::Antigravity.inspect().await,
            Inspection::Installed { version: Some(version), .. } if version == "agy 1.5.15"
        ));

        version.push(b' ');
        fs::write(&stdout, &version).unwrap();
        let oversized_stdout = super::Antigravity.inspect().await;
        fs::write(&stdout, b"agy 1.5.15\n").unwrap();
        fs::write(&stderr, vec![b' '; BUDGET + 1]).unwrap();
        let oversized_stderr = super::Antigravity.inspect().await;
        assert_eq!(
            [oversized_stdout, oversized_stderr].map(|inspection| matches!(
                inspection,
                Inspection::ProbeFailed { reason } if reason.contains("exceeded 65536 bytes")
            )),
            [true, true],
            "both streams must reject a byte beyond the budget"
        );
        return;
    }

    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("agy");
    fs::write(
        &executable,
        "#!/bin/sh\n[ \"$1\" = --version ] || exit 2\n\
         /bin/cat \"${0%/*}/stderr\" >&2 || exit 3\n\
         exec /bin/cat \"${0%/*}/stdout\"\n",
    )
    .unwrap();
    fs::set_permissions(&executable, Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST])
        .env("PATH", directory.path())
        .env("HOME", directory.path())
        .env(CHILD, directory.path())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr),
    );
}

fn recorded(fixture: &str) -> Vec<Value> {
    fixture
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

async fn send(peer: &mut Peer, frame: &Value) {
    peer.send(&format!("{frame}\n")).await;
}

fn text_update(kind: &str, text: &str) -> Value {
    json!({
        "jsonrpc": "2.0", "method": "session/update",
        "params": {"sessionId": "session-1", "update": {
            "sessionUpdate": kind, "content": {"type": "text", "text": text}
        }}
    })
}

fn request(session: SessionStart) -> OpenRequest {
    OpenRequest {
        working_directory: PathBuf::from("/workspace"),
        session,
        ..open_request()
    }
}

/// Play an actual startup, excluding the recorder's synthetic authentication.
async fn open(fixture: &str, start: SessionStart, mode: &str) -> (Peer, OpenedRuntime) {
    let (mut peer, io) = pipes();
    let opening = tokio::spawn(runtime::open(io, request(start), mode.to_owned()));
    startup(&mut peer, fixture).await;
    (peer, opening.await.unwrap().unwrap())
}

async fn startup(peer: &mut Peer, fixture: &str) {
    let frames = recorded(fixture);
    for pair in frames.as_chunks::<2>().0 {
        let expected = &pair[0]["client"];
        match expected["method"].as_str() {
            Some("initialize" | "session/new" | "session/resume") => {
                let actual = peer.written().await;
                assert_eq!(actual["method"], expected["method"]);
                if actual["method"] == "initialize" {
                    let params = &actual["params"];
                    assert_eq!(params["protocolVersion"], 1);
                    assert_eq!(params["clientInfo"]["name"], "ticketd");
                    assert_eq!(params["clientInfo"]["version"], env!("CARGO_PKG_VERSION"));
                    assert_eq!(params["clientCapabilities"]["terminal"], false);
                    assert_eq!(params["clientCapabilities"]["fs"]["readTextFile"], false);
                    assert_eq!(params["clientCapabilities"]["fs"]["writeTextFile"], false);
                } else {
                    assert_eq!(actual["params"]["cwd"], "/workspace");
                    assert_eq!(
                        actual["params"]["sessionId"],
                        expected["params"]["sessionId"]
                    );
                    if let Some(mcp) = actual["params"].get("mcpServers") {
                        assert_eq!(mcp, &json!([]));
                    }
                }
                let mut reply = pair[1]["server"].clone();
                reply["id"] = actual["id"].clone();
                send(peer, &reply).await;
            }
            Some("authenticate") => {}
            _ => break,
        }
    }
}

#[tokio::test]
async fn recorded_acp_turn_uses_a_plain_prompt_and_finishes_on_its_reply() {
    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    let mut input = start_turn("capture");
    input.text = "Return the synthetic fixture word.".to_owned();
    assert_eq!(opened.runtime.submit(input).await, DispatchOutcome::Written);
    let frames = recorded(PROMPT);
    let prompt_index = frames
        .iter()
        .position(|frame| frame["client"]["method"] == "session/prompt")
        .unwrap();
    let outgoing = peer.written().await;
    assert_eq!(outgoing["params"], frames[prompt_index]["client"]["params"]);
    assert!(matches!(
        opened.runtime.submit(start_turn("overlap")).await,
        DispatchOutcome::NotSent(_),
    ));
    for entry in &frames[prompt_index + 1..frames.len() - 1] {
        send(&mut peer, &entry["server"]).await;
    }
    let before_reply = drain(&mut opened.events).await;
    assert!(before_reply.iter().any(|kind| matches!(kind, EventKind::TextDelta { text, .. } if text == "Synthetic ACP model fixture")));
    assert!(
        !before_reply
            .iter()
            .any(|kind| matches!(kind, EventKind::TurnEnded { .. }))
    );
    let mut reply = frames.last().unwrap()["server"].clone();
    reply["id"] = outgoing["id"].clone();
    send(&mut peer, &reply).await;
    assert!(drain(&mut opened.events).await.iter().any(|kind| matches!(
        kind,
        EventKind::TurnEnded {
            outcome: TurnOutcome::Completed,
            ..
        }
    )));
    opened.runtime.close().await;
}

#[tokio::test]
async fn recorded_acp_quota_diagnostic_ends_the_turn_with_native_wording() {
    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    assert_eq!(
        opened.runtime.submit(start_turn("quota")).await,
        DispatchOutcome::Written
    );
    let outgoing = peer.written().await;
    // Antigravity 1.5.15 sends this complete chunk followed by an ordinary end_turn.
    send(
        &mut peer,
        &text_update("agent_message_chunk", QUOTA_DIAGNOSTIC),
    )
    .await;
    send(
        &mut peer,
        &json!({"jsonrpc": "2.0", "id": outgoing["id"], "result": {"stopReason": "end_turn"}}),
    )
    .await;

    let events = drain(&mut opened.events).await;
    assert!(
        matches!(
            events.as_slice(),
            [.., EventKind::MessageCompleted { text, .. },
                EventKind::TurnEnded { outcome: TurnOutcome::Failed(problem), .. }]
                if text == QUOTA_DIAGNOSTIC
                    && problem.kind == ProblemKind::QuotaExhausted
                    && problem.message == QUOTA_DIAGNOSTIC
                    && problem.resets_at.is_none()
        ),
        "{events:?}"
    );
    opened.runtime.close().await;
}

#[tokio::test]
async fn acp_quota_diagnostic_respects_chunk_boundaries_and_explicit_outcomes() {
    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    let prose = format!("This is an example of an HTTP 429 warning:{QUOTA_DIAGNOSTIC}");
    let diagnostic = text_update("agent_message_chunk", QUOTA_DIAGNOSTIC);
    let end_turn = json!({"result": {"stopReason": "end_turn"}});
    let cases = [
        (
            "discussion",
            vec![text_update("agent_message_chunk", &prose)],
            end_turn.clone(),
            TurnOutcome::Completed,
        ),
        (
            "reasoning",
            vec![text_update("agent_thought_chunk", QUOTA_DIAGNOSTIC)],
            end_turn.clone(),
            TurnOutcome::Completed,
        ),
        (
            "later-answer",
            vec![
                diagnostic.clone(),
                text_update("agent_message_chunk", "Here is the answer."),
            ],
            end_turn,
            TurnOutcome::Completed,
        ),
        (
            "cancelled",
            vec![diagnostic.clone()],
            json!({"result": {"stopReason": "cancelled"}}),
            TurnOutcome::Interrupted,
        ),
        (
            "error",
            vec![diagnostic],
            json!({"error": {"code": -32603, "message": "Synthetic internal error"}}),
            TurnOutcome::Failed(crate::Problem {
                kind: ProblemKind::Other,
                message: "Synthetic internal error".to_owned(),
                detail: None,
                resets_at: None,
            }),
        ),
    ];
    for (id, updates, mut reply, expected) in cases {
        assert_eq!(
            opened.runtime.submit(start_turn(id)).await,
            DispatchOutcome::Written
        );
        reply["jsonrpc"] = json!("2.0");
        reply["id"] = peer.written().await["id"].clone();
        for update in updates {
            send(&mut peer, &update).await;
        }
        send(&mut peer, &reply).await;
        let events = drain(&mut opened.events).await;
        assert_eq!(crate::outcome::read_end(&events), Some(expected), "{id}");
    }
    opened.runtime.close().await;
}

#[tokio::test]
async fn many_thought_chunks_keep_bounded_checkpoints_and_exact_final_reasoning() {
    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    assert_eq!(
        opened.runtime.submit(start_turn("thinking")).await,
        DispatchOutcome::Written
    );
    let outgoing = peer.written().await;
    send(&mut peer, &text_update("agent_thought_chunk", "α\n")).await;
    for _ in 0..192 {
        send(&mut peer, &text_update("agent_thought_chunk", "β ")).await;
    }
    send(
        &mut peer,
        &text_update("agent_message_chunk", "I have an answer."),
    )
    .await;
    send(
        &mut peer,
        &text_update("agent_thought_chunk", "\nFinal detail 🧩"),
    )
    .await;
    send(
        &mut peer,
        &json!({"jsonrpc": "2.0", "id": outgoing["id"], "result": {"stopReason": "end_turn"}}),
    )
    .await;

    let events = tokio::time::timeout(Duration::from_secs(5), async {
        let mut events = Vec::new();
        while let Some(event) = opened.events.recv().await {
            let ended = matches!(event.kind, EventKind::TurnEnded { .. });
            events.push(event.kind);
            if ended {
                break;
            }
        }
        events
    })
    .await
    .expect("the prompt reply ends the turn");
    let checkpoints = events
        .iter()
        .filter_map(|event| match event {
            EventKind::ReasoningUpdated {
                running: true,
                text: Some(text),
                ..
            } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let before_answer = format!("α\n{}", "β ".repeat(192));
    assert!(
        (2..=12).contains(&checkpoints.len()),
        "expected periodic checkpoints for 193 chunks, got {}",
        checkpoints.len()
    );
    assert_eq!(checkpoints[0], "α\n");
    assert!(
        checkpoints
            .windows(2)
            .all(|pair| { pair[0].len() < pair[1].len() && pair[1].starts_with(pair[0]) })
    );
    let answer_at = events
        .iter()
        .position(|event| matches!(event, EventKind::TextDelta { text, .. } if text == "I have an answer."))
        .expect("the answer is streamed");
    assert!(matches!(
        &events[answer_at - 1],
        EventKind::ReasoningUpdated { running: true, text: Some(text), .. } if text == &before_answer
    ));
    assert!(matches!(
        &events[events.len() - 2..],
        [EventKind::ReasoningUpdated { running: false, text: Some(text), .. },
         EventKind::TurnEnded { outcome: TurnOutcome::Completed, .. }]
            if text == &format!("{before_answer}\nFinal detail 🧩")
    ));
    opened.runtime.close().await;
}

#[tokio::test]
async fn losing_the_acp_process_preserves_thoughts_observed_before_contact_ended() {
    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    assert_eq!(
        opened.runtime.submit(start_turn("loss")).await,
        DispatchOutcome::Written
    );
    assert_eq!(peer.written().await["method"], "session/prompt");
    send(&mut peer, &text_update("agent_thought_chunk", "First")).await;
    send(
        &mut peer,
        &text_update("agent_thought_chunk", " still thinking…"),
    )
    .await;
    peer.exit(19);

    let events = tokio::time::timeout(Duration::from_secs(5), async {
        let mut events = Vec::new();
        while let Some(event) = opened.events.recv().await {
            events.push(event.kind);
        }
        events
    })
    .await
    .expect("the event stream closes after the process exits");
    assert!(
        matches!(
            &events[events.len() - 2..],
            [EventKind::ReasoningUpdated { running: true, text: Some(text), .. },
             EventKind::RuntimeLost { exit_code: Some(19), .. }]
                if text == "First still thinking…"
        ),
        "missing the full observed reasoning before loss: {events:?}"
    );
}

#[tokio::test]
async fn large_tool_updates_keep_bounded_output_and_file_changes_until_completion() {
    use ticketd_core::{CHAT_TOOL_OUTPUT_LIMIT, ChatToolState, harnesses::ANTIGRAVITY};

    use crate::{
        FileChange, FileChangeKind, FileTargets, LineCounts, StepAction, ToolEvidence, ToolStatus,
        read_tool_steps,
    };

    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    assert_eq!(
        opened.runtime.submit(start_turn("large-edit")).await,
        DispatchOutcome::Written
    );
    let outgoing = peer.written().await;
    let update = |update| {
        json!({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": "session-1", "update": update}
        })
    };

    for (tool, path) in [("edit-1", "/workspace/one"), ("edit-2", "/workspace/two")] {
        let line = format!("{}:fixture tail\n", "é".repeat(CHAT_TOOL_OUTPUT_LIMIT / 2));
        send(
            &mut peer,
            &update(json!({
                "sessionUpdate": "tool_call",
                "toolCallId": tool,
                "title": "Write file",
                "kind": "edit",
                "status": "in_progress",
                "rawInput": {"TargetFile": path, "ReplacementContent": &line},
                "rawOutput": {"output": &line, "unneeded": &line},
                "content": [{"type": "diff", "path": path, "newText": format!("{line}second line\n")}]
            })),
        )
        .await;
    }
    for tool in ["edit-1", "edit-2"] {
        send(
            &mut peer,
            &update(json!({
                "sessionUpdate": "tool_call_update", "toolCallId": tool, "status": "completed"
            })),
        )
        .await;
    }
    send(
        &mut peer,
        &json!({"jsonrpc": "2.0", "id": outgoing["id"], "result": {"stopReason": "end_turn"}}),
    )
    .await;

    let mut completed = Vec::new();
    let mut files = Vec::new();
    let mut tool_updates = 0;
    loop {
        match opened.events.recv().await.unwrap().kind {
            EventKind::ToolUpdated {
                item,
                title,
                output,
                detail,
                status,
                ..
            } => {
                tool_updates += 1;
                let output = output.unwrap();
                assert!(output.len() <= CHAT_TOOL_OUTPUT_LIMIT + 4);
                assert!(output.ends_with(":fixture tail\n"));
                if status == ToolStatus::Succeeded {
                    let detail = detail.unwrap();
                    let steps = read_tool_steps(
                        ANTIGRAVITY.key.as_str(),
                        ToolEvidence {
                            name: &title,
                            input: detail.payload(),
                            state: ChatToolState::Completed,
                            output: Some(&output),
                            working_directory: "/workspace",
                        },
                    );
                    let path = if item.0 == "edit-1" {
                        "/workspace/one"
                    } else {
                        "/workspace/two"
                    };
                    assert_eq!(
                        steps[0].action,
                        StepAction::Create {
                            targets: FileTargets::Paths(vec![path.to_owned()]),
                            counts: LineCounts {
                                added: Some(2),
                                removed: None
                            }
                        }
                    );
                    completed.push(item.0);
                }
            }
            EventKind::FilesChanged { files: current, .. } => files = current,
            EventKind::TurnEnded {
                outcome: TurnOutcome::Completed,
                ..
            } => break,
            _ => {}
        }
    }
    assert_eq!(tool_updates, 4);
    assert_eq!(completed, ["edit-1", "edit-2"]);
    assert_eq!(
        files,
        ["/workspace/one", "/workspace/two"].map(|path| FileChange {
            path: path.to_owned(),
            kind: FileChangeKind::Added,
            added_lines: Some(2),
            removed_lines: Some(0),
            confirmed: true,
        })
    );
    opened.runtime.close().await;
}

#[tokio::test]
async fn bounded_file_previews_preserve_the_whole_edit_through_completion() {
    use ticketd_core::{ChatToolState, harnesses::ANTIGRAVITY};

    use crate::{
        FileTargets, LineCounts, MAX_PROVIDER_DETAIL_BYTES, StepAction, ToolEvidence, ToolStatus,
        read_tool_steps,
    };

    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    assert_eq!(
        opened.runtime.submit(start_turn("mixed-edit")).await,
        DispatchOutcome::Written
    );
    let outgoing = peer.written().await;
    let update = |update| {
        json!({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": "session-1", "update": update}
        })
    };

    let mut diffs: Vec<_> = (0..32)
        .map(|index| {
            json!({"type": "diff", "path": format!("/workspace/new-{index}"), "newText": "new\n"})
        })
        .collect();
    let modified = "/workspace/existing";
    diffs.push(json!({"type": "diff", "path": modified, "oldText": "old\n", "newText": "new\n"}));
    send(
        &mut peer,
        &update(json!({
            "sessionUpdate": "tool_call", "toolCallId": "mixed", "title": "Edit files",
            "kind": "edit", "status": "in_progress", "rawInput": {"TargetFile": modified},
            "content": diffs
        })),
    )
    .await;
    send(
        &mut peer,
        &update(json!({
            "sessionUpdate": "tool_call_update", "toolCallId": "mixed", "status": "completed"
        })),
    )
    .await;
    send(
        &mut peer,
        &json!({"jsonrpc": "2.0", "id": outgoing["id"], "result": {"stopReason": "end_turn"}}),
    )
    .await;

    let mut states = Vec::new();
    loop {
        match opened.events.recv().await.unwrap().kind {
            EventKind::ToolUpdated {
                title,
                status,
                detail: Some(detail),
                ..
            } => {
                assert!(detail.payload().len() <= MAX_PROVIDER_DETAIL_BYTES);
                states.push(status);
                let steps = read_tool_steps(
                    ANTIGRAVITY.key.as_str(),
                    ToolEvidence {
                        name: &title,
                        input: detail.payload(),
                        state: if status == ToolStatus::Succeeded {
                            ChatToolState::Completed
                        } else {
                            ChatToolState::Running
                        },
                        output: None,
                        working_directory: "/workspace",
                    },
                );
                assert_eq!(
                    steps[0].action,
                    StepAction::Edit {
                        targets: FileTargets::Paths(vec![modified.to_owned()]),
                        counts: LineCounts::default(),
                    }
                );
            }
            EventKind::TurnEnded {
                outcome: TurnOutcome::Completed,
                ..
            } => break,
            _ => {}
        }
    }
    assert_eq!(states, [ToolStatus::Running, ToolStatus::Succeeded]);
    opened.runtime.close().await;
}

#[tokio::test]
async fn create_keeps_targets_and_line_counts_when_the_diff_preview_cannot_fit() {
    use ticketd_core::{ChatToolState, harnesses::ANTIGRAVITY};

    use crate::{
        FileTargets, LineCounts, MAX_PROVIDER_DETAIL_BYTES, StepAction, ToolEvidence,
        read_tool_steps,
    };

    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    assert_eq!(
        opened.runtime.submit(start_turn("create-files")).await,
        DispatchOutcome::Written
    );
    assert_eq!(peer.written().await["method"], "session/prompt");

    let component = format!("/{}", "nested".repeat(30));
    let directory = format!("/workspace{}", component.repeat(3));
    let long_paths: Vec<_> = (0..32)
        .map(|index| format!("{directory}/file-{index}.rs"))
        .collect();
    let input = "/workspace/input.rs";
    let location = "/workspace/location.rs";
    let diff = "/workspace/diff.rs".to_owned();
    for (id, paths, native_location, expected, added) in [
        ("input", long_paths.as_slice(), None, input, 64),
        (
            "location",
            long_paths.as_slice(),
            Some(location),
            location,
            64,
        ),
        (
            "intact",
            std::slice::from_ref(&diff),
            Some(location),
            diff.as_str(),
            2,
        ),
    ] {
        let content: Vec<_> = paths
            .iter()
            .map(|path| json!({"type": "diff", "path": path, "newText": "first\nsecond\n"}))
            .collect();
        let locations: Vec<_> = native_location
            .into_iter()
            .map(|path| json!({"path": path}))
            .collect();
        send(
            &mut peer,
            &json!({
                "jsonrpc": "2.0", "method": "session/update",
                "params": {
                    "sessionId": "session-1",
                    "update": {
                        "sessionUpdate": "tool_call", "toolCallId": id, "title": "Write files",
                        "kind": "edit", "status": "completed", "rawInput": {"TargetFile": input},
                        "content": content, "locations": locations
                    }
                }
            }),
        )
        .await;

        let (title, detail) = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let EventKind::ToolUpdated {
                    item,
                    title,
                    detail: Some(detail),
                    ..
                } = opened.events.recv().await.unwrap().kind
                    && item.0 == id
                {
                    break (title, detail);
                }
            }
        })
        .await
        .expect("saved tool detail");
        assert!(detail.payload().len() <= MAX_PROVIDER_DETAIL_BYTES);
        assert_eq!(detail.truncated(), paths.len() > 1);
        let steps = read_tool_steps(
            ANTIGRAVITY.key.as_str(),
            ToolEvidence {
                name: &title,
                input: detail.payload(),
                state: ChatToolState::Completed,
                output: None,
                working_directory: "/workspace",
            },
        );
        assert_eq!(
            steps[0].action,
            StepAction::Create {
                targets: FileTargets::Paths(vec![expected.to_owned()]),
                counts: LineCounts {
                    added: Some(added),
                    removed: None,
                },
            },
            "tool {id}"
        );
    }
    opened.runtime.close().await;
}

#[tokio::test]
async fn forwards_a_native_permission_id_once_and_keeps_the_providers_labels() {
    let (mut peer, mut opened) = open(
        RESUME,
        SessionStart::Resume(NativeSessionId::new("session-1")),
        settings::OWN,
    )
    .await;
    assert_eq!(
        opened.runtime.submit(start_turn("tool")).await,
        DispatchOutcome::Written
    );
    let _ = peer.written().await;
    let frames = recorded(RESUME);
    let permission = frames
        .iter()
        .find(|frame| frame["server"]["method"] == "session/request_permission")
        .unwrap();
    send(&mut peer, &permission["server"]).await;
    let events = drain(&mut opened.events).await;
    let shown = events
        .iter()
        .find_map(|kind| match kind {
            EventKind::InteractionRequested(request) => Some(request),
            _ => None,
        })
        .unwrap();
    let InteractionKind::NativeApproval {
        options, reason, ..
    } = &shown.kind
    else {
        panic!("expected provider approval");
    };
    assert_eq!(
        options
            .iter()
            .map(|option| (option.id.as_str(), option.label.as_str()))
            .collect::<Vec<_>>(),
        [("allow", "Allow"), ("deny", "Deny")],
    );
    assert_eq!(reason.as_deref(), Some("Print fixture environment markers"));
    let reply = |value: &str| InteractionResponse {
        generation: GENERATION,
        request: shown.request.clone(),
        answer: InteractionAnswer::NativeApproval(value.to_owned()),
    };
    assert_eq!(
        opened.runtime.respond(reply("allow-always")).await,
        RespondOutcome::NotSent(Refusal::Unsupported)
    );
    assert_eq!(
        opened.runtime.respond(reply("deny")).await,
        RespondOutcome::Sent
    );
    assert_eq!(
        peer.written().await,
        json!({"jsonrpc":"2.0","id":"1","result":{"outcome":{"outcome":"selected","optionId":"deny"}}}),
    );
    assert!(matches!(
        opened.runtime.respond(reply("allow")).await,
        RespondOutcome::NotSent(_)
    ));
    let failure = frames
        .iter()
        .find(|frame| frame["server"]["params"]["update"]["status"] == "failed")
        .unwrap();
    send(&mut peer, &failure["server"]).await;
    assert!(drain(&mut opened.events).await.iter().any(|kind| matches!(
        kind,
        EventKind::ToolUpdated { item, status: crate::ToolStatus::Declined, .. }
            if Some(item) == shown.item.as_ref()
    )));
    opened.runtime.close().await;
}

fn recorded_permission() -> Value {
    recorded(RESUME)
        .into_iter()
        .find_map(|line| {
            let frame = &line["server"];
            (frame["method"] == "session/request_permission").then(|| frame.clone())
        })
        .unwrap()
}

async fn next_approval(events: &mut EventStream) -> NativeRequestId {
    drain(events)
        .await
        .into_iter()
        .find_map(|kind| match kind {
            EventKind::InteractionRequested(request) => Some(request.request),
            _ => None,
        })
        .expect("the harness's approval is shown")
}

#[tokio::test(start_paused = true)]
async fn excess_approvals_are_refused_and_the_next_prompt_accepts_approvals() {
    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    assert_eq!(
        opened.runtime.submit(start_turn("saturation")).await,
        DispatchOutcome::Written
    );
    let prompt = peer.written().await;
    let mut permission = recorded_permission();
    permission["id"] = json!("approval-0");
    send(&mut peer, &permission).await;
    let first = next_approval(&mut opened.events).await;
    for number in 1..32 {
        permission["id"] = json!(format!("approval-{number}"));
        send(&mut peer, &permission).await;
        next_approval(&mut opened.events).await;
    }
    permission["id"] = json!("approval-0");
    send(&mut peer, &permission).await;
    permission["id"] = json!("overflow");
    send(&mut peer, &permission).await;
    assert_eq!(
        peer.written().await,
        json!({"jsonrpc": "2.0", "id": "overflow", "error": {
            "code": -32000, "message": "ticketd has reached the Antigravity approval limit for this turn"
        }})
    );
    assert!(
        !drain(&mut opened.events)
            .await
            .iter()
            .any(|kind| matches!(kind, EventKind::InteractionRequested(_)))
    );

    send(
        &mut peer,
        &json!({"jsonrpc": "2.0", "id": prompt["id"], "result": {"stopReason": "end_turn"}}),
    )
    .await;
    let finished = drain(&mut opened.events).await;
    assert_eq!(
        finished
            .iter()
            .filter(|kind| matches!(
                kind,
                EventKind::InteractionResolved {
                    resolution: crate::InteractionResolution::Withdrawn,
                    ..
                }
            ))
            .count(),
        32
    );
    assert_eq!(
        opened.runtime.submit(start_turn("recovery")).await,
        DispatchOutcome::Written
    );
    assert_eq!(peer.written().await["method"], "session/prompt");
    permission["id"] = json!("approval-0");
    send(&mut peer, &permission).await;
    let next = next_approval(&mut opened.events).await;
    assert_eq!(
        opened
            .runtime
            .respond(InteractionResponse {
                generation: GENERATION,
                request: first,
                answer: InteractionAnswer::NativeApproval("allow".into()),
            })
            .await,
        RespondOutcome::NotSent(Refusal::UnknownRequest)
    );
    assert_eq!(
        opened
            .runtime
            .respond(InteractionResponse {
                generation: GENERATION,
                request: next,
                answer: InteractionAnswer::NativeApproval("allow".into()),
            })
            .await,
        RespondOutcome::Sent
    );
    assert_eq!(
        peer.written().await,
        json!({"jsonrpc": "2.0", "id": "approval-0", "result": {
            "outcome": {"outcome": "selected", "optionId": "allow"}
        }})
    );
    peer.assert_nothing_written().await;
}

#[tokio::test(start_paused = true)]
async fn a_saturated_reply_queue_ends_the_prompt_without_stalling_wire_reads() {
    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    assert_eq!(
        opened.runtime.submit(start_turn("saturation")).await,
        DispatchOutcome::Written
    );
    assert_eq!(peer.written().await["method"], "session/prompt");
    send(&mut peer, &recorded_permission()).await;
    let pending = next_approval(&mut opened.events).await;

    // This reply cannot fit in the scripted stdin pipe until the peer reads it.
    let blocked =
        json!({"jsonrpc": "2.0", "method": "fixture/unsupported", "id": "x".repeat(128 * 1024)});
    send(&mut peer, &blocked).await;
    send(
        &mut peer,
        &text_update("agent_message_chunk", "still reading"),
    )
    .await;
    assert!(drain(&mut opened.events).await.iter().any(|kind| matches!(
        kind, EventKind::TextDelta { text, .. } if text == "still reading"
    )));
    let reply = peer.written().await;
    assert_eq!(reply["id"], blocked["id"]);
    assert_eq!(reply["error"]["code"], -32601);

    send(&mut peer, &blocked).await;
    let backlog = (0..32)
        .map(|id| {
            format!(
                "{}\n",
                json!({"jsonrpc": "2.0", "method": "fixture/unsupported", "id": id})
            )
        })
        .collect::<String>();
    peer.send(&backlog).await;
    let loss = tokio::time::timeout(crate::WRITE_TIMEOUT + Duration::from_secs(3), async {
        while let Some(event) = opened.events.recv().await {
            if let EventKind::RuntimeLost { diagnostics, .. } = event.kind {
                return diagnostics;
            }
        }
        panic!("the runtime must report the loss");
    })
    .await
    .expect("the queue overflow must close the runtime");
    assert!(loss.contains("the harness response queue filled"), "{loss}");
    assert_eq!(
        opened
            .runtime
            .respond(InteractionResponse {
                generation: GENERATION,
                request: pending,
                answer: InteractionAnswer::NativeApproval("allow".into()),
            })
            .await,
        RespondOutcome::NotSent(Refusal::RuntimeClosed)
    );
}

#[tokio::test]
async fn large_approval_input_keeps_the_exact_command() {
    let command = "printf '%s' 'fixture command'";
    let path = format!("/workspace/{}", "a".repeat(3500));
    let (step, _) = compacted_command_approval(
        json!({
            "CommandLine": command,
            "AbsolutePath": path,
            "TargetFile": path,
            "SourcePath": path,
            "DestinationPath": path,
            "WorkingDirectory": path
        }),
        Some(json!({"exit_code": 7})),
        None,
    )
    .await;
    let shell = step.command.expect("missing exact command");
    assert_eq!(shell.exact, command);
    assert_eq!(shell.working_directory.as_deref(), Some(path.as_str()));
    assert_eq!(shell.exit_code, Some(7));
}

#[tokio::test]
async fn approval_keeps_the_exact_command_at_the_detail_limit() {
    let command = format!("echo {}x", "é".repeat(8188));
    let (step, approval) =
        compacted_command_approval(json!({"command": command}), None, None).await;
    let shell = step.command.expect("missing exact command");
    assert!(shell.exact == command, "exact command text changed");
    assert!(matches!(
        approval.kind,
        InteractionKind::NativeApproval { reason: None, .. }
    ));
}

#[tokio::test]
async fn approval_explains_when_the_command_cannot_fit_and_keeps_execute_facts() {
    let commands = [
        format!("printf '%s' '{}'", "\\".repeat(8192)),
        format!("echo {}", "z".repeat(16384)),
    ];
    for command in commands {
        let (step, approval) = compacted_command_approval(
            json!({"CommandLine": command, "Cwd": "/workspace/fixtures"}),
            Some(json!({"exit_code": 7})),
            Some("Review the command before approving."),
        )
        .await;
        assert_eq!(
            step.action,
            crate::StepAction::Run(crate::RunAction::CommandUnavailable {
                working_directory: Some("/workspace/fixtures".to_owned()),
                exit_code: Some(7),
            })
        );
        assert!(step.command.is_none());
        let InteractionKind::NativeApproval {
            options, reason, ..
        } = approval.kind
        else {
            panic!("expected provider approval");
        };
        assert_eq!(options[0].id, "native-allow");
        assert_eq!(
            reason.as_deref().unwrap().lines().collect::<Vec<_>>(),
            [
                "The command is too large for ticketd to show in full.",
                "Review the command before approving.",
            ]
        );
    }
}

async fn compacted_command_approval(
    raw_input: Value,
    raw_output: Option<Value>,
    warning: Option<&str>,
) -> (crate::ToolStep, crate::InteractionRequest) {
    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    assert_eq!(
        opened.runtime.submit(start_turn("tool")).await,
        DispatchOutcome::Written
    );
    assert_eq!(peer.written().await["method"], "session/prompt");

    send(
        &mut peer,
        &json!({
            "jsonrpc": "2.0",
            "id": "permission-1",
            "method": "session/request_permission",
            "params": {
                "sessionId": "session-1",
                "warning": warning,
                "toolCall": {
                    "toolCallId": "tool-1",
                    "title": "Print a marker",
                    "kind": "execute",
                    "rawInput": raw_input,
                    "rawOutput": raw_output
                },
                "options": [{"optionId": "native-allow", "name": "Allow", "kind": "allow_once"}]
            }
        }),
    )
    .await;

    let events = drain(&mut opened.events).await;
    let [
        ..,
        EventKind::ToolUpdated {
            title,
            output,
            detail: Some(detail),
            ..
        },
        EventKind::InteractionRequested(approval),
    ] = events.as_slice()
    else {
        panic!("expected tool evidence followed by approval");
    };
    assert!(detail.payload().len() <= crate::MAX_PROVIDER_DETAIL_BYTES);
    let mut steps = crate::read_tool_steps(
        ticketd_core::harnesses::ANTIGRAVITY.key.as_str(),
        crate::ToolEvidence {
            name: title,
            input: detail.payload(),
            output: output.as_deref(),
            state: ticketd_core::ChatToolState::Running,
            working_directory: "/workspace",
        },
    );
    assert_eq!(steps.len(), 1);
    assert!(detail.truncated());
    opened.runtime.close().await;
    (steps.remove(0), approval.clone())
}

#[tokio::test]
async fn keeps_native_warnings_with_their_choices_and_sends_the_chosen_id() {
    let (mut peer, mut opened) = open(
        RESUME,
        SessionStart::Resume(NativeSessionId::new("session-1")),
        settings::OWN,
    )
    .await;
    assert_eq!(
        opened.runtime.submit(start_turn("tool")).await,
        DispatchOutcome::Written
    );
    assert_eq!(peer.written().await["method"], "session/prompt");
    let command = "echo 'fixture command'";
    send(
        &mut peer,
        &json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "session-1",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tool-1",
                    "title": "Print fixture",
                    "kind": "execute",
                    "rawInput": {"CommandLine": command, "Cwd": "/workspace/fixtures"}
                }
            }
        }),
    )
    .await;
    send(
        &mut peer,
        &json!({
            "jsonrpc": "2.0",
            "id": "permission-1",
            "method": "session/request_permission",
            "params": {
                "sessionId": "session-1",
                "reason": "Permission needed to run this command",
                "warning": "Review the command before approving",
                "toolCall": {
                    "toolCallId": "tool-1",
                    "title": "echo fixture",
                    "kind": "execute",
                    "rawInput": { "toolSummary": "Print a fixture marker" }
                },
                "options": [
                    { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                    {
                        "optionId": "provider-option-7",
                        "name": "Allow always",
                        "kind": "allow_always",
                        "_meta": { "agy.security.warning": "Allowing this command always adds an Antigravity permission rule." }
                    },
                    {
                        "optionId": "provider-option-9",
                        "name": "Deny always",
                        "kind": "reject_always",
                        "_meta": { "agy.security.warning": "Denying this command always adds an Antigravity permission rule." }
                    }
                ]
            }
        }),
    )
    .await;
    let events = drain(&mut opened.events).await;
    let [
        ..,
        EventKind::ToolUpdated {
            title,
            detail: Some(detail),
            ..
        },
        EventKind::InteractionRequested(approval),
    ] = events.as_slice()
    else {
        panic!("expected tool evidence followed by approval");
    };
    let steps = crate::read_tool_steps(
        ticketd_core::harnesses::ANTIGRAVITY.key.as_str(),
        crate::ToolEvidence {
            name: title,
            input: detail.payload(),
            output: None,
            state: ticketd_core::ChatToolState::Running,
            working_directory: "/workspace",
        },
    );
    let shell = steps[0].command.as_ref().unwrap();
    assert_eq!(shell.exact, command);
    assert_eq!(
        shell.working_directory.as_deref(),
        Some("/workspace/fixtures")
    );
    let InteractionKind::NativeApproval {
        options, reason, ..
    } = &approval.kind
    else {
        panic!("expected provider approval");
    };
    assert_eq!(
        reason.as_deref().unwrap().lines().collect::<Vec<_>>(),
        [
            "Permission needed to run this command",
            "Review the command before approving",
            "Print a fixture marker",
        ]
    );
    assert_eq!(
        options
            .iter()
            .map(|option| (
                option.id.as_str(),
                option.label.as_str(),
                option.warning.as_deref()
            ))
            .collect::<Vec<_>>(),
        [
            ("allow", "Allow", None),
            (
                "provider-option-7",
                "Allow always",
                Some("Allowing this command always adds an Antigravity permission rule."),
            ),
            (
                "provider-option-9",
                "Deny always",
                Some("Denying this command always adds an Antigravity permission rule."),
            ),
        ],
    );
    let reply = || InteractionResponse {
        generation: GENERATION,
        request: approval.request.clone(),
        answer: InteractionAnswer::NativeApproval(options[1].id.clone()),
    };
    peer.assert_nothing_written().await;
    assert_eq!(opened.runtime.respond(reply()).await, RespondOutcome::Sent);
    assert_eq!(
        peer.written().await,
        json!({"jsonrpc":"2.0","id":"permission-1","result":{"outcome":{"outcome":"selected","optionId":"provider-option-7"}}}),
    );
    assert!(matches!(
        opened.runtime.respond(reply()).await,
        RespondOutcome::NotSent(_)
    ));
    opened.runtime.close().await;
}

#[tokio::test]
async fn native_permissions_follow_config_updates_and_require_confirmation_when_reselected() {
    let (mut peer, mut opened) = open(MODES, SessionStart::New, settings::OWN).await;
    let settings = next_settings(&mut opened.events).await;
    let permission = settings.permission.unwrap();
    assert_eq!(permission.current.as_deref(), Some("own"));
    assert!(permission.options.iter().any(|option| option.id == "plan"));
    assert!(settings.model.is_some());
    assert!(settings.effort.is_some());

    let frames = recorded(MODES);
    let index = frames
        .iter()
        .position(|frame| frame["client"]["method"] == "session/set_config_option")
        .unwrap();
    let native_default = frames
        .iter()
        .find_map(|frame| {
            let notice = &frame["server"]["params"]["update"];
            let configs = notice["configOptions"].as_array()?;
            configs
                .iter()
                .any(|option| option["category"] == "mode" && option["currentValue"] == "default")
                .then_some(&frame["server"])
        })
        .unwrap();

    let exchange = async |peer: &mut Peer, mut reply: Value| {
        let expected = &frames[index]["client"];
        let sent = peer.written().await;
        assert_eq!(sent["method"], expected["method"]);
        assert_eq!(sent["params"], expected["params"]);
        reply["id"] = sent["id"].clone();
        send(peer, &reply).await;
    };
    let (outcome, ()) = tokio::join!(
        opened
            .runtime
            .change_setting(permission_change("accept-edits")),
        exchange(&mut peer, frames[index + 1]["server"].clone())
    );
    assert_eq!(outcome, SettingOutcome::Applied);
    assert_current_permission(&mut opened.events, "accept-edits").await;
    send(&mut peer, native_default).await;
    assert_current_permission(&mut opened.events, "default").await;

    let mismatched = json!({
        "jsonrpc": "2.0",
        "result": {"configOptions": native_default["params"]["update"]["configOptions"]}
    });
    let (outcome, ()) = tokio::join!(
        opened
            .runtime
            .change_setting(permission_change("accept-edits")),
        exchange(&mut peer, mismatched)
    );
    assert!(matches!(outcome, SettingOutcome::Refused { .. }));
    assert_current_permission(&mut opened.events, "default").await;

    let native_plan = frames
        .iter()
        .find(|frame| frame["server"]["params"]["update"]["currentModeId"] == "plan")
        .unwrap();
    send(&mut peer, &native_plan["server"]).await;
    assert_current_permission(&mut opened.events, "plan").await;
    let (outcome, ()) = tokio::join!(
        opened
            .runtime
            .change_setting(permission_change("accept-edits")),
        exchange(&mut peer, frames[index + 1]["server"].clone())
    );
    assert_eq!(outcome, SettingOutcome::Applied);
    assert_current_permission(&mut opened.events, "accept-edits").await;
    assert_eq!(
        opened
            .runtime
            .change_setting(permission_change("full-access"))
            .await,
        SettingOutcome::ReopenSession
    );
    opened.runtime.close().await;
}

#[tokio::test]
async fn resume_refuses_to_open_if_confirming_effort_changes_the_selected_model() {
    let (mut peer, io) = pipes();
    let mut request = request(SessionStart::Resume(NativeSessionId::new("session-1")));
    request.settings.model = Some("gemini-4-neon".to_owned());
    request.settings.effort = Some("high".to_owned());
    let opening = tokio::spawn(runtime::open(io, request, settings::FULL.to_owned()));
    startup(&mut peer, RESUME).await;

    let frames = recorded(RESUME);
    let mut configs = frames
        .iter()
        .find_map(|frame| frame["server"]["result"]["configOptions"].as_array())
        .unwrap()
        .clone();
    for (id, value) in [("model", "gemini-4-neon"), ("thought_level", "high")] {
        let call = peer.written().await;
        assert_eq!(call["method"], "session/set_config_option");
        assert_eq!(
            call["params"],
            json!({"sessionId": "session-1", "configId": id, "value": value})
        );
        for config in &mut configs {
            if config["id"] == id {
                config["currentValue"] = json!(value);
            } else if id == "thought_level" && config["id"] == "model" {
                config["currentValue"] = json!("gemini-3.1-pro");
            }
        }
        send(
            &mut peer,
            &json!({
                "jsonrpc": "2.0",
                "id": call["id"],
                "result": {"configOptions": configs}
            }),
        )
        .await;
    }
    // Keep the connection alive until startup checks the final settings and closes it.
    let exit_after_close = async {
        assert!(
            tokio::time::timeout(Duration::from_secs(5), peer.stdin_closed())
                .await
                .unwrap()
        );
        peer.exit(0);
    };
    let (result, ()) = tokio::join!(opening, exit_after_close);
    let problem = result.unwrap().unwrap_err();
    assert_eq!(problem.kind, ProblemKind::Other);
    assert_eq!(
        problem.message,
        "Antigravity did not confirm the requested setting"
    );
}

#[tokio::test]
async fn native_mode_changes_keep_the_own_and_full_access_policies() {
    let frames = recorded(MODES);
    let update = frames
        .iter()
        .find(|frame| {
            frame["server"]["params"]["update"]["sessionUpdate"] == "config_option_update"
        })
        .unwrap();
    for (policy, other) in [
        (settings::OWN, settings::FULL),
        (settings::FULL, settings::OWN),
    ] {
        let (mut peer, mut opened) = open(MODES, SessionStart::New, policy).await;
        assert_current_permission(&mut opened.events, policy).await;
        send(&mut peer, &update["server"]).await;
        assert_current_permission(&mut opened.events, policy).await;
        assert_eq!(
            opened
                .runtime
                .change_setting(permission_change(policy))
                .await,
            SettingOutcome::Applied
        );
        assert_eq!(
            opened
                .runtime
                .change_setting(permission_change(other))
                .await,
            SettingOutcome::ReopenSession
        );
        opened.runtime.close().await;
    }
}

fn permission_change(value: &str) -> SettingChange {
    SettingChange {
        generation: GENERATION,
        setting: SettingKey::Permission,
        value: value.to_owned(),
    }
}

async fn assert_current_permission(events: &mut EventStream, expected: &str) {
    let permission = next_settings(events).await.permission.unwrap();
    assert_eq!(permission.current.as_deref(), Some(expected));
}

async fn next_settings(events: &mut EventStream) -> HarnessSettings {
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = events.recv().await {
            if let EventKind::SettingsState(settings) = event.kind {
                return settings;
            }
        }
        panic!("Antigravity runtime stopped before reporting settings");
    })
    .await
    .expect("Antigravity runtime reports settings")
}

#[tokio::test]
async fn recorded_resume_error_reports_missing_history_for_the_requested_session() {
    for (fixture, expected) in [
        (
            MISSING_RESUME.to_owned(),
            ProblemKind::NativeHistoryUnavailable,
        ),
        (
            MISSING_RESUME.replace(
                "Failed to read session session-missing",
                "Failed to read session another-session",
            ),
            ProblemKind::Other,
        ),
    ] {
        let (mut peer, io) = pipes();
        let native_session = NativeSessionId::new("session-missing");
        let resume = request(SessionStart::Resume(native_session));
        let opening = tokio::spawn(runtime::open(io, resume, settings::OWN.to_owned()));
        startup(&mut peer, &fixture).await;
        assert_eq!(opening.await.unwrap().unwrap_err().kind, expected);
    }
}

#[tokio::test]
async fn signed_out_reports_login_required_without_attempting_authentication() {
    let detail = "Authentication required: the credentials for this profile expired";
    for (fixture, expected_message) in [
        (SIGNED_OUT.to_owned(), ANTIGRAVITY.sign_in_guidance),
        (
            SIGNED_OUT.replace("Authentication required", detail),
            detail,
        ),
    ] {
        let (mut peer, io) = pipes();
        let opening = tokio::spawn(runtime::open(
            io,
            request(SessionStart::New),
            settings::OWN.to_owned(),
        ));
        startup(&mut peer, &fixture).await;
        let problem = opening.await.unwrap().unwrap_err();
        assert_eq!(problem.kind, ProblemKind::LoginRequired);
        assert_eq!(problem.message, expected_message);
    }
}

use std::sync::Arc;

use async_trait::async_trait;

use crate::conformance::{NewTurn, Provider};
use crate::{EventStream, HarnessRuntime, NativeRequestId, NativeTurnId, RuntimeGeneration};

struct AcpProvider {
    peer: Peer,
    opened: OpenedRuntime,
    prompt: Option<Value>,
}

pub(crate) async fn provider() -> Box<dyn Provider> {
    let session = SessionStart::Resume(NativeSessionId::new("session-1"));
    let (peer, mut opened) = open(RESUME, session, settings::OWN).await;
    drain(&mut opened.events).await;
    Box::new(AcpProvider {
        peer,
        opened,
        prompt: None,
    })
}

#[async_trait]
impl Provider for AcpProvider {
    fn new_turn(&self) -> NewTurn {
        NewTurn::WrittenThenProcessing
    }

    fn loss(&self) -> (Option<i32>, &'static str) {
        (Some(23), "")
    }

    fn loss_dispatch(&self) -> DispatchOutcome {
        // ACP has no separate write acknowledgment. A successful write is reported
        // before the process loss, and the Chat still lacks evidence of processing.
        DispatchOutcome::Written
    }

    fn approval_answer(
        &self,
        request: &NativeRequestId,
        generation: RuntimeGeneration,
    ) -> InteractionResponse {
        InteractionResponse {
            request: request.clone(),
            generation,
            answer: InteractionAnswer::NativeApproval("allow".to_owned()),
        }
    }

    fn runtime(&self) -> Arc<dyn HarnessRuntime> {
        self.opened.runtime.clone()
    }

    fn events(&mut self) -> &mut EventStream {
        &mut self.opened.events
    }

    async fn start_turn(&mut self, id: &str) -> DispatchOutcome {
        let outcome = self.opened.runtime.submit(start_turn(id)).await;
        let prompt = self.peer.written().await;
        assert_eq!(prompt["method"], "session/prompt");
        self.prompt = Some(prompt);
        outcome
    }

    async fn show_processing(&mut self, _id: &str) -> NativeTurnId {
        let frames = recorded(PROMPT);
        let message = frames
            .iter()
            .find(|frame| {
                frame["server"]["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
            })
            .unwrap();
        send(&mut self.peer, &message["server"]).await;
        drain(&mut self.opened.events)
            .await
            .into_iter()
            .find_map(|kind| match kind {
                EventKind::TextDelta { turn, .. } => Some(turn),
                _ => None,
            })
            .unwrap()
    }

    async fn submit_unanswered(&mut self, id: &str) -> DispatchOutcome {
        self.start_turn(id).await
    }

    async fn refuse_late(&mut self, _id: &str) {
        let id = self.prompt.take().unwrap()["id"].clone();
        send(
            &mut self.peer,
            &json!({
                "jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"Invalid params"}
            }),
        )
        .await;
    }

    async fn submit_and_lose_process(&mut self, id: &str) -> DispatchOutcome {
        let outcome = self.start_turn(id).await;
        self.peer.exit(23);
        outcome
    }

    async fn request_approval(&mut self) -> NativeRequestId {
        assert_eq!(self.start_turn("approval").await, DispatchOutcome::Written);
        let frames = recorded(RESUME);
        let permission = frames
            .iter()
            .find(|frame| frame["server"]["method"] == "session/request_permission")
            .unwrap();
        send(&mut self.peer, &permission["server"]).await;
        drain(&mut self.opened.events)
            .await
            .into_iter()
            .find_map(|kind| match kind {
                EventKind::InteractionRequested(request) => Some(request.request),
                _ => None,
            })
            .unwrap()
    }

    async fn respond(&mut self, response: InteractionResponse) -> RespondOutcome {
        let outcome = self.opened.runtime.respond(response).await;
        if outcome == RespondOutcome::Sent {
            assert_eq!(
                self.peer.written().await["result"]["outcome"]["optionId"],
                "allow"
            );
        }
        outcome
    }

    async fn assert_nothing_else_written(&mut self) {
        self.peer.assert_nothing_written().await;
    }
}

#[tokio::test]
async fn a_native_question_reaches_the_person_as_an_antigravity_message() {
    let (mut peer, mut opened) = open(QUESTION, SessionStart::New, settings::OWN).await;
    let frames = recorded(QUESTION);
    let mut input = start_turn("question");
    input.text = frames[6]["client"]["params"]["prompt"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(opened.runtime.submit(input).await, DispatchOutcome::Written);
    let outgoing = peer.written().await;
    for frame in &frames[7..] {
        let mut incoming = frame["server"].clone();
        if incoming.get("result").is_some() {
            incoming["id"] = outgoing["id"].clone();
        }
        send(&mut peer, &incoming).await;
    }
    assert!(drain(&mut opened.events).await.iter().any(|kind| matches!(
        kind,
        EventKind::MessageCompleted { text, .. }
            if text.contains("What fixture color should I use?\n- [1] Indigo\n- [2] Moss")
    )));
    assert_eq!(
        opened.runtime.submit(start_turn("answer")).await,
        DispatchOutcome::Written
    );
    assert_eq!(peer.written().await["method"], "session/prompt");
    opened.runtime.close().await;
}

#[tokio::test]
async fn stop_notifies_antigravity_and_cancels_its_unanswered_permission() {
    use crate::{InteractionResolution, InterruptOutcome, InterruptRequest, ToolStatus};
    let (mut peer, mut opened) = open(
        RESUME,
        SessionStart::Resume(NativeSessionId::new("session-1")),
        settings::OWN,
    )
    .await;
    assert_eq!(
        opened.runtime.submit(start_turn("stop")).await,
        DispatchOutcome::Written
    );
    let outgoing = peer.written().await;
    let frames = recorded(RESUME);
    let permission = frames
        .iter()
        .find(|frame| frame["server"]["method"] == "session/request_permission")
        .unwrap();
    let update = |update: Value| {
        json!({"jsonrpc":"2.0","method":"session/update","params":{
            "sessionId":"session-1","update": update
        }})
    };
    send(
        &mut peer,
        &update(
            json!({"sessionUpdate":"tool_call","toolCallId":"earlier-failure",
            "title":"Earlier command","kind":"execute","status":"failed"}),
        ),
    )
    .await;
    let mut call = permission["server"]["params"]["toolCall"].clone();
    call["status"] = json!("in_progress");
    send(&mut peer, &update(call)).await;
    let tool = &permission["server"]["params"]["toolCall"]["toolCallId"];
    let tool_update = |status: &str| {
        update(json!({"sessionUpdate":"tool_call_update","toolCallId":tool,"status":status}))
    };
    send(&mut peer, &tool_update("pending")).await;
    send(&mut peer, &permission["server"]).await;
    let mut events = drain(&mut opened.events).await;
    let approval = events
        .iter()
        .find_map(|kind| match kind {
            EventKind::InteractionRequested(request) => Some(request.clone()),
            _ => None,
        })
        .unwrap();
    let turn = approval.turn.unwrap();

    let outcome = opened
        .runtime
        .interrupt(InterruptRequest {
            generation: GENERATION,
            expected_turn: turn,
        })
        .await;
    assert_eq!(outcome, InterruptOutcome::Acknowledged);
    assert_eq!(
        peer.written().await,
        json!({
            "jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"session-1"}
        })
    );
    assert_eq!(
        peer.written().await,
        json!({
            "jsonrpc":"2.0","id":"1","result":{"outcome":{"outcome":"cancelled"}}
        })
    );

    // agy reports the cancelled permission as an in-progress tool, then a failure.
    send(&mut peer, &tool_update("in_progress")).await;
    send(&mut peer, &tool_update("failed")).await;
    send(
        &mut peer,
        &update(
            json!({"sessionUpdate":"tool_call_update","toolCallId":"earlier-failure",
            "rawOutput":{"exit_code":1}}),
        ),
    )
    .await;
    send(
        &mut peer,
        &json!({"jsonrpc":"2.0","id":outgoing["id"],"result":{"stopReason":"cancelled"}}),
    )
    .await;
    events.extend(drain(&mut opened.events).await);

    assert_eq!(
        crate::outcome::read_end(&events),
        Some(TurnOutcome::Interrupted)
    );
    assert!(events.iter().any(|kind| matches!(
        kind,
        EventKind::InteractionResolved { request, resolution: InteractionResolution::Withdrawn }
            if request == &approval.request
    )));
    let last_status = |id: &str| {
        events.iter().rev().find_map(|kind| match kind {
            EventKind::ToolUpdated { item, status, .. } if item.0 == id => Some(*status),
            _ => None,
        })
    };
    assert_eq!(
        last_status(tool.as_str().unwrap()),
        Some(ToolStatus::FailedAfterInterrupt)
    );
    assert_eq!(last_status("earlier-failure"), Some(ToolStatus::Failed));
    opened.runtime.close().await;
}
