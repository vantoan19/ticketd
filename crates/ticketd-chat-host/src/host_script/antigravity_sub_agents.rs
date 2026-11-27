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
    ChatItem, ChatOwner, ChatSubAgent, ChatSubAgentState, ChatTurnState,
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
    assert_eq!(record.said("description").as_deref(), Some("Session Auditor"));
    assert!(
        record
            .said("prompt")
            .is_some_and(|prompt| prompt.starts_with("Scan the session routes in src/auth"))
    );
    // The Chat's model is the sub-agent's.
    assert_eq!(record.said("model").as_deref(), Some("gemini-3.1-pro"));
    assert_eq!(state_of(&h, FIRST), ChatSubAgentState::Running);
    assert!(
        record.tool_id.as_deref().is_some_and(|tool| tool.ends_with(":call_1")),
        "started by the launch call: {record:?}"
    );

    // Its approval is asked in the Chat and waits for the person.
    assert_eq!(h.live().await.interactions.len(), 1);
    allow(&mut h).await;
    h.play_to("the sub-agent's command ended").await;
    assert_eq!(h.sub_agent_transcript(FIRST), ["tool rg -n \"session.regenerate\" src/auth completed"]);

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

    let owned = h.items().iter().filter(|item| owned_by(item, FIRST)).count();
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
