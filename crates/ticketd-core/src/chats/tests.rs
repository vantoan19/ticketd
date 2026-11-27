use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use super::*;

#[test]
fn queue_hydration_sees_the_held_input_when_another_connection_replaces_it() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    workspace
        .connection
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    let chat = workspace
        .create_chat(
            None,
            NewChat {
                title: None,
                harness: "codex".into(),
                execution_folder: "/work/app".into(),
                folder_managed: false,
                links: Vec::new(),
            },
        )
        .unwrap();
    let original = workspace.save_chat_input(None, &chat.id, "Held").unwrap();
    workspace
        .confirm_chat_queue_edit(&chat.id, &original.id, "hold")
        .unwrap();

    let mut peer = Some(Workspace::open(&path).unwrap());
    let (reply, replaced) = std::sync::mpsc::channel();
    let chat_id = chat.id.clone();
    let replaces = [original.id.clone()];
    workspace
        .connection
        .authorizer(Some(move |context: AuthContext<'_>| {
            // Only the post-selection message query reads the caption.
            if let AuthAction::Read {
                table_name: "chat_messages",
                column_name: "text",
            } = context.action
                && let Some(mut peer) = peer.take()
            {
                let result = peer
                    .save_chat_input_replacing(Some("save"), &chat_id, "Edited", &[], &replaces)
                    .map_err(|error| error.to_string());
                let _ = reply.send(result);
            }
            Authorization::Allow
        }));

    let queue = workspace.chat_queue(&chat.id).unwrap();
    let replacement = replaced
        .try_recv()
        .unwrap()
        .unwrap()
        .into_message()
        .unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].id, original.id);
    assert!(queue[0].editing);
    assert_eq!(workspace.chat_queue(&chat.id).unwrap(), [replacement]);
}

#[test]
fn a_chat_creation_receipt_with_only_start_picks_still_replays() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(directory.path().join("workspace.sqlite3")).unwrap();
    let new_chat = NewChat {
        title: Some("First message".into()),
        harness: "codex".into(),
        execution_folder: "/work/app".into(),
        folder_managed: false,
        links: Vec::new(),
    };
    let command_id = "request:chat";
    let mut prior_request = create_chat_request(&new_chat);
    prior_request["start_picks"] = json!({"model": "model-a", "effort": null, "permission": null});
    let first = workspace
        .chat_write(|connection| {
            create_chat_with_request(
                connection,
                Some(command_id),
                new_chat.clone(),
                prior_request,
            )
        })
        .unwrap();
    let picks = ChatStartPicks {
        model: Some("model-a"),
        ..ChatStartPicks::default()
    };

    assert!(matches!(
        workspace.replay_chat_creation(command_id, &new_chat, picks, "First message", &[]),
        Ok(Some(ChatCreationReplay::Exact(chat))) if chat == first
    ));
    assert!(matches!(
        workspace.replay_chat_creation(
            command_id,
            &new_chat,
            ChatStartPicks::default(),
            "First message",
            &[],
        ),
        Err(Error::RequestConflict(_))
    ));
}

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
    // Seed unrelated status moves and Activities on both sides of the short Turn.
    // Pin timestamps so a time-only query would visit all those rows.
    let populate = |workspace: &Workspace, first: i64, last: i64| {
        workspace
            .connection
            .execute(
                "WITH RECURSIVE ticket_numbers(n) AS (
                 VALUES (?1) UNION ALL SELECT n + 1 FROM ticket_numbers WHERE n < ?2
             )
             INSERT INTO tickets (id, reference, title, status)
             SELECT 'ticket-' || n, 'T-KQ' || n, 'Outcome', 'Todo' FROM ticket_numbers",
                params![first, last],
            )
            .unwrap();
        workspace.connection.execute_batch(
            "INSERT INTO ticket_history (ticket_id, kind, from_value, to_value, editing_agent, timestamp)
             SELECT id, 'status', 'Todo', 'In progress', 'claude-code', '2026-01-01T00:00:00.000Z'
             FROM tickets WHERE id NOT IN (SELECT ticket_id FROM ticket_history WHERE kind = 'status');
             INSERT INTO activities (id, ticket_id, brief, editing_agent, reported_at)
             SELECT 'activity-' || ticket_id, ticket_id, 'Drafted the copy', editing_agent, timestamp
             FROM ticket_history WHERE kind = 'status' AND ticket_id NOT IN (SELECT ticket_id FROM activities);",
        ).unwrap();
    };
    populate(&workspace, 1, 1_000);
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::TurnStarted {
                turn_id: "turn".into(),
                native_turn_id: None,
                origin: None,
            }],
        )
        .unwrap();
    populate(&workspace, 2_001, 2_001);
    workspace
        .record_chat_observations(
            &chat.id,
            vec![ChatObservation::TurnEnded {
                turn_id: "turn".into(),
                state: ChatTurnState::Completed,
                detail: None,
                problem: None,
                problem_resets_at: None,
                ending: None,
            }],
        )
        .unwrap();
    populate(&workspace, 1_001, 2_000);
    workspace
        .connection
        .execute_batch(
            "UPDATE chat_turns SET started_at = '2026-01-01T00:00:00.000Z',
                               ended_at = '2026-01-01T00:00:00.000Z';",
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

#[test]
fn deleting_a_chat_deletes_the_shell_windows_that_credit_its_writes() {
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
                ChatObservation::Tool {
                    tool_id: "run-1:bash".into(),
                    turn_id: None,
                    owner: ChatOwner::Main,
                    name: "Bash".into(),
                    input: String::new(),
                    state: ChatToolState::Running,
                    output: None,
                },
                ChatObservation::ShellStep {
                    tool_id: "run-1:bash".into(),
                    writes: Vec::new(),
                },
            ],
        )
        .unwrap();
    let windows = |workspace: &Workspace| -> i64 {
        workspace
            .connection
            .query_row("SELECT COUNT(*) FROM chat_step_windows", [], |row| {
                row.get(0)
            })
            .unwrap()
    };
    assert_eq!(windows(&workspace), 1);

    delete_where(&workspace.connection, "1 = 1").unwrap();

    assert_eq!(windows(&workspace), 0);
}

fn sub_agent_saying(payload: &str) -> ChatSubAgent {
    ChatSubAgent {
        id: "chat:sub-agent:a".into(),
        native_id: "a".into(),
        parent: None,
        tool_id: None,
        background: false,
        payload: payload.into(),
        created_at: String::new(),
        runs: Vec::new(),
    }
}

#[test]
fn a_sub_agent_is_titled_by_one_rule_everywhere() {
    let titled = |payload: &str| {
        let record = sub_agent_saying(payload);
        let native: serde_json::Value = serde_json::from_str(payload).unwrap();
        // The host names a sub-agent in what it says to the main agent with the same rule
        // the row uses.
        assert_eq!(
            sub_agents::sub_agent_title(&native).unwrap_or_else(|| "Sub-agent".to_owned()),
            record.title(),
            "{payload}"
        );
        record.title()
    };
    assert_eq!(
        titled(r#"{"description":"  Check the tests  \nand report","subagent_type":"general"}"#),
        "Check the tests"
    );
    assert_eq!(titled(r#"{"subagent_type":"  Explore \n"}"#), "Explore");
    assert_eq!(
        titled(r#"{"description":"  \n ","subagent_type":" Plan "}"#),
        "Plan"
    );
    assert_eq!(titled(r#"{}"#), "Sub-agent");
}

#[test]
fn the_sub_agent_step_may_run_again_on_a_workspace_that_has_it() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(&dir.path().join("workspace.sqlite3")).unwrap();
    sub_agents::migrate(&workspace.connection).unwrap();
    sub_agents::migrate(&workspace.connection).unwrap();
    for (table, column) in [
        ("chat_messages", "sub_agent_id"),
        ("chat_turns", "origin_sub_agent"),
        ("chat_sub_agent_runs", "tool_id"),
    ] {
        let columns: i64 = workspace
            .connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
                [table, column],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(columns, 1, "{table}.{column}");
    }
}
