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

        // The stored history now is what the desktop builds the view of "one stopped" from.
        super::super::sub_agents::background_stored::pinned(&h, "stop_one");

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
        h.play_to("the main agent stopped the first sub-agent")
            .await;

        let first = run(&h, "task_a");
        assert_eq!(first.state, ChatSubAgentState::Stopped);
        assert_eq!(first.stopped_by, Some(ChatSubAgentStopper::MainAgent));
        // The other one runs on and the person's queue is not paused.
        assert_eq!(run(&h, "task_b").state, ChatSubAgentState::Running);
        assert!(!h.core().chat(h.chat_id()).expect("the Chat").queue_paused);
    }
}

mod ticketd {
    use super::*;
    use crate::StopReason;

    async fn two_running(h: &mut HostScript) {
        h.send(PROMPT).await;
        h.play_to("the SDK took the input").await;
        h.play_to("the turn ended").await;
        h.play_to("a sub-agent works after the turn ended").await;
        h.play_to("both sub-agents work").await;
        assert_eq!(h.live().await.sub_agents, 2);
    }

    #[tokio::test(start_paused = true)]
    async fn ticketd_stopping_the_chat_records_its_reason_on_the_sub_agents_it_ended() {
        for (why, key) in [
            (StopReason::TurnedOff, "turned_off"),
            (StopReason::Restore, "restore"),
            (StopReason::Trashed, "trashed"),
        ] {
            let mut h = HostScript::claude()
                .process([
                    fixture!("claude", "handshake"),
                    fixture!("claude", "sub_agent_stop_one"),
                ])
                .start();
            two_running(&mut h).await;

            h.stop_all(why).await;
            h.lose_process(0).await;

            for native_id in ["task_a", "task_b"] {
                let run = run(&h, native_id);
                assert_eq!(run.state, ChatSubAgentState::Stopped, "{key}");
                assert_eq!(run.stopped_by, Some(ChatSubAgentStopper::Ticketd), "{key}");
                assert_eq!(run.stop_reason.as_deref(), Some(key));
            }
            // ticketd's own stop is not the person's: no note of "You stopped".
            assert!(h.notices().is_empty(), "{:?}", h.notices());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn quitting_loses_contact_with_the_sub_agents_instead_of_stopping_them() {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_stop_one"),
            ])
            .start();
        two_running(&mut h).await;
        h.stop_all(StopReason::Quit).await;
        h.lose_process(0).await;
        for native_id in ["task_a", "task_b"] {
            assert_eq!(run(&h, native_id).state, ChatSubAgentState::Lost);
        }
    }
}

mod codex {
    use super::*;

    const ASK: &str = "Start two sub-agents on the slow checks and wait for them";

    #[tokio::test(start_paused = true)]
    async fn stopping_one_child_ends_its_turn_and_commands_and_leaves_the_rest_running() {
        let mut h = HostScript::codex()
            .process([
                fixture!("codex", "handshake"),
                fixture!("codex", "sub_agent_stop_one"),
            ])
            .start();
        h.send(ASK).await;
        h.play_to("two sub-agents run commands").await;
        let mut children: Vec<String> = h
            .sub_agents()
            .into_iter()
            .map(|record| record.native_id)
            .collect();
        children.sort();
        assert_eq!(children.len(), 2, "{children:?}");
        let first = children[0].clone();
        let second = children[1].clone();
        assert_eq!(h.live().await.sub_agents, 2);

        // The fixture's frames: the child's own interrupt, then Codex's cleaning of its
        // terminals, which is what ends a command Codex left running.
        h.stop_sub_agent(&first).await;
        h.play_to("the first sub-agent was stopped").await;

        let stopped = run(&h, &first);
        assert_eq!(stopped.state, ChatSubAgentState::Stopped);
        assert_eq!(stopped.stopped_by, Some(ChatSubAgentStopper::Person));
        // Stop leaves no running command of that child: Codex was told to end them (the
        // fixture holds that frame), and a Step of an ended run reads as not finished.
        // The other child and the main agent's turn go on.
        assert_eq!(run(&h, &second).state, ChatSubAgentState::Running);
        assert_eq!(running_steps_of(&h, &second), 1);
        assert_eq!(h.live().await.sub_agents, 1);
        assert_eq!(h.turns().len(), 1);
        assert_eq!(h.turns()[0].state, ChatTurnState::Active);
        assert!(h.notices().is_empty(), "{:?}", h.notices());

        h.play_all().await;
        h.finish().await;
        assert_eq!(run(&h, &second).state, ChatSubAgentState::Completed);
        assert_eq!(h.turns()[0].state, ChatTurnState::Completed);
        assert_eq!(
            run(&h, &first).stopped_by,
            Some(ChatSubAgentStopper::Person)
        );
    }

    /// Codex leaves a child's commands running when its turn is interrupted; cleaning its
    /// terminals ends them. When that fails the Stop is not a success: the person is told
    /// the commands may still run, and the turn's own end is still recorded.
    #[tokio::test(start_paused = true)]
    async fn a_stop_whose_terminal_cleanup_fails_says_commands_may_still_run() {
        let mut h = HostScript::codex()
            .process([
                fixture!("codex", "handshake"),
                fixture!("codex", "sub_agent_stop_one_cleanup_fails"),
            ])
            .start();
        h.send(ASK).await;
        h.play_to("two sub-agents run commands").await;
        let first = h
            .sub_agents()
            .into_iter()
            .map(|record| record.native_id)
            .min()
            .unwrap();

        let refused = h
            .stop_sub_agent_then_refused(&first, "the first sub-agent was stopped")
            .await;
        let HostError::SubAgentNotStopped(reason) = refused else {
            panic!("{refused:?}");
        };
        assert!(reason.contains("commands"), "{reason}");
        assert_eq!(run(&h, &first).state, ChatSubAgentState::Stopped);
    }

    /// F-X5: Codex completes the command a Stop cut off as failed (exit code -1) after it
    /// reports the child's turn interrupted. The Stop did that: no Step of the stopped
    /// sub-agent is stored as failed.
    #[tokio::test(start_paused = true)]
    async fn a_command_the_stop_cut_off_is_not_stored_as_failed_even_when_it_completes_last() {
        let mut h = HostScript::codex()
            .process([
                fixture!("codex", "handshake"),
                fixture!("codex", "sub_agent_stop_one_late_failure"),
            ])
            .start();
        h.send(ASK).await;
        h.play_to("two sub-agents run commands").await;
        let first = h
            .sub_agents()
            .into_iter()
            .map(|record| record.native_id)
            .min()
            .unwrap();

        h.stop_sub_agent(&first).await;
        h.play_to("the first sub-agent was stopped").await;

        let failed = h
            .items()
            .into_iter()
            .filter(|item| {
                matches!(item, ChatItem::Tool(tool)
                    if tool.state == ChatToolState::Failed
                        && tool.owner == ChatOwner::SubAgent { native_id: first.clone() })
            })
            .count();
        assert_eq!(failed, 0);
    }
}
