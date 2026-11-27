//! Antigravity sub-agents through the whole host: ACP traffic from a fixture, the real
//! Antigravity runtime, supervisor and core, and what the Chat's history says after.
//! The fixtures are converted from live agy 1.5.17 captures (see each one's first line).
//!
//! Antigravity names no sub-agent: a child conversation's tool calls arrive on the main
//! agent's session as `<childId>:call_...`, and its Prompt is held open until the children
//! finish. So a sub-agent exists from its first tool call and ends with the Prompt.

use super::{HostScript, fixture};
use crate::InteractionAnswer;
use ticketd_core::{
    ChatItem, ChatOwner, ChatSubAgent, ChatSubAgentState, ChatSubAgentStopper, ChatTurnState,
};

const FIRST: &str = "00000000-0000-4000-8000-0000000000c1";
const SECOND: &str = "00000000-0000-4000-8000-0000000000c2";

/// Antigravity's approvals are its own choices: "Allow" is `allow`.
async fn allow(h: &mut HostScript) {
    h.answer(InteractionAnswer::NativeApproval("allow".to_owned()))
        .await;
}

fn state_of(h: &HostScript, native_id: &str) -> ChatSubAgentState {
    h.sub_agents()
        .iter()
        .find(|record| record.native_id == native_id)
        .and_then(ChatSubAgent::latest)
        .map(|run| run.state)
        .expect("a sub-agent with a run")
}

#[tokio::test(start_paused = true)]
async fn a_childs_tool_calls_are_a_sub_agents_steps_and_it_ends_with_the_prompt() {
    let mut h = HostScript::antigravity()
        .process([fixture!("antigravity", "sub_agent")])
        .start();
    h.send("Audit the session routes with a sub-agent").await;
    h.play_to("the prompt was written").await;

    // Antigravity names no child when it starts one: nothing shows until its first step.
    h.play_to("the main agent launched a sub-agent that has not shown a step yet")
        .await;
    assert!(h.sub_agents().is_empty());

    // The child's first step starts it: the record carries what the launch call said.
    h.play_to("the sub-agent's command asks to run").await;
    let records = h.sub_agents();
    assert_eq!(records.len(), 1, "{records:?}");
    let record = &records[0];
    assert_eq!(record.native_id, FIRST);
    assert_eq!(record.parent, None);
    assert_eq!(
        record.said("description").as_deref(),
        Some("Session Auditor")
    );
    assert!(
        record
            .said("prompt")
            .is_some_and(|prompt| prompt.starts_with("Scan the session routes in src/auth"))
    );
    // The Chat's model is the sub-agent's.
    assert_eq!(record.said("model").as_deref(), Some("gemini-3.1-pro"));
    assert_eq!(state_of(&h, FIRST), ChatSubAgentState::Running);
    assert!(
        record
            .tool_id
            .as_deref()
            .is_some_and(|tool| tool.ends_with(":call_1")),
        "started by the launch call: {record:?}"
    );

    // Its approval is asked in the Chat and waits for the person.
    assert_eq!(h.live().await.interactions.len(), 1);
    allow(&mut h).await;
    h.play_to("the sub-agent's command ended").await;
    assert_eq!(
        h.sub_agent_transcript(FIRST),
        ["tool rg -n \"session.regenerate\" src/auth completed"]
    );

    // The main agent has said its last words; the Prompt, and so the sub-agent, goes on.
    h.play_to("the main agent said its last words and the prompt is still open")
        .await;
    assert_eq!(state_of(&h, FIRST), ChatSubAgentState::Running);
    assert_eq!(h.turns()[0].state, ChatTurnState::Active);

    h.play_all().await;
    h.finish().await;
    assert_eq!(state_of(&h, FIRST), ChatSubAgentState::Completed);
    assert!(h.sub_agents()[0].runs[0].ended_at.is_some());
    assert_eq!(h.turns().len(), 1, "a sub-agent's frames open no turn");
    assert_eq!(h.turns()[0].state, ChatTurnState::Completed);

    // The main transcript has its own Step and words, and one row for the sub-agent,
    // not the child's command.
    let transcript = h.transcript();
    assert!(
        transcript
            .iter()
            .any(|line| line == "sub-agent \"Session Auditor\" completed"),
        "{transcript:?}"
    );
    assert!(
        !transcript
            .iter()
            .any(|line| line.starts_with("tool ") && line.contains("session.regenerate")),
        "{transcript:?}"
    );
    assert!(h.notices().is_empty(), "{:?}", h.notices());
}

fn owned_by(item: &ChatItem, native_id: &str) -> bool {
    let owner = match item {
        ChatItem::Tool(tool) => &tool.owner,
        ChatItem::Message(message) => &message.owner,
        _ => return false,
    };
    *owner
        == ChatOwner::SubAgent {
            native_id: native_id.to_owned(),
        }
}

#[tokio::test(start_paused = true)]
async fn what_a_child_does_is_stored_with_its_owner_and_the_parent_says_nothing_of_it() {
    let mut h = HostScript::antigravity()
        .process([fixture!("antigravity", "sub_agent")])
        .start();
    h.send("Audit the session routes with a sub-agent").await;
    h.play_to("the prompt was written").await;
    h.play_to("the main agent launched a sub-agent that has not shown a step yet")
        .await;
    h.play_to("the sub-agent's command asks to run").await;
    allow(&mut h).await;
    h.play_all().await;
    h.finish().await;

    let owned = h
        .items()
        .iter()
        .filter(|item| owned_by(item, FIRST))
        .count();
    assert_eq!(owned, 1);
    // The main agent's words are one message: the child's step did not cut them in two.
    let said: Vec<_> = h
        .transcript()
        .into_iter()
        .filter(|line| line.starts_with("agent: "))
        .collect();
    assert_eq!(said.len(), 1, "{said:?}");
    assert!(said[0].contains("waiting for its findings"), "{said:?}");
    assert!(said[0].contains("regenerates the session id"), "{said:?}");
}

#[tokio::test(start_paused = true)]
async fn stopping_the_chat_stops_its_sub_agent_and_a_late_update_opens_nothing() {
    let mut h = HostScript::antigravity()
        .process([fixture!("antigravity", "sub_agent_stop")])
        .start();
    h.send("Run the slow check in a sub-agent").await;
    h.play_to("the prompt was written").await;
    h.play_to("the sub-agent's command asks to run").await;
    allow(&mut h).await;
    h.play_to("the sub-agent's command runs").await;
    assert_eq!(state_of(&h, FIRST), ChatSubAgentState::Running);

    // Stop is the Chat's: one `session/cancel` ends the command, the Prompt and the
    // sub-agent, which Antigravity cannot stop alone.
    h.stop().await;
    h.play_all().await;
    h.finish().await;

    let record = &h.sub_agents()[0];
    let run = record.latest().expect("a run");
    assert_eq!(
        (run.state, run.stopped_by),
        (
            ChatSubAgentState::Stopped,
            Some(ChatSubAgentStopper::Person)
        )
    );
    assert_eq!(h.turns().len(), 1);
    // The command's last update came after the reply: no Prompt was in flight to take it.
    assert_eq!(h.sub_agent_transcript(FIRST).len(), 1);
    assert!(h.notices().is_empty(), "{:?}", h.notices());
}

#[tokio::test(start_paused = true)]
async fn parallel_sub_agents_are_told_apart_by_their_ids_and_named_only_when_that_is_sure() {
    let mut h = HostScript::antigravity()
        .process([fixture!("antigravity", "sub_agent_two")])
        .start();
    h.send("Check the tests and the docs with two sub-agents")
        .await;
    h.play_to("the prompt was written").await;
    h.play_to("the main agent launched two sub-agents").await;
    h.play_to("the first sub-agent's command asks to run").await;
    allow(&mut h).await;
    h.play_to("the second sub-agent's command asks to run")
        .await;
    allow(&mut h).await;
    h.play_to("both sub-agents' commands run").await;

    let records = h.sub_agents();
    assert_eq!(
        records
            .iter()
            .map(|record| record.native_id.as_str())
            .collect::<Vec<_>>(),
        [FIRST, SECOND]
    );
    // Two launches were open when each child appeared: which child was which is not
    // known, so neither is given a name or a brief it might not have.
    for record in &records {
        assert_eq!(record.said("description"), None, "{record:?}");
        assert_eq!(record.said("prompt"), None, "{record:?}");
        assert_eq!(record.said("model").as_deref(), Some("gemini-3.1-pro"));
    }
    // Each one's command is its own Step.
    assert_eq!(h.sub_agent_transcript(FIRST).len(), 1);
    assert_eq!(h.sub_agent_transcript(SECOND).len(), 1);

    // One finishing does not end the other, or the Chat's turn.
    h.play_to("both sub-agents' commands ended").await;
    assert_eq!(state_of(&h, FIRST), ChatSubAgentState::Running);
    assert_eq!(state_of(&h, SECOND), ChatSubAgentState::Running);
    h.play_all().await;
    h.finish().await;
    assert_eq!(state_of(&h, FIRST), ChatSubAgentState::Completed);
    assert_eq!(state_of(&h, SECOND), ChatSubAgentState::Completed);
    assert_eq!(h.turns().len(), 1);
}

// --- Write credit -----------------------------------------------------------------------

/// What the sub-agent's command does: `ticketd activity add` as the Chat's agent, with
/// the variable Antigravity sets on every command it runs (`call` is the ID of the tool
/// call that runs it; `None`: no variable).
fn add_activity(h: &HostScript, call: Option<(&str, &str)>, brief: &str) {
    let path = h.workspace_path();
    let test = std::env::current_exe().expect("the test executable");
    let binary = test
        .parent()
        .and_then(std::path::Path::parent)
        .expect("target/debug")
        .join(if cfg!(windows) {
            "ticketd.exe"
        } else {
            "ticketd"
        });
    assert!(
        binary.exists(),
        "{} is missing: run `cargo build -p ticketd-cli` first",
        binary.display()
    );
    let mut command = std::process::Command::new(binary);
    command
        .args(["activity", "add", "T-KQ1", "--brief", brief])
        .env("TICKETD_TEST_WORKSPACE", path)
        .env("XDG_DATA_HOME", path.parent().expect("a folder"))
        .env(ticketd_core::CHAT_ID_VARIABLE, h.chat_id())
        .env_remove("CODEX_TOOL_CALL_ID")
        .env_remove("ANTIGRAVITY_SOURCE_METADATA");
    if let Some((conversation, id)) = call {
        let metadata = serde_json::json!({"tool": {
            "conversationId": conversation,
            "stepIndex": 3,
            "toolCall": {"id": id, "name": "run_command", "argumentsJson": "{}"},
        }});
        command.env("ANTIGRAVITY_SOURCE_METADATA", metadata.to_string());
    }
    let output = command.output().expect("ticketd runs");
    assert!(
        output.status.success(),
        "ticketd failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn credits(h: &HostScript) -> Vec<(String, Option<String>)> {
    let core = h.core();
    let credits = core.ticket_write_credits("T-KQ1").expect("credits");
    let mut found: Vec<_> = core
        .activities("T-KQ1", 100, 0)
        .expect("activities")
        .into_iter()
        .filter_map(|activity| {
            let credit = credits.activities.get(&activity.id)?;
            Some((activity.brief, credit.sub_agent.clone()))
        })
        .collect();
    found.sort();
    found
}

#[tokio::test(start_paused = true)]
async fn a_write_is_credited_to_the_sub_agent_whose_tool_call_the_key_names_even_while_two_overlap()
{
    let mut h = HostScript::antigravity()
        .process([fixture!("antigravity", "sub_agent_two")])
        .start();
    h.core().create_ticket("Review the rate limiter").unwrap();
    h.send("Check the tests and the docs with two sub-agents")
        .await;
    h.play_to("the prompt was written").await;
    h.play_to("the main agent launched two sub-agents").await;
    h.play_to("the first sub-agent's command asks to run").await;
    allow(&mut h).await;
    h.play_to("the second sub-agent's command asks to run")
        .await;
    allow(&mut h).await;
    h.play_to("both sub-agents' commands run").await;

    // Both commands are open, so only the key can say which one wrote.
    add_activity(&h, Some((FIRST, "call_3")), "From the first");
    add_activity(&h, Some((SECOND, "call_4")), "From the second");
    // No key: the commit-order window decides, as for a harness that gives none. Only
    // the second command's own `ticketd` call could have written an Activity.
    add_activity(&h, None, "From a command with no key");
    // A key no Step has is never guessed from the windows that happen to be open.
    add_activity(
        &h,
        Some((FIRST, "call_unknown")),
        "From a call nobody recorded",
    );
    h.play_all().await;
    h.finish().await;

    assert_eq!(
        credits(&h),
        [
            ("From a call nobody recorded".to_owned(), None),
            (
                "From a command with no key".to_owned(),
                Some(SECOND.to_owned()),
            ),
            ("From the first".to_owned(), Some(FIRST.to_owned())),
            ("From the second".to_owned(), Some(SECOND.to_owned())),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn a_sub_agent_launched_by_a_sub_agent_is_nested_under_it() {
    let mut h = HostScript::antigravity()
        .process([fixture!("antigravity", "sub_agent_nested")])
        .start();
    h.send("Audit the session routes with a sub-agent").await;
    h.play_to("the prompt was written").await;
    h.play_to("the main agent launched a sub-agent").await;
    h.play_to("the sub-agent launched one of its own").await;
    h.play_to("the nested sub-agent ran a command").await;

    let records = h.sub_agents();
    let find = |id: &str| {
        records
            .iter()
            .find(|record| record.native_id == id)
            .unwrap()
    };
    assert_eq!(find(FIRST).parent, None);
    assert_eq!(
        find(FIRST).said("description").as_deref(),
        Some("Lead Auditor")
    );
    assert_eq!(find(SECOND).parent.as_deref(), Some(FIRST));
    assert_eq!(
        find(SECOND).said("description").as_deref(),
        Some("Sign-in Checker")
    );
    // The main transcript has the one row; the nested one is in its parent's view.
    let rows: Vec<_> = h
        .transcript()
        .into_iter()
        .filter(|line| line.starts_with("sub-agent"))
        .collect();
    assert_eq!(rows, ["sub-agent \"Lead Auditor\" running"]);
    h.play_all().await;
    h.finish().await;
    assert_eq!(state_of(&h, SECOND), ChatSubAgentState::Completed);
}
