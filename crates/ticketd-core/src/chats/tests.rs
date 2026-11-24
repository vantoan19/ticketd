use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use super::*;

#[test]
fn capturing_a_short_turn_skips_unrelated_tickets_and_feed_rows() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let chat = workspace
        .create_chat(
            None,
            NewChat {
                title: None,
                harness: "claude-code".into(),
                execution_folder: "/work/app".into(),
                folder_managed: false,
                links: Vec::new(),
            },
        )
        .unwrap();
    workspace
        .record_chat_observations(
            &chat.id,
            vec![
                ChatObservation::TurnStarted {
                    turn_id: "turn".into(),
                    native_turn_id: None,
                },
                ChatObservation::TurnEnded {
                    turn_id: "turn".into(),
                    state: ChatTurnState::Completed,
                    detail: None,
                    problem: None,
                    problem_resets_at: None,
                    ending: None,
                },
            ],
        )
        .unwrap();
    // Pin the receipt window between two large sets of legacy writes. Only the
    // two changes on T-KQ2001 share the Turn's start and end timestamp.
    workspace
        .connection
        .execute_batch(
            "UPDATE chat_turns SET started_at = '2026-01-01T00:00:00.000Z',
                                   ended_at = '2026-01-01T00:00:00.000Z';
             WITH RECURSIVE tickets_to_add(n) AS (
                 VALUES (1) UNION ALL SELECT n + 1 FROM tickets_to_add WHERE n < 2001
             )
             INSERT INTO tickets (id, reference, title, status)
             SELECT 'ticket-' || n, 'T-KQ' || n, 'Outcome', 'Todo' FROM tickets_to_add;
             INSERT INTO ticket_history (ticket_id, kind, from_value, to_value, editing_agent, timestamp)
             SELECT id, 'status', 'Todo', 'In progress', 'claude-code', at FROM (
                 SELECT id, CASE WHEN rowid <= 1000 THEN '2025-01-01T00:00:00.000Z'
                                 WHEN id = 'ticket-2001' THEN '2026-01-01T00:00:00.000Z'
                                 ELSE '2027-01-01T00:00:00.000Z' END AS at FROM tickets
             );
             INSERT INTO activities (id, ticket_id, brief, editing_agent, reported_at)
             SELECT 'activity-' || ticket_id, ticket_id, 'Drafted the copy', editing_agent, timestamp
             FROM ticket_history WHERE kind = 'status';",
        )
        .unwrap();

    // Count SQLite work on the actual capture path without a wall-clock assertion.
    let ticks = Arc::new(AtomicUsize::new(0));
    let progress = Arc::clone(&ticks);
    workspace.connection.progress_handler(
        100,
        Some(move || {
            progress.fetch_add(1, Ordering::Relaxed);
            false
        }),
    );
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::CaptureAgentChanges {
                turn_id: "turn".into(),
            }],
        )
        .unwrap();
    workspace
        .connection
        .progress_handler(0, None::<fn() -> bool>);

    let snapshot = workspace.chat_snapshot(&chat.id, 20).unwrap();
    let receipt = snapshot.items.iter().find_map(|item| match item {
        ChatItem::Tool(tool) if tool.name == AGENT_CHANGES_RECORD_NAME => Some(&tool.input),
        _ => None,
    });
    assert_eq!(
        serde_json::from_str::<Vec<ChatAgentChange>>(receipt.unwrap()).unwrap(),
        [
            ChatAgentChange::Status {
                reference: "T-KQ2001".into(),
                title: "Outcome".into(),
                from: "Todo".into(),
                to: "In progress".into(),
            },
            ChatAgentChange::Update {
                reference: "T-KQ2001".into(),
                excerpt: "Drafted the copy".into(),
            },
        ]
    );
    let steps = ticks.load(Ordering::Relaxed) * 100;
    assert!(steps < 2_000, "used at least {steps} SQLite instructions");
}
