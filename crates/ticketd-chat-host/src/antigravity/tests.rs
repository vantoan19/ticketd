use std::{path::PathBuf, time::Duration};

use serde_json::{Value, json};

use crate::conformance::{GENERATION, drain, open_request, start_turn};
use crate::scripted::{Peer, pipes};
use crate::{
    DispatchOutcome, EventKind, HarnessSettings, InteractionAnswer, InteractionKind,
    InteractionResponse, NativeSessionId, OpenRequest, OpenedRuntime, ProblemKind, Refusal,
    RespondOutcome, SessionStart, SettingChange, SettingKey, SettingOutcome, TurnOutcome,
};

use super::{runtime, settings};

const PROMPT: &str = include_str!("../../tests/fixtures/antigravity/prompt.jsonl");
const QUESTION: &str = include_str!("../../tests/fixtures/antigravity/question.jsonl");
const MODES: &str = include_str!("../../tests/fixtures/antigravity/session-modes.jsonl");
const RESUME: &str = include_str!("../../tests/fixtures/antigravity/resume-own-settings.jsonl");
const SIGNED_OUT: &str = include_str!("../../tests/fixtures/antigravity/signed-out.jsonl");

fn recorded(fixture: &str) -> Vec<Value> {
    fixture
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

async fn send(peer: &mut Peer, frame: &Value) {
    peer.send(&format!("{frame}\n")).await;
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
    opened.runtime.close().await;
}

#[tokio::test]
async fn large_approval_input_keeps_the_exact_command() {
    let (mut peer, mut opened) = open(PROMPT, SessionStart::New, settings::OWN).await;
    assert_eq!(
        opened.runtime.submit(start_turn("tool")).await,
        DispatchOutcome::Written
    );
    assert_eq!(peer.written().await["method"], "session/prompt");

    let command = "printf '%s' 'fixture command'";
    let path = format!("/workspace/{}", "a".repeat(3500));
    send(
        &mut peer,
        &json!({
            "jsonrpc": "2.0",
            "id": "permission-1",
            "method": "session/request_permission",
            "params": {
                "sessionId": "session-1",
                "toolCall": {
                    "toolCallId": "tool-1",
                    "title": "Print a marker",
                    "kind": "execute",
                    "rawInput": {
                        "CommandLine": command,
                        "AbsolutePath": path,
                        "TargetFile": path,
                        "SourcePath": path,
                        "DestinationPath": path,
                        "WorkingDirectory": path
                    }
                },
                "options": [{"optionId": "allow", "name": "Allow", "kind": "allow_once"}]
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
        EventKind::InteractionRequested(_),
    ] = events.as_slice()
    else {
        panic!("expected tool evidence followed by approval");
    };
    assert!(detail.payload().len() <= crate::MAX_PROVIDER_DETAIL_BYTES);
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
    assert_eq!(
        steps[0].command.as_ref().map(|shell| shell.exact.as_str()),
        Some(command)
    );
    opened.runtime.close().await;
}

#[tokio::test]
async fn forwards_the_native_warning_and_choice_for_allow_always() {
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
    let warning = "Allowing this command always adds an Antigravity permission rule.";
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
                        "_meta": { "agy.security.warning": warning }
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
            warning,
        ]
    );
    let always = options
        .iter()
        .find(|option| option.label == "Allow always")
        .unwrap();
    assert_eq!(always.id, "provider-option-7");
    let reply = || InteractionResponse {
        generation: GENERATION,
        request: approval.request.clone(),
        answer: InteractionAnswer::NativeApproval(always.id.clone()),
    };
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
async fn signed_out_reports_login_required_without_attempting_authentication() {
    let (mut peer, io) = pipes();
    let opening = tokio::spawn(runtime::open(
        io,
        request(SessionStart::New),
        settings::OWN.to_owned(),
    ));
    startup(&mut peer, SIGNED_OUT).await;
    assert_eq!(
        opening.await.unwrap().unwrap_err().kind,
        ProblemKind::LoginRequired
    );
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
    use crate::{InterruptOutcome, InterruptRequest};
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
    let _ = peer.written().await;
    let frames = recorded(RESUME);
    let permission = frames
        .iter()
        .find(|frame| frame["server"]["method"] == "session/request_permission")
        .unwrap();
    send(&mut peer, &permission["server"]).await;
    let turn = drain(&mut opened.events)
        .await
        .into_iter()
        .find_map(|kind| match kind {
            EventKind::InteractionRequested(request) => request.turn,
            _ => None,
        })
        .unwrap();

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
    opened.runtime.close().await;
}
