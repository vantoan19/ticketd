//! Stop one sub-agent through the whole host: the person stops a single sub-agent, the
//! harness is asked in its own words, and the main agent and the other sub-agents go on.

use super::{HostScript, fixture};
use crate::HostError;
use ticketd_core::{
    ChatItem, ChatOwner, ChatSubAgentRun, ChatSubAgentState, ChatSubAgentStopper, ChatToolState,
    ChatTurnState,
};

const PROMPT: &str = "Before I merge, review the rate limiter on this branch. In parallel: look for ways around it, check that the tests cover the edge cases, and proofread the API docs.";

fn run(h: &HostScript, native_id: &str) -> ChatSubAgentRun {
    h.sub_agents()
        .into_iter()
        .find(|record| record.native_id == native_id)
        .and_then(|record| record.latest().cloned())
        .unwrap_or_else(|| panic!("a run of {native_id}"))
}

fn running_steps_of(h: &HostScript, native_id: &str) -> usize {
    h.items()
        .into_iter()
        .filter(|item| {
            matches!(item, ChatItem::Tool(tool)
                if tool.state == ChatToolState::Running
                    && tool.owner == ChatOwner::SubAgent { native_id: native_id.to_owned() })
        })
        .count()
}

mod claude {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn stopping_one_background_sub_agent_leaves_the_others_and_the_main_agent_running() {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_stop_one"),
            ])
            .start();
        h.send(PROMPT).await;
        h.play_to("the SDK took the input").await;
        h.play_to("the turn ended").await;
        h.play_to("a sub-agent works after the turn ended").await;
        h.play_to("both sub-agents work").await;
        assert_eq!(h.live().await.sub_agents, 2);

        h.stop_sub_agent("task_a").await;
        h.play_to("the person stopped the first sub-agent").await;

        let first = run(&h, "task_a");
        assert_eq!(first.state, ChatSubAgentState::Stopped);
        assert_eq!(first.stopped_by, Some(ChatSubAgentStopper::Person));
        // The other sub-agent runs on, and the Chat is still working for it.
        assert_eq!(run(&h, "task_b").state, ChatSubAgentState::Running);
        assert_eq!(h.live().await.sub_agents, 1);
        assert_eq!(h.attention().await.word, "Working");
        // Nothing was said about stopping several, and the turn was not touched.
        assert!(h.notices().is_empty(), "{:?}", h.notices());
        assert_eq!(h.turns()[0].state, ChatTurnState::Completed);
        assert!(!h.core().chat(h.chat_id()).expect("the Chat").queue_paused);

        h.play_all().await;
        h.finish().await;
        assert_eq!(run(&h, "task_b").state, ChatSubAgentState::Completed);
        // The main agent resumed by itself afterwards.
        assert_eq!(h.turns().len(), 2);
        assert_eq!(h.live().await.sub_agents, 0);
        // The stopped one stays as it was stopped.
        assert_eq!(
            run(&h, "task_a").stopped_by,
            Some(ChatSubAgentStopper::Person)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_sub_agent_that_does_not_run_cannot_be_stopped() {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_stop_one"),
            ])
            .start();
        h.send(PROMPT).await;
        h.play_to("the SDK took the input").await;
        h.play_to("the turn ended").await;
        // Finished already (task_c ended in the turn) and one nobody started.
        for native_id in ["task_c", "task_nobody"] {
            assert!(
                matches!(
                    h.stop_sub_agent_refused(native_id).await,
                    HostError::SubAgentGone
                ),
                "{native_id}"
            );
        }
        // Nothing was written to the harness: the fixture's Stop frame was never asked for.
    }

    #[tokio::test(start_paused = true)]
    async fn a_sub_agent_the_main_agent_stops_is_recorded_as_the_main_agents_doing() {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_stopped_by_main_agent"),
            ])
            .start();
        h.send(PROMPT).await;
        h.play_to("the SDK took the input").await;
        h.play_to("the turn ended").await;
        h.play_to("a sub-agent works after the turn ended").await;
        h.play_to("both sub-agents work").await;
        h.play_to("the main agent stopped the first sub-agent").await;

        let first = run(&h, "task_a");
        assert_eq!(first.state, ChatSubAgentState::Stopped);
        assert_eq!(first.stopped_by, Some(ChatSubAgentStopper::MainAgent));
        // The other one runs on and the person's queue is not paused.
        assert_eq!(run(&h, "task_b").state, ChatSubAgentState::Running);
        assert!(!h.core().chat(h.chat_id()).expect("the Chat").queue_paused);
    }
}
