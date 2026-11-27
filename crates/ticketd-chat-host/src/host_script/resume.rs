//! A sub-agent the main agent resumes, and what a restart of ticketd does to the ones that
//! ran: through the whole host, from harness traffic to what the Chat's history, its row and
//! the next message say.

use super::{HostScript, fixture};
use crate::attention::Rank;
use ticketd_core::{ChatItem, ChatSubAgent, ChatSubAgentRun, ChatSubAgentState};

fn only_sub_agent(h: &HostScript) -> ChatSubAgent {
    let mut records = h.sub_agents();
    assert_eq!(records.len(), 1, "{records:?}");
    records.remove(0)
}

fn states(record: &ChatSubAgent) -> Vec<ChatSubAgentState> {
    record
        .runs
        .iter()
        .map(|run: &ChatSubAgentRun| run.state)
        .collect()
}

fn rows(h: &HostScript) -> Vec<String> {
    h.transcript()
        .into_iter()
        .filter(|line| line.starts_with("sub-agent"))
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_sub_agent_the_main_agent_resumes_is_the_same_record_with_a_new_run_and_an_earlier_runs_late_notice_is_dropped()
 {
    let mut h = HostScript::claude()
        .process([
            fixture!("claude", "handshake"),
            fixture!("claude", "sub_agent_resume"),
        ])
        .start();
    h.send("Find the ways around the rate limiter and wait for the result")
        .await;
    h.play_to("the SDK took the first input").await;
    h.play_to("the first turn ended with the sub-agent done")
        .await;
    assert_eq!(states(&only_sub_agent(&h)), [ChatSubAgentState::Completed]);
    assert_eq!(h.attention().await.rank, Rank::Done);

    h.send("Ask it to also check the retry path").await;
    h.play_to("the second turn ended while run 2 works").await;
    // Still one record; its second run runs in the background, outside any turn, and the
    // Chat shows as working for it.
    let record = only_sub_agent(&h);
    assert_eq!(
        states(&record),
        [ChatSubAgentState::Completed, ChatSubAgentState::Running]
    );
    assert_eq!(record.runs[1].run, 2);
    assert_eq!(
        rows(&h),
        [
            "sub-agent \"Find limiter bypasses\" completed",
            "sub-agent \"Find limiter bypasses\" (resumed) running"
        ]
    );
    let working = h.attention().await;
    assert_eq!(
        (working.rank, working.line()),
        (Rank::Working, "Working · 1 sub-agent".to_owned())
    );

    h.play_to("run 2 works").await;
    // The notice of run 1 arrives again, late: it ends nothing of run 2, and the Chat goes
    // on working for it.
    h.play_to("a late notice of run 1 arrived").await;
    let record = only_sub_agent(&h);
    assert_eq!(
        states(&record),
        [ChatSubAgentState::Completed, ChatSubAgentState::Running]
    );
    assert_eq!(h.live().await.sub_agents, 1);
    assert_eq!(h.attention().await.rank, Rank::Working);

    h.play_to("run 2 finished").await;
    assert_eq!(
        states(&only_sub_agent(&h)),
        [ChatSubAgentState::Completed, ChatSubAgentState::Completed]
    );
    // The main agent may resume by itself for a moment; when it does not, the Chat is quiet.
    h.pass(std::time::Duration::from_secs(60)).await;
    assert_ne!(h.attention().await.rank, Rank::Working);
    h.finish().await;
}

/// The Chat's stored history now must equal the file (made stable), which the desktop
/// builds the view of a Chat at that moment from.
fn pinned(h: &HostScript, name: &str) {
    let snapshot = h
        .core()
        .chat_snapshot(h.chat_id(), 5_000)
        .expect("the Chat's history");
    let stored = super::sub_agents::made_stable(
        &serde_json::to_string_pretty(&snapshot).expect("it serializes"),
    );
    let file = format!(
        "{}/tests/fixtures/claude/sub_agent_{name}.stored.json",
        env!("CARGO_MANIFEST_DIR")
    );
    if std::env::var_os("TICKETD_UPDATE_VIEW_FIXTURES").is_some() {
        std::fs::write(&file, format!("{stored}\n")).expect("the file is written");
    }
    let kept = std::fs::read_to_string(&file).expect(
        "the stored history; regenerate it with TICKETD_UPDATE_VIEW_FIXTURES=1 cargo test -p ticketd-chat-host --lib host_script::resume",
    );
    assert!(
        kept.trim_end() == stored,
        "the stored history changed; if that is intended, regenerate {file} with TICKETD_UPDATE_VIEW_FIXTURES=1"
    );
}

/// What the person sees of the notice: the Chat's row, and the stored note of a message.
fn note_of(h: &HostScript, text: &str) -> Option<ticketd_core::ChatMessageNote> {
    h.items().into_iter().find_map(|item| match item {
        ChatItem::Message(message) if message.text == text => message.note,
        _ => None,
    })
}

#[tokio::test(start_paused = true)]
async fn after_a_restart_the_running_sub_agents_are_lost_and_the_next_message_says_so_once() {
    let mut h = HostScript::claude()
        .process([
            fixture!("claude", "handshake"),
            fixture!("claude", "sub_agent_restart_before"),
        ])
        .process([
            fixture!("claude", "handshake_resume"),
            fixture!("claude", "sub_agent_restart_resume"),
        ])
        .start();
    h.send("Before I merge, review the rate limiter on this branch. In parallel: look for ways around it, check that the tests cover the edge cases, and proofread the API docs.")
        .await;
    h.play_to("the SDK took the input").await;
    h.play_to("the turn ended").await;
    h.play_to("a sub-agent works after the turn ended").await;
    h.play_to("both sub-agents work").await;
    assert_eq!(h.live().await.sub_agents, 2);
    // The person has seen the turn that started them.
    h.core().mark_chat_seen(h.chat_id()).unwrap();

    h.restart_ticketd().await;
    pinned(&h, "restart");

    // The two that ran are lost; the one that finished is not. Nothing is running.
    let lost: Vec<_> = h
        .sub_agents()
        .iter()
        .map(|record| (record.title(), record.latest().map(|run| run.state)))
        .collect();
    assert_eq!(
        lost,
        [
            ("Find limiter bypasses".to_owned(), Some(ChatSubAgentState::Lost)),
            ("Check limiter test coverage".to_owned(), Some(ChatSubAgentState::Lost)),
            ("Proofread the API docs".to_owned(), Some(ChatSubAgentState::Completed)),
        ]
    );
    let row = h.attention().await;
    assert_eq!(
        (row.rank, row.line(), row.unread()),
        (Rank::Idle, "2 sub-agents lost contact".to_owned(), false)
    );
    assert_eq!(h.core().chat_snapshot(h.chat_id(), 500).unwrap().chat.restart_notice.len(), 2);

    // The person's next message carries one factual note, sent to the harness with it.
    let words = "Pick the two reviews back up.";
    h.send(words).await;
    h.play_to("the SDK took the input again").await;
    let note = note_of(&h, words).expect("the message holds the note ticketd added");
    assert_eq!(note.sub_agents, ["task_a", "task_b"]);
    assert_eq!(
        note.text,
        "From ticketd: these sub-agents were running when ticketd quit and are not running now: Find limiter bypasses, Check limiter test coverage. You can resume them."
    );
    // It was told once: the row is back to what the Chat did, and the next message has no note.
    assert!(h.core().chat_snapshot(h.chat_id(), 500).unwrap().chat.restart_notice.is_empty());
    assert_ne!(h.attention().await.line(), "2 sub-agents lost contact");
    h.play_to("both sub-agents run again").await;
    pinned(&h, "restart_sent");
    // Both have a new run of the same record, in the turn the message started.
    let records = h.sub_agents();
    for record in &records[..2] {
        assert_eq!(
            states(record),
            [ChatSubAgentState::Lost, ChatSubAgentState::Running],
            "{}",
            record.title()
        );
    }
    assert_eq!(states(&records[2]), [ChatSubAgentState::Completed]);
    h.play_to("the second turn ended").await;
    h.send("And the docs?").await;
    h.play_all().await;
    assert_eq!(note_of(&h, "And the docs?"), None);
    h.finish().await;
}

#[tokio::test(start_paused = true)]
async fn after_a_restart_a_codex_chat_is_told_which_sub_agents_were_lost_without_a_way_to_resume_them() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_outlives_turn"),
        ])
        .process([fixture!("codex", "sub_agent_restart_resume")])
        .start();
    h.send("Start one sub-agent on the slow check, do not wait for it, and end your turn")
        .await;
    h.play_to("the parent's turn ended while the sub-agent runs")
        .await;
    assert_eq!(h.live().await.sub_agents, 1);
    h.core().mark_chat_seen(h.chat_id()).unwrap();

    h.restart_ticketd().await;

    let record = only_sub_agent(&h);
    assert_eq!(states(&record), [ChatSubAgentState::Lost]);
    let row = h.attention().await;
    assert_eq!(
        (row.rank, row.line()),
        (Rank::Idle, "1 sub-agent lost contact".to_owned())
    );

    h.send("What is left?").await;
    let note = note_of(&h, "What is left?").expect("the message holds the note");
    assert_eq!(note.sub_agents, [record.native_id.clone()]);
    assert_eq!(
        note.text,
        format!(
            "From ticketd: this sub-agent was running when ticketd quit and is not running now: {}.",
            record.title()
        )
    );
    h.play_all().await;
    h.finish().await;
}

#[tokio::test(start_paused = true)]
async fn codex_telling_a_child_to_go_on_changes_nothing_until_the_child_starts_a_turn_and_then_it_is_a_second_run() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent_rerun"),
        ])
        .start();
    h.send("Start one sub-agent on the sleep check and wait for it")
        .await;
    h.play_to("the sub-agent's turn was interrupted").await;
    assert_eq!(states(&only_sub_agent(&h)), [ChatSubAgentState::Stopped]);

    // The main agent asked it to go on: that is not a run yet, and not a change.
    h.play_to("the main agent asked the sub-agent to go on").await;
    assert_eq!(states(&only_sub_agent(&h)), [ChatSubAgentState::Stopped]);
    assert_eq!(h.live().await.sub_agents, 0);

    // Its next turn is the second run of the same sub-agent, and its end is the second end.
    h.play_all().await;
    h.finish().await;
    let record = only_sub_agent(&h);
    assert_eq!(
        states(&record),
        [ChatSubAgentState::Stopped, ChatSubAgentState::Completed]
    );
    assert_eq!(h.turns().len(), 1, "a child's turn is not a Chat turn");
}
