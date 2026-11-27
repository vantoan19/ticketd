//! Sub-agents through the whole host: Claude Code traffic from a fixture, the real bridge
//! protocol reader, supervisor and core, and what the Chat's history says afterwards.

use super::{HostScript, fixture};
use ticketd_core::{ChatItem, ChatOwner, ChatSubAgentState, ChatToolState, ChatTurnState};

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
    // Its Steps, and its final report: the notification's summary, as no message said it.
    let own = h.sub_agent_transcript("task_a1");
    assert_eq!(
        own[..2],
        ["tool Read completed", "tool Read completed"],
        "{own:?}"
    );
    assert_eq!(own.len(), 3, "{own:?}");
    assert!(
        own[2].starts_with("agent: README.txt states a limit of 5 requests per second."),
        "{own:?}"
    );
    assert!(
        !transcript
            .iter()
            .any(|line| line.contains("README.txt states")),
        "{transcript:?}"
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
            "agent: The limiter allows 5.",
        ]
    );
    // The nested sub-agent has its own Step and nothing of its parent's.
    assert_eq!(
        h.sub_agent_transcript("task_b"),
        ["tool Read completed", "agent: The tests cover the limit."]
    );

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

    assert_eq!(
        h.sub_agent_transcript("task_a"),
        ["tool Read completed", "agent: LIMIT is 5."]
    );
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

/// What the session was asked in the messages fixture.
const MESSAGES_PROMPT: &str = "Ask a sub-agent to check the limit in README.txt, to add a note file, and report. Then answer in one short sentence.";

/// The files records of one agent, each as the paths it lists.
fn files_listed(h: &HostScript, owner: &ChatOwner) -> Vec<Vec<String>> {
    h.items()
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::Tool(tool) if tool.name == "ticketd files" && &tool.owner == owner => {
                let record: serde_json::Value = serde_json::from_str(&tool.input).ok()?;
                Some(
                    record["files"]
                        .as_array()?
                        .iter()
                        .filter_map(|file| file["path"].as_str().map(str::to_owned))
                        .collect(),
                )
            }
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_sub_agents_messages_reasoning_and_report_are_its_own_and_in_order() {
    let mut h = HostScript::claude()
        .process([
            fixture!("claude", "handshake"),
            fixture!("claude", "sub_agent_messages"),
        ])
        .start();
    h.send(MESSAGES_PROMPT).await;
    h.play_all().await;
    h.finish().await;

    // Its messages, reasoning, Steps, files and final report, in the order they came;
    // the report the notification repeats is not stored a second time.
    assert_eq!(
        h.sub_agent_transcript("task_a1"),
        [
            "tool ticketd reasoning completed",
            "agent: I will read README.txt for the limit.",
            "tool Read completed",
            "tool Write completed",
            "tool ticketd files completed",
            "agent: The limit is 5 requests per second. I wrote it to limit-note.txt.",
        ]
    );

    // The main transcript has none of it: its own words and one row for the sub-agent.
    let transcript = h.transcript();
    assert!(
        !transcript
            .iter()
            .any(|line| line.contains("README.txt for the limit") || line.contains("wrote it")),
        "{transcript:?}"
    );
    assert!(
        transcript
            .contains(&"agent: The sub-agent found a limit of 5 requests per second.".to_owned()),
        "{transcript:?}"
    );
    assert!(
        !transcript
            .iter()
            .any(|line| line.starts_with("tool ticketd reasoning")),
        "{transcript:?}"
    );
    assert!(h.notices().is_empty(), "{:?}", h.notices());
}

#[tokio::test(start_paused = true)]
async fn a_sub_agents_file_edits_are_its_runs_and_not_the_turns() {
    let mut h = HostScript::claude()
        .process([
            fixture!("claude", "handshake"),
            fixture!("claude", "sub_agent_messages"),
        ])
        .start();
    h.send(MESSAGES_PROMPT).await;
    h.play_all().await;
    h.finish().await;

    let sub = ChatOwner::SubAgent {
        native_id: "task_a1".to_owned(),
    };
    assert_eq!(
        files_listed(&h, &sub),
        [vec!["/work/chat-1/limit-note.txt".to_owned()]]
    );
    assert_eq!(
        files_listed(&h, &ChatOwner::Main),
        [vec!["/work/chat-1/summary.txt".to_owned()]]
    );
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

/// The same for the fixture whose sub-agent thinks, writes messages and edits a file.
const STORED_MESSAGES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/claude/sub_agent_messages.stored.json"
);

/// `text` with each distinct identifier the host chose (`8-4-4-4-12` hex) replaced by
/// `00000000-0000-4000-8000-<n>` in order of appearance, and every time (which is when the
/// test ran) by one steady time, and every `position` by its rank among the distinct
/// positions: which number a record gets depends on how its neighbours interleave, which
/// varies run to run under load, while their order does not.
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
    ranked_positions(&stable)
}

/// `text` with the value of each `"position": <n>` line replaced by its rank (1, 2, ...)
/// among the distinct values in the text; equal positions stay equal, order is kept.
fn ranked_positions(text: &str) -> String {
    let value = |line: &str| {
        line.trim_start()
            .strip_prefix("\"position\": ")
            .map(|rest| rest.trim_end_matches(',').to_owned())
            .and_then(|rest| rest.parse::<u64>().ok())
    };
    let mut distinct: Vec<u64> = text.lines().filter_map(value).collect();
    distinct.sort_unstable();
    distinct.dedup();
    text.lines()
        .map(|line| match value(line) {
            Some(n) => {
                let rank = distinct.binary_search(&n).expect("it was collected") + 1;
                let indent = &line[..line.len() - line.trim_start().len()];
                let comma = if line.ends_with(',') { "," } else { "" };
                format!("{indent}\"position\": {rank}{comma}")
            }
            None => line.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The stored history after `fixture` played, compared with the file at `path` (or
/// written to it when asked).
async fn assert_pinned(process: [super::Fixture; 2], prompt: &str, path: &str) {
    let mut h = HostScript::claude().process(process).start();
    h.send(prompt).await;
    h.play_all().await;
    h.finish().await;

    let snapshot = h
        .core()
        .chat_snapshot(h.chat_id(), 5_000)
        .expect("the Chat's history");
    let stored = made_stable(&serde_json::to_string_pretty(&snapshot).expect("it serializes"));
    if std::env::var_os("TICKETD_UPDATE_VIEW_FIXTURES").is_some() {
        std::fs::write(path, format!("{stored}\n")).expect("the file is written");
    }
    let kept = std::fs::read_to_string(path).expect(
        "the stored history; regenerate it with TICKETD_UPDATE_VIEW_FIXTURES=1 cargo test -p ticketd-chat-host --lib host_script::sub_agents",
    );
    assert!(
        kept.trim_end() == stored,
        "the stored history changed; if that is intended, regenerate {path} with TICKETD_UPDATE_VIEW_FIXTURES=1"
    );
}

#[tokio::test(start_paused = true)]
async fn the_stored_history_of_a_nested_sub_agent_is_the_file_the_desktop_builds_its_view_from() {
    assert_pinned(
        [
            fixture!("claude", "handshake"),
            fixture!("claude", "sub_agent_nested"),
        ],
        "Review the rate limiter",
        STORED,
    )
    .await;
}

#[tokio::test(start_paused = true)]
async fn the_stored_history_of_a_sub_agent_that_speaks_is_the_file_the_desktop_builds_its_view_from()
 {
    assert_pinned(
        [
            fixture!("claude", "handshake"),
            fixture!("claude", "sub_agent_messages"),
        ],
        MESSAGES_PROMPT,
        STORED_MESSAGES,
    )
    .await;
}

// --- Sub-agents in the background, outside any turn -------------------------------------

mod background {
    use super::*;
    use crate::attention::{Alert, Notifier, Rank, Row, Status};
    use std::collections::HashSet;
    use std::time::{Duration as Std, Instant};
    use ticketd_core::{ChatSubAgentStopper, ChatTurnStarter};

    pub(super) const PROMPT: &str = "Before I merge, review the rate limiter on this branch. In parallel: look for ways around it, check that the tests cover the edge cases, and proofread the API docs.";

    /// What the Chats list shows for the Chat, in words.
    async fn row(h: &HostScript) -> String {
        h.attention().await.line()
    }

    /// Feeds the statuses the Chats list showed, one per step and a little apart, to the
    /// system's notifier, and returns every alert it showed.
    struct Watch {
        notifier: Notifier,
        base: Instant,
        shown: Vec<String>,
        in_view: HashSet<String>,
        at: u64,
    }

    impl Watch {
        fn new(in_view: bool) -> Self {
            Self {
                notifier: Notifier::default(),
                base: Instant::now(),
                shown: Vec::new(),
                in_view: if in_view {
                    HashSet::from(["chat".to_owned()])
                } else {
                    HashSet::new()
                },
                at: 0,
            }
        }

        /// The status now, `after_ms` after the last one.
        fn see(&mut self, status: &Status, after_ms: u64) {
            self.at += after_ms;
            let rows = [Row {
                id: "chat",
                title: "Review the rate limiter",
                status,
                muted: false,
            }];
            let now = self.base + Std::from_millis(self.at);
            for alert in self.notifier.update(&rows, &self.in_view, true, now) {
                if let Alert::Show { body, .. } = alert {
                    self.shown.push(body);
                }
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_sub_agent_keeps_working_after_the_turn_without_opening_one() {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_background"),
            ])
            .start();
        h.send(PROMPT).await;
        h.play_to("the SDK took the input").await;
        h.play_to("the turn ended").await;

        // The turn is over, and the Chat is still working: two sub-agents run.
        assert_eq!(h.turns().len(), 1);
        assert_eq!(h.turns()[0].state, ChatTurnState::Completed);
        assert_eq!(h.live().await.sub_agents, 2);
        assert_eq!(row(&h).await, "Working · 2 sub-agents");
        assert_eq!(h.attention().await.rank, Rank::Working);

        // What the sub-agent does after the turn ended is its own Step: no turn opens,
        // and nothing is said about a tool result the turn did not start.
        h.play_to("a sub-agent works after the turn ended").await;
        h.play_to("both sub-agents work").await;
        assert_eq!(h.turns().len(), 1, "{:?}", h.transcript());
        assert!(h.notices().is_empty(), "{:?}", h.notices());
        assert_eq!(
            h.sub_agent_transcript("task_a"),
            ["tool Read completed"],
            "its result is its own, though the turn that started it is over"
        );
        assert_eq!(h.sub_agent_transcript("task_b"), ["tool Read running"]);
        let records = h.sub_agents();
        assert!(records.iter().all(|record| record.background));
        let states: Vec<_> = records
            .iter()
            .map(|record| {
                (
                    record.native_id.as_str(),
                    record.latest().map(|run| run.state),
                )
            })
            .collect();
        assert_eq!(
            states,
            [
                ("task_a", Some(ChatSubAgentState::Running)),
                ("task_b", Some(ChatSubAgentState::Running)),
                // It finished in the turn that started it.
                ("task_c", Some(ChatSubAgentState::Completed)),
            ]
        );
        h.play_all().await;
        h.finish().await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_main_agent_resuming_by_itself_is_a_labelled_turn_and_done_comes_once() {
        resumes_by_itself(true).await;
    }

    /// The person left before the first turn's reply was seen: that turn's Done is held
    /// back while sub-agents run, and still only one Done is told, at the very end.
    #[tokio::test(start_paused = true)]
    async fn done_comes_once_also_when_the_first_turn_was_never_seen() {
        resumes_by_itself(false).await;
    }

    async fn resumes_by_itself(seen_first_turn: bool) {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_background"),
            ])
            .start();
        let mut watch = Watch::new(false);
        watch.see(&h.attention().await, 0);
        h.send(PROMPT).await;
        h.play_to("the SDK took the input").await;
        h.play_to("the turn ended").await;
        // The person looks at the Chat while the sub-agents run, then leaves it.
        if seen_first_turn {
            h.core().mark_chat_seen(h.chat_id()).expect("seen");
        }
        watch.see(&h.attention().await, 100);
        h.play_to("a sub-agent works after the turn ended").await;
        h.play_to("both sub-agents work").await;
        watch.see(&h.attention().await, 100);

        // One of two finishes: still working, and nothing is told.
        h.play_to("the first sub-agent finished").await;
        assert_eq!(row(&h).await, "Working · 1 sub-agent");
        watch.see(&h.attention().await, 100);

        // The last one finishes. The main agent has not resumed yet, which takes
        // seconds: the Chat does not go quiet in between.
        h.play_to("the last sub-agent finished").await;
        assert_eq!(h.live().await.sub_agents, 0);
        assert_eq!(h.attention().await.rank, Rank::Working);
        for _ in 0..6 {
            h.pass(Std::from_millis(500)).await;
            watch.see(&h.attention().await, 500);
        }
        assert_eq!(h.turns().len(), 1);

        // Claude Code resumes the main agent by itself: a turn the person did not start,
        // that follows the sub-agent that finished last.
        h.play_to("Claude resumed by itself and the turn ended")
            .await;
        let turns = h.turns();
        assert_eq!(turns.len(), 2, "{:?}", h.transcript());
        assert_eq!(turns[0].origin, None);
        let origin = turns[1].origin.clone().expect("the turn is labelled");
        assert_eq!(origin.by, ChatTurnStarter::Harness);
        assert_eq!(origin.sub_agent.as_deref(), Some("task_a"));
        assert_eq!(turns[1].state, ChatTurnState::Completed);
        assert!(
            h.transcript()
                .iter()
                .any(|line| line.starts_with("agent: All three reviews are in."))
        );
        assert_eq!(h.live().await.sub_agents, 0);

        // The Chat is quiet: Done, unseen (the person saw the first turn, not this one),
        // and the system was told exactly once, however long the sub-agents ran.
        let status = h.attention().await;
        assert_eq!((status.rank, status.word.as_str()), (Rank::Done, "Done"));
        assert!(status.unseen);
        watch.see(&status, 100);
        watch.see(&status, 2_000);
        watch.see(&status, 2_000);
        assert_eq!(
            watch.shown,
            ["Done · All three reviews are in."],
            "{:?}",
            watch.shown
        );
        h.play_all().await;
        h.finish().await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_chat_the_person_is_looking_at_notifies_nothing() {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_background"),
            ])
            .start();
        let mut watch = Watch::new(true);
        watch.see(&h.attention().await, 0);
        h.send(PROMPT).await;
        h.play_all().await;
        watch.see(&h.attention().await, 100);
        watch.see(&h.attention().await, 5_000);
        assert!(watch.shown.is_empty(), "{:?}", watch.shown);
        h.finish().await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_turn_the_harness_starts_that_fails_notifies_and_does_not_pause_the_queue() {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_background_failed_wake"),
            ])
            .start();
        let mut watch = Watch::new(false);
        watch.see(&h.attention().await, 0);
        h.send(PROMPT).await;
        h.play_to("the SDK took the input").await;
        h.play_to("the turn ended").await;
        h.play_all().await;

        let turns = h.turns();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1].state, ChatTurnState::Failed);
        assert!(turns[1].origin.is_some());
        // It shows as failed and tells the person ...
        let status = h.attention().await;
        assert_eq!(status.rank, Rank::Failed, "{status:?}");
        watch.see(&status, 100);
        assert_eq!(watch.shown.len(), 1, "{:?}", watch.shown);
        // ... and the person's own queue still goes on: it is not paused.
        assert!(!h.core().chat(h.chat_id()).expect("the Chat").queue_paused);
    }

    #[tokio::test(start_paused = true)]
    async fn stop_with_no_turn_stops_the_sub_agents_and_ends_the_harness() {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_background_at_rest"),
            ])
            .start();
        h.send(PROMPT).await;
        h.play_all().await;
        assert_eq!(h.live().await.sub_agents, 2);

        h.stop().await;
        // The harness process was asked to end, and does.
        h.lose_process(0).await;

        let live = h.live().await;
        assert_eq!(live.sub_agents, 0);
        assert!(!live.running);
        assert_eq!(h.attention().await.word, "You stopped 2 sub-agents");
        assert_eq!(h.notices(), ["You stopped 2 sub-agents."]);
        for record in h.sub_agents() {
            let run = record.latest().expect("a run");
            if record.native_id == "task_c" {
                // It finished in the turn, before anything was stopped.
                assert_eq!(run.state, ChatSubAgentState::Completed);
                continue;
            }
            assert_eq!(run.state, ChatSubAgentState::Stopped);
            assert_eq!(run.stopped_by, Some(ChatSubAgentStopper::Person));
        }
        // The turn that started them is not touched: it ended long before.
        assert_eq!(h.turns().len(), 1);
        assert_eq!(h.turns()[0].state, ChatTurnState::Completed);
    }

    #[tokio::test(start_paused = true)]
    async fn stop_in_a_turn_stops_the_turn_and_every_sub_agent() {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_background_in_turn"),
            ])
            .start();
        h.send(PROMPT).await;
        h.play_to("the SDK took the input").await;
        h.play_to("two sub-agents run in the turn").await;
        assert_eq!(h.live().await.sub_agents, 2);

        h.stop().await;
        h.play_all().await;
        h.finish().await;

        assert_eq!(h.turns()[0].state, ChatTurnState::Interrupted);
        assert_eq!(h.live().await.sub_agents, 0);
        for record in h.sub_agents() {
            let run = record.latest().expect("a run");
            if record.native_id == "task_c" {
                // It finished before the Stop.
                assert_eq!(run.state, ChatSubAgentState::Completed);
                continue;
            }
            assert_eq!(run.state, ChatSubAgentState::Stopped);
            assert_eq!(run.stopped_by, Some(ChatSubAgentStopper::Person));
        }
        // The turn's own stop says it: no separate note.
        assert!(h.notices().is_empty(), "{:?}", h.notices());
    }

    /// A foreground sub-agent is a running tool of the turn: Claude Code answers it with
    /// the error it gives a tool a Stop cuts off, and says nothing else about it. The
    /// person pressed Stop, so it was stopped, not failed (LC-08).
    #[tokio::test(start_paused = true)]
    async fn stop_in_a_turn_stops_its_foreground_sub_agents_not_fails_them() {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_foreground_stop"),
            ])
            .start();
        h.send(PROMPT).await;
        h.play_to("the SDK took the input").await;
        h.play_to("two foreground sub-agents run").await;
        assert_eq!(h.live().await.sub_agents, 2);

        h.stop().await;
        h.play_all().await;
        h.finish().await;

        assert_eq!(h.turns()[0].state, ChatTurnState::Interrupted);
        assert_eq!(h.live().await.sub_agents, 0);
        let records = h.sub_agents();
        assert_eq!(records.len(), 2);
        for record in records {
            let run = record.latest().expect("a run");
            assert_eq!(run.state, ChatSubAgentState::Stopped, "{}", record.native_id);
            assert_eq!(run.stopped_by, Some(ChatSubAgentStopper::Person));
        }
    }
}

// --- Background sub-agents: the stored history, pinned for the desktop ---------------------

pub(super) mod background_stored {
    use super::*;

    fn path(name: &str) -> String {
        format!(
            "{}/tests/fixtures/claude/sub_agent_background_{name}.stored.json",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    /// The Chat's stored history now must equal the file (made stable), which the desktop
    /// builds the view of a Chat at that moment from.
    pub(in crate::host_script) fn pinned(h: &HostScript, name: &str) {
        let snapshot = h
            .core()
            .chat_snapshot(h.chat_id(), 5_000)
            .expect("the Chat's history");
        let stored = made_stable(&serde_json::to_string_pretty(&snapshot).expect("it serializes"));
        let file = path(name);
        if std::env::var_os("TICKETD_UPDATE_VIEW_FIXTURES").is_some() {
            std::fs::write(&file, format!("{stored}\n")).expect("the file is written");
        }
        let kept = std::fs::read_to_string(&file).expect(
            "the stored history; regenerate it with TICKETD_UPDATE_VIEW_FIXTURES=1 cargo test -p ticketd-chat-host --lib host_script::sub_agents",
        );
        assert!(
            kept.trim_end() == stored,
            "the stored history changed; if that is intended, regenerate {file} with TICKETD_UPDATE_VIEW_FIXTURES=1"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_stored_history_of_background_sub_agents_is_what_the_desktop_builds_its_views_from()
    {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_background"),
            ])
            .start();
        h.send(super::background::PROMPT).await;
        h.play_to("the SDK took the input").await;
        h.play_to("the turn ended").await;
        h.play_to("a sub-agent works after the turn ended").await;
        h.play_to("both sub-agents work").await;
        pinned(&h, "working");
        h.play_to("the first sub-agent finished").await;
        pinned(&h, "one");
        h.play_to("the last sub-agent finished").await;
        h.play_to("Claude resumed by itself and the turn ended")
            .await;
        pinned(&h, "done");
        h.finish().await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_stored_history_of_sub_agents_running_in_the_turn_that_started_them_is_pinned_too()
    {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_background_in_turn"),
            ])
            .start();
        h.send(super::background::PROMPT).await;
        h.play_to("the SDK took the input").await;
        h.play_to("two sub-agents run in the turn").await;
        pinned(&h, "in_turn");
        h.stop().await;
        h.play_all().await;
        h.finish().await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_stored_history_of_sub_agents_stopped_with_no_turn_is_pinned_too() {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_background_at_rest"),
            ])
            .start();
        h.send(super::background::PROMPT).await;
        h.play_all().await;
        h.stop().await;
        h.lose_process(0).await;
        pinned(&h, "stopped");
    }
}

// --- A sub-agent's approval -------------------------------------------------------------

pub(super) mod approvals {
    use super::*;
    use crate::attention::Rank;
    use ticketd_core::{ChatInteractionState, ChatOwner};

    const PROMPT: &str = "Check that the limiter's tests cover its edge cases, in the background";

    /// The Chat's stored history now must equal the file (made stable): what the desktop
    /// builds the view of a pending sub-agent approval from.
    pub(in crate::host_script) fn pinned(h: &HostScript, file: &str) {
        let snapshot = h
            .core()
            .chat_snapshot(h.chat_id(), 5_000)
            .expect("the Chat's history");
        let stored = made_stable(&serde_json::to_string_pretty(&snapshot).expect("it serializes"));
        let file = format!("{}/tests/fixtures/{file}", env!("CARGO_MANIFEST_DIR"));
        if std::env::var_os("TICKETD_UPDATE_VIEW_FIXTURES").is_some() {
            std::fs::write(&file, format!("{stored}\n")).expect("the file is written");
        }
        let kept = std::fs::read_to_string(&file).expect(
            "the stored history; regenerate it with TICKETD_UPDATE_VIEW_FIXTURES=1 cargo test -p ticketd-chat-host --lib host_script",
        );
        assert!(
            kept.trim_end() == stored,
            "the stored history changed; if that is intended, regenerate {file} with TICKETD_UPDATE_VIEW_FIXTURES=1"
        );
    }

    fn asked_by_task_b() -> ChatOwner {
        ChatOwner::SubAgent {
            native_id: "task_b".to_owned(),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_background_sub_agent_s_approval_after_the_turn_ended_is_offered_and_answerable() {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_approval"),
            ])
            .start();
        h.send(super::background::PROMPT).await;
        h.play_to("the SDK took the input").await;
        h.play_to("the turn ended").await;
        h.play_to("the sub-agent asks for approval after the turn ended")
            .await;

        // It is the sub-agent's, it opened no turn, and the Chat waits for the person.
        assert_eq!(h.turns().len(), 1, "{:?}", h.transcript());
        assert_eq!(h.turns()[0].state, ChatTurnState::Completed);
        assert_eq!(
            h.requests(),
            [(asked_by_task_b(), ChatInteractionState::Pending)]
        );
        assert_eq!(h.live().await.interactions.len(), 1);
        let status = h.attention().await;
        assert_eq!(status.rank, Rank::Approval);
        assert_eq!(
            status.line(),
            "Approval needed · Check limiter test coverage"
        );
        // Its Step is the sub-agent's own, and it waits with the request.
        assert_eq!(h.sub_agent_transcript("task_b"), ["tool Bash running"]);
        assert!(h.notices().is_empty(), "{:?}", h.notices());
        pinned(&h, "claude/sub_agent_approval.stored.json");

        // The answer goes back to Claude Code (the fixture holds the frame it must be).
        h.approve().await;
        h.play_to("the approval was answered").await;
        assert_eq!(
            h.requests(),
            [(asked_by_task_b(), ChatInteractionState::Answered)]
        );
        h.play_all().await;
        h.finish().await;
        assert_eq!(h.turns().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn an_approval_nobody_answered_goes_when_its_sub_agent_ends() {
        let mut h = HostScript::claude()
            .process([
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_approval_asker_ends"),
            ])
            .start();
        h.send(PROMPT).await;
        h.play_to("the SDK took the input").await;
        h.play_to("the main agent's turn ended").await;
        h.play_to("the sub-agent asks for approval after the turn ended")
            .await;
        assert_eq!(
            h.requests(),
            [(asked_by_task_b(), ChatInteractionState::Pending)]
        );

        h.play_all().await;
        h.finish().await;
        assert_eq!(
            h.requests(),
            [(asked_by_task_b(), ChatInteractionState::Expired)]
        );
        assert!(h.live().await.interactions.is_empty());
        assert_eq!(h.attention().await.rank, Rank::Done);
    }
}
