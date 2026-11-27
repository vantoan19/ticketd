//! Codex sub-agents through the whole host: recorded app-server traffic from a fixture,
//! the real Codex runtime, supervisor and core, and what the Chat's history says after.
//! The traffic is converted from live codex-cli 0.172.0 captures (see each fixture's
//! first line); the nested and multi-agent v1 cases are hand-built from the same shapes.

use super::{HostScript, fixture};
use ticketd_core::{
    ChatItem, ChatOwner, ChatSubAgent, ChatSubAgentRun, ChatSubAgentState, ChatSubAgentStopper,
    ChatTurnState,
};

/// The child thread of the first fixture, as the fixtures name it.
fn only_sub_agent(h: &HostScript) -> ChatSubAgent {
    let mut records = h.sub_agents();
    assert_eq!(records.len(), 1, "{records:?}");
    records.remove(0)
}

fn runs(record: &ChatSubAgent) -> Vec<(ChatSubAgentState, Option<ChatSubAgentStopper>)> {
    record
        .runs
        .iter()
        .map(|run: &ChatSubAgentRun| (run.state, run.stopped_by))
        .collect()
}

fn latest(h: &HostScript) -> ChatSubAgentState {
    only_sub_agent(h).latest().expect("a run").state
}

#[tokio::test(start_paused = true)]
async fn a_child_thread_is_a_sub_agent_whose_steps_and_words_are_its_own() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent"),
        ])
        .start();
    h.send("Have a sub-agent run echo hi").await;
    h.play_to("the sub-agent runs its command").await;

    // While it runs: one record, started by the main agent, running, with what Codex said.
    let record = only_sub_agent(&h);
    assert_eq!(record.parent, None);
    assert_eq!(record.said("model").as_deref(), Some("gpt-test"));
    assert_eq!(record.said("agentPath").as_deref(), Some("/root/echo_retry"));
    assert_eq!(record.said("description").as_deref(), Some("Echo retry"));
    assert_eq!(latest(&h), ChatSubAgentState::Running);

    h.play_all().await;
    h.finish().await;

    // The main transcript has its own text and Steps and one row for the sub-agent; the
    // sub-agent's command and words are in its own view and nowhere else.
    let transcript = h.transcript();
    assert_eq!(
        transcript
            .iter()
            .filter(|line| line.starts_with("sub-agent"))
            .collect::<Vec<_>>(),
        ["sub-agent \"Echo retry\" completed"],
        "{transcript:?}"
    );
    assert!(
        !transcript.iter().any(|line| line.contains("echo hi'")),
        "{transcript:?}"
    );
    assert_eq!(h.turns().len(), 1, "a child's turn is not a Chat turn");
    assert_eq!(h.turns()[0].state, ChatTurnState::Completed);

    let own = h.sub_agent_transcript(&only_sub_agent(&h).native_id);
    assert_eq!(own.len(), 3, "{own:?}");
    assert_eq!(own[0], "agent: I’ll run `echo hi` and check its output.");
    assert!(own[1].starts_with("tool ") && own[1].ends_with(" completed"), "{own:?}");
    assert_eq!(own[2], "agent: `hi`");
    assert!(h.notices().is_empty(), "{:?}", h.notices());
}

#[tokio::test(start_paused = true)]
async fn a_child_that_finishes_after_the_parents_turn_ended_is_still_followed() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_outlives_turn"),
        ])
        .start();
    h.send("Start one sub-agent on the slow check, do not wait for it, and end your turn")
        .await;
    h.play_to("the parent's turn ended while the sub-agent runs")
        .await;

    // The turn is over and the sub-agent is not.
    assert_eq!(h.turns().len(), 1);
    assert_eq!(h.turns()[0].state, ChatTurnState::Completed);
    assert_eq!(latest(&h), ChatSubAgentState::Running);

    // Its command goes on after the turn ended, and the sub-agent is still not done.
    h.play_to("the sub-agent runs its command").await;
    assert_eq!(latest(&h), ChatSubAgentState::Running);
    assert_eq!(h.turns().len(), 1);

    h.play_all().await;
    h.finish().await;

    assert_eq!(latest(&h), ChatSubAgentState::Completed);
    assert_eq!(h.turns().len(), 1, "a child's turn is not a Chat turn");
    let record = only_sub_agent(&h);
    assert!(record.runs[0].ended_at.is_some());
    let own = h.sub_agent_transcript(&record.native_id);
    assert!(own.contains(&"agent: child-done".to_owned()), "{own:?}");
    assert!(h.notices().is_empty(), "{:?}", h.notices());
}

#[tokio::test(start_paused = true)]
async fn a_new_parent_turn_while_a_child_runs_leaves_the_child_alone() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_new_parent_turn"),
        ])
        .start();
    h.send("Start one sub-agent on the slow check, do not wait for it, and end your turn")
        .await;
    h.play_to("the first turn ended while the sub-agent runs")
        .await;
    assert_eq!(latest(&h), ChatSubAgentState::Running);

    h.send("Reply with PONG").await;
    h.play_all().await;
    h.finish().await;

    let turns = h.turns();
    assert_eq!(turns.len(), 2, "{turns:?}");
    assert!(turns.iter().all(|turn| turn.state == ChatTurnState::Completed));
    // One run, which ended on its own, whatever the parent's turns did.
    let record = only_sub_agent(&h);
    assert_eq!(runs(&record), [(ChatSubAgentState::Completed, None)]);
    let own = h.sub_agent_transcript(&record.native_id);
    assert!(own.iter().any(|line| line.starts_with("tool ")), "{own:?}");
    assert!(
        h.transcript().iter().all(|line| !line.starts_with("tool sleep")),
        "{:?}",
        h.transcript()
    );
}

#[tokio::test(start_paused = true)]
async fn a_childs_new_turn_is_a_new_run_of_the_same_sub_agent() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_rerun"),
        ])
        .start();
    h.send("Start one sub-agent on the sleep check and wait for it")
        .await;
    h.play_to("the sub-agent's turn was interrupted").await;
    // Nobody at ticketd asked for it: Codex closed the child's turn, which is the main
    // agent's doing.
    assert_eq!(
        runs(&only_sub_agent(&h)),
        [(
            ChatSubAgentState::Stopped,
            Some(ChatSubAgentStopper::MainAgent)
        )]
    );

    h.play_to("the main agent asked the sub-agent to go on")
        .await;
    h.play_all().await;
    h.finish().await;

    let record = only_sub_agent(&h);
    assert_eq!(
        runs(&record),
        [
            (
                ChatSubAgentState::Stopped,
                Some(ChatSubAgentStopper::MainAgent)
            ),
            (ChatSubAgentState::Completed, None)
        ]
    );
    assert_eq!(h.turns().len(), 1, "a child's turn is not a Chat turn");
    let rows: Vec<_> = h
        .transcript()
        .into_iter()
        .filter(|line| line.starts_with("sub-agent"))
        .collect();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert!(rows[0].ends_with("stopped"), "{rows:?}");
    assert!(rows[1].contains("(resumed)") && rows[1].ends_with("completed"), "{rows:?}");
}

#[tokio::test(start_paused = true)]
async fn stop_interrupts_the_turn_and_every_live_child_turn() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_stop"),
        ])
        .start();
    h.send("Start one sub-agent on the slow check and wait for it")
        .await;
    h.play_to("the sub-agent runs its command").await;

    h.stop().await;
    h.play_all().await;
    h.finish().await;

    let turns = h.turns();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].state, ChatTurnState::Interrupted);
    assert_eq!(
        runs(&only_sub_agent(&h)),
        [(ChatSubAgentState::Stopped, Some(ChatSubAgentStopper::Person))]
    );
}

#[tokio::test(start_paused = true)]
async fn stop_with_no_turn_running_still_interrupts_the_children() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_stop_at_rest"),
        ])
        .start();
    h.send("Start one sub-agent on the slow check, do not wait for it, and end your turn")
        .await;
    h.play_to("the parent's turn ended while the sub-agent runs")
        .await;
    assert_eq!(latest(&h), ChatSubAgentState::Running);

    h.stop().await;
    h.play_all().await;
    h.finish().await;

    assert_eq!(
        runs(&only_sub_agent(&h)),
        [(ChatSubAgentState::Stopped, Some(ChatSubAgentStopper::Person))]
    );
    // The parent's turn was over: it stays as it ended.
    assert_eq!(h.turns()[0].state, ChatTurnState::Completed);
}

/// Everything a sub-agent owns is stored with its owner.
#[tokio::test(start_paused = true)]
async fn what_a_child_does_is_stored_with_its_owner_and_opens_no_turn() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent"),
        ])
        .start();
    h.send("Have a sub-agent run echo hi").await;
    h.play_all().await;
    h.finish().await;
    let child = only_sub_agent(&h).native_id;
    let owned = h
        .items()
        .into_iter()
        .filter(|item| {
            matches!(item, ChatItem::Tool(tool)
                if tool.owner == ChatOwner::SubAgent { native_id: child.clone() })
        })
        .count();
    assert_eq!(owned, 3);
    assert_eq!(h.turns().len(), 1);
}
