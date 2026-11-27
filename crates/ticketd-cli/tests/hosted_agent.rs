//! A Chat-hosted agent reaches ticketd only through this executable. No desktop
//! process runs in these tests; a person's edits are made through the core, as the
//! desktop makes them.
// Clippy exempts #[test] functions but not the helpers they share; those unwrap so a
// broken setup fails the test loudly.
#![allow(clippy::unwrap_used)]

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use ticketd_chat_host::{cli::CliStatus, context};
use ticketd_core::{ChatLink, ChatLinkKind, DocumentPatch, NewChat, TicketPatch, Workspace};

fn workspace_path(directory: &Path) -> PathBuf {
    directory.join("workspace.sqlite3")
}

fn invoke(directory: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .args(args)
        .current_dir(directory)
        .env("TICKETD_TEST_WORKSPACE", workspace_path(directory))
        .output()
        .unwrap()
}

fn text(directory: &Path, args: &[&str]) -> String {
    let output = invoke(directory, args);
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn data(directory: &Path, args: &[&str]) -> Value {
    serde_json::from_str(&text(directory, args)).unwrap()
}

fn refused(directory: &Path, args: &[&str]) -> String {
    let output = invoke(directory, args);
    assert_eq!(output.status.code(), Some(1), "{args:?}");
    String::from_utf8(output.stderr).unwrap()
}

/// The commands a context block offers, each as the arguments after `ticketd`.
fn offered_commands(block: &str) -> Vec<Vec<String>> {
    block
        .lines()
        .filter(|line| line.starts_with("- "))
        .flat_map(|line| line.split('`').skip(1).step_by(2))
        .filter_map(|command| command.strip_prefix("ticketd "))
        .map(|arguments| arguments.split(' ').map(str::to_owned).collect())
        .collect()
}

#[test]
fn the_commands_a_chat_offers_return_records_as_they_are_now() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(workspace_path(dir.path())).unwrap();
    let ticket = workspace.create_ticket("Fix the cache").unwrap();
    let document = workspace
        .create_document(Some("Design"), "First draft")
        .unwrap();
    let project = workspace
        .create_project("App", dir.path().to_str().unwrap())
        .unwrap();
    workspace
        .change_ticket(
            "T-KQ1",
            TicketPatch {
                project_id: Some(Some(project.id.clone())),
                ..Default::default()
            },
        )
        .unwrap();
    let link = |kind, id: &str| ChatLink {
        kind,
        id: id.into(),
    };
    let chat = workspace
        .create_chat(
            None,
            NewChat {
                title: None,
                harness: "codex".into(),
                execution_folder: dir.path().display().to_string(),
                folder_managed: false,
                links: vec![
                    link(ChatLinkKind::Ticket, &ticket.id),
                    link(ChatLinkKind::Document, &document.id),
                    link(ChatLinkKind::Project, &project.id),
                ],
            },
        )
        .unwrap();
    let cli = CliStatus {
        found: true,
        on_path: true,
        path: Some(env!("CARGO_BIN_EXE_ticketd").into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        version_matches: Some(true),
        workspace_path: None,
        workspace_matches: Some(true),
        app_version: env!("CARGO_PKG_VERSION").into(),
        app_workspace_path: None,
        suggested_directory: String::new(),
    };
    let block = context::for_chat(&workspace, &chat.id, &cli).unwrap();

    // A person changes the linked records after the Chat was created.
    workspace
        .change_ticket(
            "T-KQ1",
            TicketPatch {
                body: Some("Now with reproduction steps".into()),
                ..Default::default()
            },
        )
        .unwrap();
    workspace
        .change_document(
            &document.id,
            DocumentPatch {
                body: Some("Second draft".into()),
                ..Default::default()
            },
        )
        .unwrap();
    drop(workspace);

    let results: Vec<Value> = offered_commands(&block)
        .iter()
        .map(|arguments| {
            let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
            data(dir.path(), &arguments)
        })
        .collect();
    let [shown, read, shown_project, listed] = results.as_slice() else {
        panic!("expected four commands in:\n{block}");
    };
    assert_eq!(shown["body"], "Now with reproduction steps");
    assert_eq!(read["body"], "Second draft");
    assert_eq!(shown_project["name"], "App");
    assert_eq!(listed[0]["reference"], "T-KQ1");

    // The guide the block names is bundled with this same executable.
    assert!(block.contains("`ticketd skills get chat`"));
    let guide = text(dir.path(), &["skills", "get", "chat"]);
    for expected in [
        concat!("ticketd CLI version: ", env!("CARGO_PKG_VERSION")),
        "Read the linked records before starting",
        "Write progress back as you go",
        "ticketd change T-1 --status",
        "ticketd activity add T-1",
        "ticketd document create",
        "ticketd evidence add T-1",
        "It is not the Chat's identity",
        "externally owned",
    ] {
        assert!(guide.contains(expected), "missing {expected:?}");
    }
}

#[test]
fn an_agent_records_progress_while_a_person_edits_the_same_ticket() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let mut workspace = Workspace::open(workspace_path(path)).unwrap();
    workspace.create_ticket("Fix the cache").unwrap();
    let body = |text: &str| TicketPatch {
        body: Some(text.into()),
        ..Default::default()
    };
    workspace.change_ticket("T-KQ1", body("Original")).unwrap();

    // The agent reads, then a person edits before the agent's replacement lands.
    let read = data(path, &["show", "T-KQ1"]);
    workspace
        .change_ticket("T-KQ1", body("A person's edit"))
        .unwrap();
    let write = |name: &str, request: Value| {
        let file = path.join(name);
        std::fs::write(&file, request.to_string()).unwrap();
        file.display().to_string()
    };
    let stale = write(
        "stale.json",
        json!({"operation": "change_ticket", "reference": "T-KQ1",
               "patch": {"body": "The agent's rewrite", "expected_body": read["body"], "editing_agent": "codex"}}),
    );
    let stderr = refused(path, &["write", &stale, "--request-id", "rewrite-1"]);
    assert!(stderr.contains("changed elsewhere"), "{stderr}");

    // Status and an Activity in one retryable write; the replay writes nothing more.
    let progress = write(
        "progress.json",
        json!({"operation": "ticket_change", "reference": "T-KQ1",
               "change": {"status": "In progress", "activities": ["Started on the cache"], "editing_agent": "codex"}}),
    );
    let first = data(path, &["write", &progress, "--request-id", "progress-1"]);
    assert_eq!(
        data(path, &["write", &progress, "--request-id", "progress-1"]),
        first
    );

    let document = data(
        path,
        &[
            "document",
            "create",
            "--title",
            "Findings",
            "--body",
            "The cache was stale.",
            "--request-id",
            "findings-1",
        ],
    );
    let document_id = document["id"].as_str().unwrap();
    let activity = data(
        path,
        &[
            "activity",
            "add",
            "T-KQ1",
            "--brief",
            "Found the cause",
            "--document",
            document_id,
            "--agent",
            "codex",
        ],
    );
    assert_eq!(activity["editing_agent"], "codex");
    let evidence = data(
        path,
        &[
            "evidence",
            "add",
            "T-KQ1",
            "--kind",
            "verification",
            "--name",
            "checks",
            "--value",
            "passed",
            "--agent",
            "codex",
        ],
    );
    assert_eq!(evidence["editing_agent"], "codex");
    // The person keeps editing; neither side's work is lost.
    workspace
        .change_ticket(
            "T-KQ1",
            TicketPatch {
                title: Some("Fix the stale cache".into()),
                ..Default::default()
            },
        )
        .unwrap();

    let shown = data(path, &["show", "T-KQ1"]);
    assert_eq!(shown["title"], "Fix the stale cache");
    assert_eq!(shown["body"], "A person's edit");
    assert_eq!(shown["status"], "In progress");
    let context = data(path, &["context", "T-KQ1", "--activities", "--evidence"]);
    let activities = context["activities"]["items"].as_array().unwrap();
    assert_eq!(activities.len(), 2, "{context}");
    assert!(
        activities
            .iter()
            .all(|activity| activity["editing_agent"]["text"] == "codex"),
        "{context}"
    );
    assert!(
        activities
            .iter()
            .any(|activity| activity["supporting_document_id"] == document_id),
        "{context}"
    );
    assert_eq!(context["evidence"]["items"].as_array().unwrap().len(), 1);
    // Attribution describes the writer on each change the agent made.
    let history = data(path, &["history", "T-KQ1"]);
    let agents: Vec<&Value> = history
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["kind"] == "status" || event["kind"] == "evidence")
        .map(|event| &event["editing_agent"])
        .collect();
    assert_eq!(agents, [&json!("codex"), &json!("codex")]);
}

/// N2: an early CLI write carrying a Chat ID counts for its own Turn, even while
/// another Chat of the same harness has an observed Turn.
#[test]
fn writes_made_with_a_chat_id_are_credited_to_that_chat() {
    use ticketd_core::{
        CHAT_ID_VARIABLE, ChatAgentChange, ChatObservation, ChatSubmissionIntent, ChatTurnState,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let mut workspace = Workspace::open(workspace_path(path)).unwrap();
    let ticket = workspace.create_ticket("Fix the cache").unwrap();
    let mut chats = Vec::new();
    for turn in ["turn-a", "turn-b"] {
        let chat = workspace
            .create_chat(
                None,
                NewChat {
                    title: None,
                    harness: "codex".into(),
                    execution_folder: path.display().to_string(),
                    folder_managed: false,
                    links: Vec::new(),
                },
            )
            .unwrap();
        let input = workspace.save_chat_input(None, &chat.id, "go").unwrap();
        let attempt = format!("attempt-{turn}");
        workspace
            .record_chat_submission(&chat.id, &input.id, &attempt, ChatSubmissionIntent::NewTurn)
            .unwrap();
        chats.push(chat);
    }
    let start = |workspace: &mut Workspace, chat: &ticketd_core::Chat, turn: &str| {
        workspace
            .record_chat_observations(
                &chat.id,
                vec![
                    ChatObservation::TurnStarted {
                        turn_id: turn.into(),
                        native_turn_id: None,
                        origin: None,
                    },
                    ChatObservation::SubmissionProcessing {
                        attempt_id: format!("attempt-{turn}"),
                        turn_id: turn.into(),
                    },
                ],
            )
            .unwrap();
    };
    let run_as_a = |args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .current_dir(path)
            .env("TICKETD_TEST_WORKSPACE", workspace_path(path))
            .env(CHAT_ID_VARIABLE, &chats[0].id)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    };
    workspace
        .add_activity(&ticket.reference, "Before either Turn", Some("codex"))
        .unwrap();
    start(&mut workspace, &chats[1], "turn-b");
    run_as_a(&["change", "T-KQ1", "--status", "In progress"]);
    start(&mut workspace, &chats[0], "turn-a");
    run_as_a(&["activity", "add", "T-KQ1", "--brief", "From A"]);
    workspace
        .add_activity(&ticket.reference, "While both Turns run", Some("codex"))
        .unwrap();
    workspace
        .record_chat_observations(
            &chats[0].id,
            vec![ChatObservation::TurnEnded {
                turn_id: "turn-a".into(),
                state: ChatTurnState::Completed,
                detail: None,
                problem: None,
                problem_resets_at: None,
                ending: None,
            }],
        )
        .unwrap();
    run_as_a(&["activity", "add", "T-KQ1", "--brief", "After A ended"]);
    let next = workspace
        .save_chat_input(None, &chats[0].id, "next")
        .unwrap();
    workspace
        .record_chat_submission(
            &chats[0].id,
            &next.id,
            "attempt-turn-a-next",
            ChatSubmissionIntent::NewTurn,
        )
        .unwrap();
    start(&mut workspace, &chats[0], "turn-a-next");

    // All adjacent CLI writes and Turn boundaries share one stored millisecond.
    rusqlite::Connection::open(workspace_path(path))
        .unwrap()
        .execute_batch(
            "UPDATE ticket_history SET timestamp = '2026-01-01T00:00:00.001Z';
             UPDATE activities SET reported_at = CASE brief
                 WHEN 'Before either Turn' THEN '2026-01-01T00:00:00.000Z'
                 ELSE '2026-01-01T00:00:00.001Z' END;
             UPDATE chat_submission_attempts SET recorded_at = '2026-01-01T00:00:00.001Z';
             UPDATE chat_turns SET started_at = '2026-01-01T00:00:00.001Z',
                 ended_at = CASE WHEN ended_at IS NOT NULL THEN '2026-01-01T00:00:00.001Z' END;",
        )
        .unwrap();
    let credited = |chat: &ticketd_core::Chat, turn: &str| {
        workspace.chat_turn_agent_changes(&chat.id, turn).unwrap()
    };
    assert_eq!(
        credited(&chats[0], "turn-a"),
        [
            ChatAgentChange::Status {
                reference: ticket.reference.clone(),
                title: ticket.title,
                from: "Todo".into(),
                to: "In progress".into(),
            },
            ChatAgentChange::Update {
                reference: ticket.reference,
                excerpt: "From A".into(),
            },
        ]
    );
    assert!(credited(&chats[1], "turn-b").is_empty());
    assert!(credited(&chats[0], "turn-a-next").is_empty());
}

/// An Automation run's harness runs this CLI with the run's ID in
/// `TICKETD_AUTOMATION_RUN_ID`; what it writes is logged as made by an Automation, so it
/// cannot trigger Automations. Without the variable the same write is a person's.
#[test]
fn writes_made_inside_an_automation_run_are_logged_with_actor_automation() {
    use ticketd_core::{AUTOMATION_RUN_ID_VARIABLE, WorkspaceActor, WorkspaceEventType};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let workspace = {
        let mut workspace = Workspace::open(workspace_path(path)).unwrap();
        workspace.create_ticket("Fix the cache").unwrap();
        workspace
    };
    let head = workspace.workspace_event_head().unwrap();
    let add = |brief: &str, run: Option<&str>| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ticketd"));
        command
            .args(["activity", "add", "T-KQ1", "--brief", brief])
            .current_dir(path)
            .env("TICKETD_TEST_WORKSPACE", workspace_path(path))
            .env_remove(AUTOMATION_RUN_ID_VARIABLE);
        if let Some(run) = run {
            command.env(AUTOMATION_RUN_ID_VARIABLE, run);
        }
        let output = command.output().unwrap();
        assert!(output.status.success(), "{output:?}");
    };
    add("From the run", Some("run-1"));
    add("From a blank variable", Some(" "));
    add("From a terminal", None);

    let actors: Vec<_> = workspace
        .workspace_events_after(head, 10)
        .unwrap()
        .into_iter()
        .map(|event| (event.kind, event.actor))
        .collect();
    let posted = WorkspaceEventType::ActivityCreated;
    assert_eq!(
        actors,
        [
            (posted, WorkspaceActor::Automation),
            (posted, WorkspaceActor::Person),
            (posted, WorkspaceActor::Person),
        ]
    );
}
