//! Sub-agents through the whole host: Claude Code traffic from a fixture, the real bridge
//! protocol reader, supervisor and core, and what the Chat's history says afterwards.

use super::{HostScript, fixture};
use ticketd_core::{ChatItem, ChatSubAgentState, ChatToolState, ChatTurnState};

/// What the recorded session was asked.
const PROMPT: &str = "Use the Agent tool exactly once, with subagent_type Explore and the description 'Read the readme', to read README.txt and src/limit.ts in this folder. Then answer in one short sentence what limit they state. Do not write or run anything.";

/// The text of the plan record the Chat keeps for its turn, if any.
fn plan_records(h: &HostScript) -> Vec<String> {
    h.items()
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::Tool(tool) if tool.name == "ticketd plan" => Some(tool.input),
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_foreground_sub_agent_is_one_row_in_the_turn_and_its_steps_are_its_own() {
    let mut h = HostScript::claude()
        .process([
            fixture!("claude", "handshake"),
            fixture!("claude", "sub_agent"),
        ])
        .start();
    h.send(PROMPT).await;
    h.play_all().await;
    h.finish().await;

    // The main transcript holds the Agent step and one row for the sub-agent, and none of
    // the Reads the sub-agent made.
    let transcript = h.transcript();
    assert_eq!(
        transcript
            .iter()
            .filter(|line| line.starts_with("tool Read"))
            .count(),
        0,
        "{transcript:?}"
    );
    assert_eq!(
        transcript
            .iter()
            .filter(|line| line.starts_with("sub-agent"))
            .collect::<Vec<_>>(),
        ["sub-agent \"Read the readme\" completed"]
    );
    assert!(transcript.contains(&"tool Agent completed".to_owned()));
    assert_eq!(h.turns().len(), 1);
    assert_eq!(h.turns()[0].state, ChatTurnState::Completed);
    assert_eq!(
        h.sub_agent_transcript("task_a1"),
        ["tool Read completed", "tool Read completed"]
    );

    // The record: keyed by the task, started by the Agent step, with what the harness said.
    let records = h.sub_agents();
    assert_eq!(records.len(), 1);
    let record = &records[0];
    assert_eq!(record.native_id, "task_a1");
    assert_eq!(record.parent, None);
    assert!(
        record
            .tool_id
            .as_deref()
            .is_some_and(|tool| tool.ends_with(":toolu_agent"))
    );
    assert!(!record.background);
    assert_eq!(
        record.said("description").as_deref(),
        Some("Read the readme")
    );
    assert_eq!(record.said("subagent_type").as_deref(), Some("Explore"));
    assert_eq!(record.said("model").as_deref(), Some("claude-haiku-5-5"));
    assert!(
        record
            .said("prompt")
            .is_some_and(|prompt| prompt.starts_with("Read README.txt and src/limit.ts"))
    );
    assert_eq!(record.runs.len(), 1);
    let run = &record.runs[0];
    assert_eq!(run.state, ChatSubAgentState::Completed);
    assert_eq!(run.native_run_id.as_deref(), Some("run_a1_1"));
    assert!(run.turn_id.is_some());
    assert!(run.ended_at.is_some());
}

#[tokio::test(start_paused = true)]
async fn a_nested_sub_agent_shows_under_its_parent_and_a_sub_agents_to_do_list_is_not_the_plan() {
    let mut h = HostScript::claude()
        .process([
            fixture!("claude", "handshake"),
            fixture!("claude", "sub_agent_nested"),
        ])
        .start();
    h.send("Review the rate limiter").await;
    h.play_all().await;
    h.finish().await;

    // The main agent's transcript: its own steps, and one row, for the direct sub-agent.
    let transcript = h.transcript();
    assert_eq!(
        transcript
            .iter()
            .filter(|line| line.starts_with("sub-agent"))
            .collect::<Vec<_>>(),
        ["sub-agent \"Review the limiter code\" completed"],
        "{transcript:?}"
    );
    assert!(
        !transcript
            .iter()
            .any(|line| line.starts_with("tool Read") || line.starts_with("tool TodoWrite")),
        "{transcript:?}"
    );

    // The direct sub-agent's own view: its to-do list stays a Step of its own, and the
    // nested sub-agent is a row in it.
    assert_eq!(
        h.sub_agent_transcript("task_a"),
        [
            "tool TodoWrite completed",
            "tool Read completed",
            "tool Agent completed",
            "sub-agent \"Check the tests\" completed",
        ]
    );
    // The nested sub-agent has its own Step and nothing of its parent's.
    assert_eq!(h.sub_agent_transcript("task_b"), ["tool Read completed"]);

    let records = h.sub_agents();
    let nested = records
        .iter()
        .find(|record| record.native_id == "task_b")
        .expect("the nested sub-agent has a record");
    assert_eq!(nested.parent.as_deref(), Some("task_a"));
    assert!(
        nested
            .tool_id
            .as_deref()
            .is_some_and(|tool| tool.ends_with(":toolu_agent_b"))
    );
    assert!(
        records.iter().all(
            |record| record.latest().map(|run| run.state) == Some(ChatSubAgentState::Completed)
        )
    );

    // Only the main agent's list is the turn's plan.
    let plans = plan_records(&h);
    assert_eq!(plans.len(), 1, "{plans:?}");
    assert!(plans[0].contains("Review the limiter"), "{plans:?}");
    assert!(!plans[0].contains("Sub-agent item"), "{plans:?}");
}

#[tokio::test(start_paused = true)]
async fn what_a_sub_agent_does_before_its_task_is_announced_is_kept_for_it() {
    let mut h = HostScript::claude()
        .process([
            fixture!("claude", "handshake"),
            fixture!("claude", "sub_agent_early_frames"),
        ])
        .start();
    h.send("Review the rate limiter").await;
    h.play_all().await;
    h.finish().await;

    assert_eq!(h.sub_agent_transcript("task_a"), ["tool Read completed"]);
    assert!(
        !h.transcript()
            .iter()
            .any(|line| line.starts_with("tool Read")),
        "{:?}",
        h.transcript()
    );
    assert!(h.notices().is_empty(), "{:?}", h.notices());
    // The Step is the sub-agent's, not the turn's.
    let owned = h.items().into_iter().any(|item| {
        matches!(item, ChatItem::Tool(tool)
            if tool.name == "Read" && tool.state == ChatToolState::Completed
                && tool.owner != ticketd_core::ChatOwner::Main)
    });
    assert!(owned);
}

// --- The stored history, pinned for the desktop ----------------------------------------

/// The stored history of the nested fixture, with ids and times made stable: the file
/// the desktop's view of it is built from (`apps/desktop/src-tauri/src/chat_view.rs`
/// reads it, and writes the view the interface's tests parse). Regenerated only with
/// `TICKETD_UPDATE_VIEW_FIXTURES=1`; otherwise the history must equal it.
const STORED: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/claude/sub_agent_nested.stored.json"
);

/// `text` with each distinct identifier the host chose (`8-4-4-4-12` hex) replaced by
/// `00000000-0000-4000-8000-<n>` in order of appearance, and every time (which is when the
/// test ran) by one steady time.
pub(super) fn made_stable(text: &str) -> String {
    let bytes = text.as_bytes();
    let hex = |i: usize| bytes.get(i).is_some_and(u8::is_ascii_hexdigit);
    let digit = |i: usize| bytes.get(i).is_some_and(u8::is_ascii_digit);
    let is_id = |at: usize| {
        (0..36).all(|n| match n {
            8 | 13 | 18 | 23 => bytes.get(at + n) == Some(&b'-'),
            _ => hex(at + n),
        })
    };
    let is_time = |at: usize| {
        // 2026-11-27T03:45:15.934Z
        (0..24).all(|n| match n {
            4 | 7 => bytes.get(at + n) == Some(&b'-'),
            10 => bytes.get(at + n) == Some(&b'T'),
            13 | 16 => bytes.get(at + n) == Some(&b':'),
            19 => bytes.get(at + n) == Some(&b'.'),
            23 => bytes.get(at + n) == Some(&b'Z'),
            _ => digit(at + n),
        })
    };
    let mut ids: Vec<&str> = Vec::new();
    let mut stable = String::new();
    let mut at = 0;
    while at < bytes.len() {
        if at + 36 <= bytes.len() && text.is_char_boundary(at) && is_id(at) {
            let id = &text[at..at + 36];
            let number = ids.iter().position(|seen| *seen == id).unwrap_or_else(|| {
                ids.push(id);
                ids.len() - 1
            });
            stable.push_str(&format!("00000000-0000-4000-8000-{:012}", number + 1));
            at += 36;
        } else if at + 24 <= bytes.len() && is_time(at) {
            stable.push_str("2026-11-27T10:00:00.000Z");
            at += 24;
        } else {
            let end = (at + 1..=bytes.len())
                .find(|end| text.is_char_boundary(*end))
                .unwrap_or(bytes.len());
            stable.push_str(&text[at..end]);
            at = end;
        }
    }
    stable
}

#[tokio::test(start_paused = true)]
async fn the_stored_history_of_a_nested_sub_agent_is_the_file_the_desktop_builds_its_view_from() {
    let mut h = HostScript::claude()
        .process([
            fixture!("claude", "handshake"),
            fixture!("claude", "sub_agent_nested"),
        ])
        .start();
    h.send("Review the rate limiter").await;
    h.play_all().await;
    h.finish().await;

    let snapshot = h
        .core()
        .chat_snapshot(h.chat_id(), 5_000)
        .expect("the Chat's history");
    let stored = made_stable(&serde_json::to_string_pretty(&snapshot).expect("it serializes"));
    if std::env::var_os("TICKETD_UPDATE_VIEW_FIXTURES").is_some() {
        std::fs::write(STORED, format!("{stored}\n")).expect("the file is written");
    }
    let kept = std::fs::read_to_string(STORED).expect(
        "the stored history; regenerate it with TICKETD_UPDATE_VIEW_FIXTURES=1 cargo test -p ticketd-chat-host --lib host_script::sub_agents",
    );
    assert!(
        kept.trim_end() == stored,
        "the stored history changed; if that is intended, regenerate {STORED} with TICKETD_UPDATE_VIEW_FIXTURES=1"
    );
}
