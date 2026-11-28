use std::{path::PathBuf, time::Duration};

use serde_json::{Value, json};
use ticketd_core::ChatAttachmentContent;

use crate::conformance::{GENERATION, drain, open_request, start_turn};
use crate::scripted::{Peer, pipes};
use crate::{
    DeliveryEvidence, DispatchOutcome, EventKind, HarnessSettings, InteractionAnswer,
    InteractionKind, InteractionResponse, NativeSessionId, OpenRequest, OpenedRuntime, ProblemKind,
    Refusal, RespondOutcome, SessionStart, SettingChange, SettingKey, SettingOutcome, TurnOutcome,
};

use super::{ANTIGRAVITY, runtime, settings};

const PROMPT: &str = include_str!("../../tests/fixtures/antigravity/prompt.jsonl");
const SUB_AGENT: &str = include_str!("../../tests/fixtures/antigravity/sub_agent.jsonl");
const QUESTION: &str = include_str!("../../tests/fixtures/antigravity/question.jsonl");
const MODES: &str = include_str!("../../tests/fixtures/antigravity/session-modes.jsonl");
const RESUME: &str = include_str!("../../tests/fixtures/antigravity/resume-own-settings.jsonl");
const MISSING_RESUME: &str =
    include_str!("../../tests/fixtures/antigravity/resume-missing-session.jsonl");
const SIGNED_OUT: &str = include_str!("../../tests/fixtures/antigravity/signed-out.jsonl");
const QUOTA_DIAGNOSTIC: &str = "\n⚠ agent executor error: generating and executing: Error 429, Message: Synthetic fixture quota exhausted for this test., Status: RESOURCE_EXHAUSTED, Details: []\n";
const PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aensAAAAASUVORK5CYII=";

fn screenshot() -> ChatAttachmentContent {
    ChatAttachmentContent::from_image_data_url(
        "screen.png",
        &format!("data:image/png;base64,{PNG_BASE64}"),
    )
    .unwrap()
}

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

#[cfg(unix)]
#[tokio::test]
async fn inspection_skips_non_executable_candidates_and_probes_first_executable() {
    use std::fs::{self, Permissions};
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    use crate::{HarnessAdapter, Inspection};

    const CHILD: &str = "TICKETD_TEST_ANTIGRAVITY_DISCOVERY_DIRECTORY";
    const TEST: &str = "antigravity::tests::inspection_skips_non_executable_candidates_and_probes_first_executable";
    let write_version = |path: &std::path::Path, version, mode| {
        fs::write(path, format!("#!/bin/sh\nprintf 'agy {version}\\n'\n")).unwrap();
        fs::set_permissions(path, Permissions::from_mode(mode)).unwrap();
    };
    if let Some(directory) = std::env::var_os(CHILD) {
        let directory = PathBuf::from(directory);
        let first = directory.join("first/agy");
        let second = directory.join("second/agy");
        let fallback = directory.join(".local/bin/agy");
        let inspection = super::Antigravity.inspect().await;
        assert!(
            matches!(&inspection, Inspection::Installed { executable, .. } if executable == &second),
            "{inspection:?}"
        );
        write_version(&first, "1.5.1", 0o700);
        let inspection = super::Antigravity.inspect().await;
        assert!(
            matches!(&inspection, Inspection::Incompatible { executable, .. } if executable == &first),
            "{inspection:?}"
        );
        fs::set_permissions(&first, Permissions::from_mode(0o600)).unwrap();
        fs::remove_file(second).unwrap();
        let inspection = super::Antigravity.inspect().await;
        assert!(
            matches!(&inspection, Inspection::Installed { executable, .. } if executable == &fallback),
            "{inspection:?}"
        );
        return;
    }

    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first");
    let second = directory.path().join("second");
    let fallback = directory.path().join(".local/bin");
    for path in [&first, &second, &fallback] {
        fs::create_dir_all(path).unwrap();
    }
    write_version(&first.join("agy"), "1.5.15", 0o600);
    write_version(&second.join("agy"), "1.5.15", 0o700);
    write_version(&fallback.join("agy"), "1.5.15", 0o700);
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST])
        .env("PATH", std::env::join_paths([first, second]).unwrap())
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
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        // A fixture's note and marks say where it came from, not what was said.
        .filter(|frame| frame.get("client").is_some() || frame.get("server").is_some())
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
async fn recorded_image_capability_allows_a_native_image_prompt() {
    let (mut peer, opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    let mut input = start_turn("image");
    input.text = "Describe this screenshot.".to_owned();
    input.attachments = vec![screenshot()];

    assert_eq!(opened.runtime.submit(input).await, DispatchOutcome::Written);
    let outgoing = peer.written().await;
    assert_eq!(outgoing["method"], "session/prompt");
    assert_eq!(
        outgoing["params"],
        json!({
            "sessionId": "session-1",
            "prompt": [
                {"type": "text", "text": "Describe this screenshot."},
                {"type": "image", "mimeType": "image/png", "data": PNG_BASE64}
            ]
        })
    );
}

#[tokio::test]
async fn an_unadvertised_image_capability_refuses_the_whole_prompt() {
    let fixture = PROMPT.replacen("\"image\":true,", "", 1);
    let (mut peer, opened) = open(&fixture, SessionStart::New, settings::OWN).await;
    assert_eq!(opened.runtime.supports_image_input(), Some(false));
    let mut input = start_turn("image");
    input.text = "Do not send this separately.".to_owned();
    input.attachments = vec![screenshot()];
    assert_eq!(
        opened.runtime.submit(input).await,
        DispatchOutcome::NotSent(Refusal::ImageInputUnsupported)
    );
    assert_eq!(
        opened.runtime.submit(start_turn("next")).await,
        DispatchOutcome::Written
    );
    assert_eq!(
        peer.written().await["params"]["prompt"],
        json!([{"type": "text", "text": "hello"}])
    );
}

#[tokio::test]
async fn acp_invalid_params_reports_recoverable_rejection_for_the_image_prompt() {
    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    let mut input = start_turn("image");
    input.attachments = vec![screenshot()];
    let submission = input.submission.clone();
    assert_eq!(opened.runtime.submit(input).await, DispatchOutcome::Written);
    let outgoing = peer.written().await;
    let reason = "The selected model does not accept this image.";
    send(
        &mut peer,
        &json!({
            "jsonrpc": "2.0", "id": outgoing["id"],
            "error": {"code": -32602, "message": reason}
        }),
    )
    .await;
    let evidence = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let EventKind::SubmissionEvidence {
                submission: id,
                evidence,
            } = opened.events.recv().await.unwrap().kind
            {
                assert_eq!(id, submission);
                break evidence;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        evidence,
        DeliveryEvidence::Rejected {
            reason: reason.to_owned()
        }
    );
}

#[tokio::test]
async fn file_only_prompt_provides_a_readable_copy_under_the_selected_permission() {
    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    assert_current_permission(&mut opened.events, settings::OWN).await;
    let mut input = start_turn("file");
    input.text.clear();
    input.attachments = vec![
        ChatAttachmentContent::from_data_url(
            "captured file.txt",
            "data:text/plain;base64,c2F2ZWQgc25hcHNob3QK",
            1024,
        )
        .unwrap(),
    ];

    assert_eq!(opened.runtime.submit(input).await, DispatchOutcome::Written);
    let outgoing = peer.written().await;
    assert_eq!(outgoing["method"], "session/prompt");
    let blocks = outgoing["params"]["prompt"].as_array().unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["type"], "text");
    let reference: Value = serde_json::from_str(
        blocks[0]["text"]
            .as_str()
            .unwrap()
            .strip_prefix("Read this Chat attachment snapshot: ")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(reference["name"], "captured file.txt");
    let path = PathBuf::from(reference["path"].as_str().unwrap());
    assert!(path.is_absolute());
    assert_eq!(std::fs::read(&path).unwrap(), b"saved snapshot\n");

    peer.exit(0);
    opened.runtime.close().await;
    assert!(!path.exists());
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
async fn a_failed_prompt_does_not_say_its_sub_agents_completed() {
    let (mut peer, mut opened) = open(SUB_AGENT, SessionStart::New, settings::OWN).await;
    assert_eq!(
        opened.runtime.submit(start_turn("failing")).await,
        DispatchOutcome::Written
    );
    let outgoing = peer.written().await;
    let frames = recorded(SUB_AGENT);
    let prompt_index = frames
        .iter()
        .position(|frame| frame["client"]["method"] == "session/prompt")
        .unwrap();
    // Up to the sub-agent's first call: it is running.
    for entry in &frames[prompt_index + 1..] {
        let Some(update) = entry.get("server") else {
            continue;
        };
        send(&mut peer, update).await;
        let call = &update["params"]["update"];
        if call["sessionUpdate"] == "tool_call"
            && call["toolCallId"]
                .as_str()
                .is_some_and(|id| id.contains(':'))
        {
            break;
        }
    }
    send(
        &mut peer,
        &json!({"jsonrpc": "2.0", "id": outgoing["id"],
            "error": {"code": -32603, "message": "Synthetic internal error"}}),
    )
    .await;
    let events = drain(&mut opened.events).await;
    assert!(
        events
            .iter()
            .any(|kind| matches!(kind, EventKind::SubAgentStarted(_))),
        "{events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|kind| matches!(kind, EventKind::SubAgentEnded { .. })),
        "{events:?}"
    );
    assert!(events.iter().any(|kind| matches!(
        kind,
        EventKind::TurnEnded {
            outcome: TurnOutcome::Failed(_),
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
        checkpoints.iter().any(|checkpoint| {
            checkpoint.len() > "α\n".len()
                && checkpoint.len() < before_answer.len()
                && before_answer.starts_with(checkpoint)
        }),
        "expected an intermediate checkpoint before the answer flush"
    );
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
async fn file_reports_change_only_when_tools_report_new_file_facts() {
    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    assert_eq!(
        opened.runtime.submit(start_turn("file-facts")).await,
        DispatchOutcome::Written
    );
    let prompt = peer.written().await;
    let update = |update| {
        json!({"jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": "session-1", "update": update}})
    };
    let diff = |new_text| json!([{"type": "diff", "path": "/workspace/file", "newText": new_text}]);
    for frame in [
        json!({"sessionUpdate": "tool_call", "toolCallId": "edit", "kind": "edit",
            "title": "Edit file", "status": "completed", "content": diff("line one\n")}),
        json!({"sessionUpdate": "tool_call_update", "toolCallId": "edit",
            "content": diff("same line count\n")}),
        json!({"sessionUpdate": "tool_call", "toolCallId": "command", "kind": "execute",
            "title": "Run command", "status": "in_progress"}),
        json!({"sessionUpdate": "tool_call_update", "toolCallId": "command",
            "rawOutput": {"output": "command output"}}),
        json!({"sessionUpdate": "tool_call", "toolCallId": "second-edit", "kind": "edit",
            "title": "Edit file again", "status": "completed", "content": diff("line one\nline two\n")}),
        json!({"sessionUpdate": "tool_call_update", "toolCallId": "edit",
            "rawOutput": {"output": "late output from the first edit"}}),
    ] {
        send(&mut peer, &update(frame)).await;
    }
    send(
        &mut peer,
        &json!({"jsonrpc": "2.0", "id": prompt["id"], "result": {"stopReason": "end_turn"}}),
    )
    .await;

    let mut updates = Vec::new();
    let mut reports = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match opened.events.recv().await.expect("Prompt event").kind {
                EventKind::ToolUpdated { item, output, .. } => updates.push((item.0, output)),
                EventKind::FilesChanged { files, .. } => {
                    assert_eq!(files.len(), 1);
                    assert_eq!(files[0].path, "/workspace/file");
                    reports.push(files[0].added_lines);
                }
                EventKind::TurnEnded { outcome, .. } => {
                    assert_eq!(outcome, TurnOutcome::Completed);
                    break;
                }
                _ => {}
            }
        }
    })
    .await
    .expect("file facts Prompt must end");
    assert_eq!(
        updates
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        ["edit", "edit", "command", "command", "second-edit", "edit"]
    );
    assert_eq!(updates[3].1.as_deref(), Some("command output"));
    assert_eq!(
        updates[5].1.as_deref(),
        Some("late output from the first edit")
    );
    assert_eq!(reports, [Some(1), Some(2)]);
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
    use crate::InteractionResolution;

    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    assert_eq!(
        opened.runtime.submit(start_turn("saturation")).await,
        DispatchOutcome::Written
    );
    let prompt = peer.written().await;
    let mut permission = recorded_permission();
    permission["id"] = json!("approval-0");
    send(&mut peer, &permission).await;
    let answered = next_approval(&mut opened.events).await;
    let mut pending = Vec::new();
    for number in 1..32 {
        permission["id"] = json!(format!("approval-{number}"));
        send(&mut peer, &permission).await;
        pending.push(next_approval(&mut opened.events).await);
    }
    let stale = pending[0].clone();
    let allow = |request| InteractionResponse {
        generation: GENERATION,
        request,
        answer: InteractionAnswer::NativeApproval("allow".into()),
    };
    assert_eq!(
        opened.runtime.respond(allow(answered)).await,
        RespondOutcome::Sent
    );
    assert_eq!(
        peer.written().await,
        json!({"jsonrpc": "2.0", "id": "approval-0", "result": {
            "outcome": {"outcome": "selected", "optionId": "allow"}
        }})
    );

    permission["id"] = json!("approval-1");
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
    let (outcome, events) = prompt_end(&mut opened.events, "saturation").await;
    assert_eq!(outcome, TurnOutcome::Completed, "approval-cap Prompt");
    let mut withdrawn: Vec<_> = events
        .into_iter()
        .filter_map(|kind| match kind {
            EventKind::InteractionResolved {
                request,
                resolution: InteractionResolution::Withdrawn,
            } => Some(request),
            _ => None,
        })
        .collect();
    withdrawn.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    pending.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(withdrawn, pending);
    assert_eq!(
        opened.runtime.submit(start_turn("recovery")).await,
        DispatchOutcome::Written
    );
    let recovery = peer.written().await;
    assert_eq!(recovery["method"], "session/prompt");
    permission["id"] = json!("approval-1");
    send(&mut peer, &permission).await;
    let next = next_approval(&mut opened.events).await;
    assert_eq!(
        opened.runtime.respond(allow(stale)).await,
        RespondOutcome::NotSent(Refusal::UnknownRequest)
    );
    assert_eq!(
        opened.runtime.respond(allow(next)).await,
        RespondOutcome::Sent
    );
    assert_eq!(
        peer.written().await,
        json!({"jsonrpc": "2.0", "id": "approval-1", "result": {
            "outcome": {"outcome": "selected", "optionId": "allow"}
        }})
    );
    send(
        &mut peer,
        &json!({"jsonrpc": "2.0", "id": recovery["id"], "result": {"stopReason": "end_turn"}}),
    )
    .await;
    let (outcome, _) = prompt_end(&mut opened.events, "recovery").await;
    assert_eq!(outcome, TurnOutcome::Completed, "recovery Prompt");
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

#[tokio::test(start_paused = true)]
async fn resume_errors_distinguish_missing_history_from_other_native_failures() {
    let missing = "Failed to read session session-missing; retry, or load it with session/load";
    for (fixture, expected, message) in [
        (
            MISSING_RESUME.to_owned(),
            ProblemKind::NativeHistoryUnavailable,
            missing,
        ),
        (
            MISSING_RESUME.replace(
                "Failed to read session session-missing",
                "Failed to read session another-session",
            ),
            ProblemKind::Other,
            "Failed to read session another-session; retry, or load it with session/load",
        ),
        (
            MISSING_RESUME.replace(missing, "Configured model not found"),
            ProblemKind::Other,
            "Configured model not found",
        ),
        (
            MISSING_RESUME
                .replace(missing, "Method not found")
                .replace("-32603", "-32601"),
            ProblemKind::NativeHistoryUnavailable,
            "Method not found",
        ),
    ] {
        let (mut peer, io) = pipes();
        let native_session = NativeSessionId::new("session-missing");
        let resume = request(SessionStart::Resume(native_session));
        let opening = tokio::spawn(runtime::open(io, resume, settings::OWN.to_owned()));
        startup(&mut peer, &fixture).await;
        let problem = opening.await.unwrap().unwrap_err();
        assert_eq!(problem.message, message);
        assert_eq!(problem.kind, expected, "native error: {message}");
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

use crate::conformance::{NewTurn, Provider, SubAgentApprovals, SubAgentFrames};
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

    fn sub_agent_frames(&self) -> SubAgentFrames {
        SubAgentFrames::EndWithThePrompt
    }

    fn sub_agent_approvals(&self) -> SubAgentApprovals {
        SubAgentApprovals::EndsWithTheTurn
    }

    async fn play_sub_agent_approval(&mut self, _id: &str) -> NativeRequestId {
        // A child conversation's command asks, named by the prefix of its tool call.
        let frames = recorded(RESUME);
        let mut permission = frames
            .iter()
            .find(|frame| frame["server"]["method"] == "session/request_permission")
            .unwrap()["server"]
            .clone();
        permission["params"]["toolCall"]["toolCallId"] = json!("child_1:call_1");
        send(&mut self.peer, &permission).await;
        drain(&mut self.opened.events)
            .await
            .into_iter()
            .find_map(|kind| match kind {
                EventKind::InteractionRequested(request) => {
                    assert_eq!(
                        request.owner,
                        Some(crate::NativeSubAgentId::new("child_1")),
                        "it names the child conversation"
                    );
                    Some(request.request)
                }
                _ => None,
            })
            .expect("agy asked on the child's behalf")
    }

    async fn end_parent_turn(&mut self, _id: &str) {
        let id = self.prompt.take().expect("a prompt in flight")["id"].clone();
        send(
            &mut self.peer,
            &json!({"jsonrpc":"2.0","id":id,"result":{"stopReason":"end_turn","usage":{
                "inputTokens":1,"outputTokens":1,"cachedReadTokens":0,"cachedWriteTokens":0,
                "thoughtTokens":0,"totalTokens":2}}}),
        )
        .await;
    }

    async fn play_sub_agent_at_rest(&mut self) {
        // The frames of a sub-agent's tool call, named by its prefix, after the prompt
        // that held it has ended: nothing of it is a turn or a sub-agent.
        for frame in [
            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{
                "sessionUpdate":"tool_call","toolCallId":"child_1:call_1","title":"Read rate-limit.ts",
                "kind":"read","status":"in_progress","rawInput":{"AbsolutePath":"/work/chat-1/src/rate-limit.ts"}
            }}}),
            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{
                "sessionUpdate":"tool_call_update","toolCallId":"child_1:call_1","status":"completed"
            }}}),
        ] {
            send(&mut self.peer, &frame).await;
        }
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

async fn prompt_end(events: &mut EventStream, submission: &str) -> (TurnOutcome, Vec<EventKind>) {
    let mut preceding = Vec::new();
    let outcome = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events
                .recv()
                .await
                .unwrap_or_else(|| panic!("event stream closed before Prompt {submission} ended"));
            match event.kind {
                EventKind::TurnEnded {
                    outcome,
                    submissions,
                    ..
                } if submissions.iter().any(|id| id.0 == submission) => {
                    return outcome;
                }
                kind => preceding.push(kind),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("Prompt {submission} did not end within five seconds"));
    (outcome, preceding)
}

// The cancel notification cannot fit in this pipe without the peer reading.
async fn interruption_peer() -> (Peer, OpenedRuntime, Value, NativeTurnId, NativeRequestId) {
    let (mut peer, io) = crate::scripted::pipes_with_input_capacity(32);
    let opening = tokio::spawn(runtime::open(
        io,
        request(SessionStart::New),
        settings::OWN.to_owned(),
    ));
    startup(&mut peer, PROMPT).await;
    let mut opened = opening.await.unwrap().unwrap();
    let (write, prompt) = tokio::join!(
        opened.runtime.submit(start_turn("old-prompt")),
        peer.written()
    );
    assert_eq!(write, DispatchOutcome::Written);
    let mut permission = recorded_permission();
    permission["id"] = json!("already-answered");
    send(&mut peer, &permission).await;
    let answered = next_approval(&mut opened.events).await;
    let (outcome, reply) = tokio::join!(
        opened.runtime.respond(allow_approval(answered)),
        peer.written(),
    );
    assert_eq!(outcome, RespondOutcome::Sent);
    assert_eq!(reply["id"], "already-answered");
    assert_eq!(reply["result"]["outcome"]["outcome"], "selected");
    permission["id"] = json!("old-first");
    send(&mut peer, &permission).await;
    let first = next_approval(&mut opened.events).await;
    permission["id"] = json!("old-second");
    send(&mut peer, &permission).await;
    let turn = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let EventKind::InteractionRequested(approval) =
                opened.events.recv().await.expect("permission event").kind
            {
                return approval.turn.expect("approval's Turn");
            }
        }
    })
    .await
    .expect("the second unanswered approval must be shown");
    (peer, opened, prompt, turn, first)
}

fn allow_approval(request: NativeRequestId) -> InteractionResponse {
    InteractionResponse {
        generation: GENERATION,
        request,
        answer: InteractionAnswer::NativeApproval("allow".to_owned()),
    }
}

#[tokio::test(start_paused = true)]
async fn interrupt_answers_the_original_permissions_after_its_prompt_ends() {
    use std::{
        future::{Future, poll_fn},
        pin::pin,
        task::Poll,
    };

    use crate::{InteractionResolution, InterruptOutcome, InterruptRequest};

    let (mut peer, mut opened, original, turn, pending) = interruption_peer().await;
    let stop = InterruptRequest {
        generation: GENERATION,
        expected_turn: turn,
    };
    let mut interrupt = pin!(opened.runtime.interrupt(stop.clone()));
    poll_fn(|cx| {
        assert!(interrupt.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    let mut duplicate = recorded_permission();
    duplicate["id"] = json!("already-answered");
    send(&mut peer, &duplicate).await;
    send(
        &mut peer,
        &json!({"jsonrpc": "2.0", "id": original["id"], "result": {"stopReason": "cancelled"}}),
    )
    .await;
    let (outcome, events) = prompt_end(&mut opened.events, "old-prompt").await;
    assert_eq!(outcome, TurnOutcome::Interrupted);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event,
                EventKind::InteractionResolved {
                    resolution: InteractionResolution::Withdrawn,
                    ..
                }
            ))
            .count(),
        2
    );

    let read = async {
        assert_eq!(peer.written().await["method"], "session/cancel");
        let mut cancelled = Vec::new();
        for _ in 0..2 {
            let reply = peer.written().await;
            assert_eq!(
                reply["result"]["outcome"]["outcome"], "cancelled",
                "{reply}"
            );
            cancelled.push(reply["id"].as_str().unwrap().to_owned());
        }
        cancelled.sort_unstable();
        assert_eq!(cancelled, ["old-first", "old-second"]);
        assert_eq!(peer.written().await["method"], "session/prompt");
    };
    let (outcome, wrote, stale, ()) = tokio::join!(
        interrupt,
        opened.runtime.submit(start_turn("next-prompt")),
        opened.runtime.respond(allow_approval(pending)),
        read,
    );
    assert_eq!(outcome, InterruptOutcome::Acknowledged);
    assert_eq!(wrote, DispatchOutcome::Written);
    assert_eq!(stale, RespondOutcome::NotSent(Refusal::UnknownRequest));
    assert!(matches!(
        opened.runtime.interrupt(stop).await,
        InterruptOutcome::NotSent(Refusal::TurnMismatch { active: Some(_) })
    ));

    let mut permission = recorded_permission();
    permission["id"] = json!("old-first");
    send(&mut peer, &permission).await;
    let selected = next_approval(&mut opened.events).await;
    let (outcome, reply) = tokio::join!(
        opened.runtime.respond(allow_approval(selected)),
        peer.written(),
    );
    assert_eq!(outcome, RespondOutcome::Sent);
    assert_eq!(reply["id"], "old-first");
    assert_eq!(reply["result"]["outcome"]["outcome"], "selected");
    peer.assert_nothing_written().await;
}

#[tokio::test(start_paused = true)]
async fn interrupt_is_unconfirmed_if_a_captured_permission_reply_cannot_be_written() {
    use std::{
        future::{Future, poll_fn},
        pin::pin,
        task::Poll,
    };

    use crate::{InterruptOutcome, InterruptRequest};

    let (mut peer, mut opened, original, turn, _) = interruption_peer().await;
    let mut interrupt = pin!(opened.runtime.interrupt(InterruptRequest {
        generation: GENERATION,
        expected_turn: turn,
    }));
    poll_fn(|cx| {
        assert!(interrupt.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    send(
        &mut peer,
        &json!({"jsonrpc": "2.0", "id": original["id"], "result": {"stopReason": "cancelled"}}),
    )
    .await;
    assert_eq!(
        prompt_end(&mut opened.events, "old-prompt").await.0,
        TurnOutcome::Interrupted
    );
    let read_cancel = async {
        assert_eq!(peer.written().await["method"], "session/cancel");
        drop(peer);
    };
    let (outcome, ()) = tokio::join!(interrupt, read_cancel);
    assert_eq!(outcome, InterruptOutcome::Unconfirmed);
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
    let events = drain(&mut opened.events).await;
    assert!(events.iter().any(|kind| matches!(
        kind,
        EventKind::ToolUpdated { item, status: ToolStatus::Failed, output: None, .. }
            if item.0 == "earlier-failure"
    )));
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
    let failure_output = "output from the earlier failed command";
    send(
        &mut peer,
        &update(
            json!({"sessionUpdate":"tool_call_update","toolCallId":"earlier-failure",
            "rawOutput":{"exit_code":1,"output":failure_output}}),
        ),
    )
    .await;
    let before_reply = drain(&mut opened.events).await;
    assert!(
        !before_reply
            .iter()
            .any(|kind| matches!(kind, EventKind::TurnEnded { .. })),
        "the turn ended before the cancelled Prompt reply"
    );
    let last_tool_update = |id: &str| {
        before_reply.iter().rev().find_map(|kind| match kind {
            EventKind::ToolUpdated {
                item,
                status,
                output,
                ..
            } if item.0 == id => Some((*status, output.as_deref())),
            _ => None,
        })
    };
    assert!(matches!(
        last_tool_update(tool.as_str().unwrap()),
        Some((ToolStatus::FailedAfterInterrupt, _))
    ));
    assert_eq!(
        last_tool_update("earlier-failure"),
        Some((ToolStatus::Failed, Some(failure_output)))
    );

    send(
        &mut peer,
        &json!({"jsonrpc":"2.0","id":outgoing["id"],"result":{"stopReason":"cancelled"}}),
    )
    .await;
    let after_reply = drain(&mut opened.events).await;

    assert_eq!(
        crate::outcome::read_end(&after_reply),
        Some(TurnOutcome::Interrupted)
    );
    assert!(before_reply.iter().chain(&after_reply).any(|kind| matches!(
        kind,
        EventKind::InteractionResolved { request, resolution: InteractionResolution::Withdrawn }
            if request == &approval.request
    )));
    opened.runtime.close().await;
}
