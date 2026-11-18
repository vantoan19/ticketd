//! The Chat service as the bridge commands use it, with the fake adapter as the harness
//! and a temporary workspace behind the real core. No window and no real harness.
#![allow(clippy::unwrap_used, clippy::panic)] // test setup and assertions

use std::time::Duration;

use serde_json::json;
use ticketd_chat_host::testing::{FakeAdapter, SubmitReply, Written};
use ticketd_chat_host::{
    ApprovalDecision, DeliveryEvidence, EventKind, InteractionRequest, NativeItemId,
    NativeRequestId, NativeSessionId, NativeTurnId, NoticeKind, Problem, ProblemKind,
    ProviderDetail, ToolStatus, TurnOutcome,
};
use ticketd_core::{ChatDelivery, ChatSubmissionIntent};

use crate::chat_view::BranchView;

use super::*;
use ticketd_chat_host::conditions::ChatProblemKind;

struct Fixture {
    dir: tempfile::TempDir,
    fake: FakeAdapter,
    chats: Arc<Chats>,
}

/// Lets every task run until all of them wait. The clock is paused.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite3");
        // The desktop creates its workspace before its session opens it.
        drop(Workspace::open(&path).unwrap());
        let fake = FakeAdapter::codex();
        let chats = Chats::new(
            Arc::new(move || ticketd_core::WorkspaceSession::for_file(&path)?.workspace()),
            vec![Arc::new(fake.clone())],
            vec![(
                "claude-code",
                "Claude Code is unavailable: the bridge is missing.".to_owned(),
            )],
            None,
        );
        chats.set_enabled(true).await;
        Self { dir, fake, chats }
    }

    fn core(&self) -> Workspace {
        Workspace::open(self.dir.path().join("workspace.sqlite3")).unwrap()
    }

    fn input(&self, message: &str) -> NewChatInput {
        NewChatInput {
            command_id: uuid::Uuid::new_v4().to_string(),
            harness_id: "codex".to_owned(),
            folder: Some(self.dir.path().to_string_lossy().into_owned()),
            links: Vec::new(),
            message: message.to_owned(),
            model: None,
            effort: None,
            permission: None,
        }
    }

    /// A Chat whose first message was acknowledged and started `turn-1`.
    async fn chat(&self) -> String {
        let created = self.chats.create(self.input("first")).await.unwrap();
        settle().await;
        assert_eq!(created.send_error, None);
        created.chat_id
    }

    async fn open(&self, chat_id: &str) -> (Opened, Arc<Mutex<Vec<Value>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let opened = self.chats.open(
            chat_id,
            Arc::new(move |change| {
                sink.lock().unwrap().push(change);
                true
            }),
        );
        (opened.await.unwrap(), seen)
    }

    async fn emit(&self, kind: EventKind) {
        assert!(self.fake.emit(kind).await);
        settle().await;
    }

    fn submitted(&self) -> Vec<String> {
        self.fake
            .written()
            .into_iter()
            .filter_map(|written| match written {
                Written::Submit(submission) => Some(submission.text),
                _ => None,
            })
            .collect()
    }
}

fn turn() -> NativeTurnId {
    NativeTurnId::new("turn-1")
}

#[tokio::test(start_paused = true)]
async fn chat_does_nothing_while_the_switch_is_off_and_turning_it_off_stops_running_chats() {
    let f = Fixture::new().await;
    f.chats.set_enabled(false).await;
    assert!(f.chats.create(f.input("first")).await.is_err());
    assert_eq!(f.chats.working(), 0);
    assert_eq!(
        close_action(f.chats.enabled(), f.chats.stopping(), false),
        CloseAction::Exit
    );

    f.chats.set_enabled(true).await;
    f.chat().await;
    assert_eq!(f.chats.working(), 1);
    assert_eq!(f.chats.overview().unwrap().working, 1);
    assert_eq!(
        close_action(f.chats.enabled(), f.chats.stopping(), false),
        CloseAction::KeepRunning
    );

    let unconfirmed = f.chats.set_enabled(false).await;

    assert!(unconfirmed.is_empty());
    assert_eq!(f.chats.working(), 0);
    assert!(f.chats.list(ChatListFilter::Active).is_err());
    assert_eq!(
        f.core().list_chats(ChatListFilter::Active).unwrap().len(),
        1
    );
}

fn offered(id: &str, is_default: bool) -> ticketd_chat_host::SettingOption {
    ticketd_chat_host::SettingOption {
        id: id.to_owned(),
        label: id.to_uppercase(),
        description: None,
        is_default,
        permission: None,
        allowed: true,
    }
}

/// Codex as the fake lists it: two models, the second with efforts.
fn codex_options() -> ticketd_chat_host::HarnessOptions {
    ticketd_chat_host::HarnessOptions {
        models: vec![
            ticketd_chat_host::ModelChoice {
                model: offered("gpt-a", true),
                efforts: Vec::new(),
                runs_as: None,
            },
            ticketd_chat_host::ModelChoice {
                model: offered("gpt-b", false),
                efforts: vec![offered("low", false), offered("high", true)],
                runs_as: None,
            },
        ],
        permission: None,
    }
}

#[tokio::test(start_paused = true)]
async fn options_are_asked_once_per_version_and_say_why_when_there_are_none() {
    let f = Fixture::new().await;

    let none = f.chats.options("codex").await.unwrap();
    assert!(none.models.is_empty());
    assert!(
        none.unavailable.is_some(),
        "the picker says why it has only Default"
    );

    f.fake.set_options(codex_options());
    let listed = f.chats.options("codex").await.unwrap();
    f.chats.options("codex").await.unwrap();

    let models: Vec<_> = listed.models.iter().map(|m| m.model.id.as_str()).collect();
    assert_eq!(models, ["gpt-a", "gpt-b"]);
    // The failed probe is not remembered; the listed one is.
    assert_eq!(f.fake.options_asked(), 2);
}

#[tokio::test(start_paused = true)]
async fn new_chat_starts_its_session_with_the_picks_the_harness_offered() {
    let f = Fixture::new().await;
    f.fake.set_options(codex_options());
    let picked = NewChatInput {
        model: Some("gpt-b".to_owned()),
        effort: Some("high".to_owned()),
        ..f.input("first")
    };

    f.chats.create(picked).await.unwrap();
    settle().await;

    let settings = &f.fake.opens()[0].settings;
    assert_eq!(settings.model.as_deref(), Some("gpt-b"));
    assert_eq!(settings.effort.as_deref(), Some("high"));
    // An effort the chosen model does not offer is refused before any Chat exists.
    let unoffered = NewChatInput {
        model: Some("gpt-a".to_owned()),
        effort: Some("high".to_owned()),
        ..f.input("second")
    };
    assert!(f.chats.create(unoffered).await.is_err());
    assert_eq!(
        f.core().list_chats(ChatListFilter::Active).unwrap().len(),
        1
    );
}

#[test]
fn closing_keeps_chats_running_only_when_some_are_working_and_quit_asks_before_stopping_them() {
    let none = Stopping::default();
    let chats = Stopping { chats: 2, runs: 0 };
    let run = Stopping { chats: 0, runs: 1 };
    assert_eq!(close_action(false, none, false), CloseAction::Exit);
    assert_eq!(close_action(true, none, false), CloseAction::Exit);
    assert_eq!(close_action(true, chats, false), CloseAction::KeepRunning);
    assert_eq!(close_action(true, run, false), CloseAction::KeepRunning);
    assert_eq!(quit_action(none, false), QuitAction::Quit);
    assert_eq!(quit_action(chats, false), QuitAction::Confirm(chats));
    assert_eq!(quit_action(run, false), QuitAction::Confirm(run));
    assert_eq!(quit_action(chats, true), QuitAction::Quit);
}

/// L3: a run's Chat is kept out of the Chat list, so counting list rows missed every
/// run. What turning Chat off or quitting would stop counts runs that are going, each
/// once, beside the working Chats.
#[tokio::test(start_paused = true)]
async fn what_would_be_stopped_counts_runs_that_are_going_apart_from_working_chats() {
    let f = Fixture::new().await;
    let mut core = f.core();
    let agent = core
        .create_automation_agent(ticketd_core::AutomationAgentSettings {
            harness: ticketd_core::AgentHarness::Codex,
            ..Default::default()
        })
        .unwrap();
    let automation = core
        .create_automation(ticketd_core::AutomationDefinition {
            name: "Tidy".into(),
            trigger: Some(ticketd_core::Trigger::ByHand),
            conditions: Vec::new(),
            steps: vec![ticketd_core::Step {
                id: "agent".into(),
                action: ticketd_core::StepAction::RunAgent {
                    agent_id: Some(agent.id),
                    execution_folder: Some(f.dir.path().to_string_lossy().into_owned()),
                    on_failure: None,
                },
            }],
        })
        .unwrap();
    let queued = core.run_automation_now(&automation.id).unwrap();
    assert_eq!(
        f.chats.stopping(),
        Stopping::default(),
        "a queued run waits"
    );

    core.start_automation_runs(1).unwrap();
    // The run's agent working in its own Chat is still one run, not a Chat too.
    let ticketd_core::RunAction::RunAgent(start) =
        core.advance_automation_run(&queued.id, None).unwrap()
    else {
        panic!("the run begins with its agent");
    };
    let run_chat_id = start.chat_id;
    assert_eq!(f.chats.stopping(), Stopping { chats: 0, runs: 1 });
    let host = f.chats.automation_host().unwrap();
    let run_id = queued.id.clone();
    tokio::spawn(async move {
        let unattended = ticketd_chat_host::Unattended {
            run_id,
            model: None,
            tools: ticketd_core::AutomationAgentTools::default(),
            turn_limit: 5,
        };
        let _ = host
            .run_unattended(&run_chat_id, "go", unattended, Duration::from_secs(600))
            .await;
    });
    settle().await;
    assert_eq!(f.chats.working(), 1, "the run's agent is working");
    assert_eq!(f.chats.stopping(), Stopping { chats: 0, runs: 1 });
    assert_eq!(f.chats.overview().unwrap().working, 0, "the old count");

    f.chat().await;
    assert_eq!(f.chats.stopping(), Stopping { chats: 1, runs: 1 });

    f.chats.set_enabled(false).await;
    assert_eq!(f.chats.stopping(), Stopping::default());
}

#[tokio::test(start_paused = true)]
async fn closing_keeps_ticketd_in_the_tray_while_an_automation_is_on() {
    let f = Fixture::new().await;
    let closing = || {
        close_action(
            f.chats.enabled(),
            f.chats.stopping(),
            f.chats.automations_on(),
        )
    };
    assert_eq!(closing(), CloseAction::Exit);

    // No Chat is working: the Automation alone keeps ticketd running.
    let mut core = f.core();
    let automation = core
        .create_automation(ticketd_core::AutomationDefinition {
            name: "Triage".into(),
            trigger: Some(ticketd_core::Trigger::TagAdded {
                tag: "triage".into(),
            }),
            conditions: Vec::new(),
            steps: vec![ticketd_core::Step {
                id: "notify".into(),
                action: ticketd_core::StepAction::Notify {
                    text: "Tagged".into(),
                    opens: ticketd_core::NotifyTarget::Ticket,
                    on_failure: None,
                },
            }],
        })
        .unwrap();
    core.set_automation_enabled(&automation.id, true).unwrap();
    assert_eq!(closing(), CloseAction::KeepRunning);

    core.set_automation_enabled(&automation.id, false).unwrap();
    assert_eq!(closing(), CloseAction::Exit);
}

#[test]
fn an_automation_that_is_on_does_not_keep_ticketd_running_while_chat_is_off() {
    // With Chat off nothing runs Automations, so there is nothing to stay for.
    let run = Stopping { chats: 0, runs: 1 };
    assert_eq!(close_action(false, run, true), CloseAction::Exit);
}

#[test]
fn the_tray_says_what_the_hidden_chats_are_doing_now() {
    let tooltip = |working, needs_you| {
        tray_tooltip(&Overview {
            needs_you,
            working,
            ..Overview::default()
        })
    };
    assert_eq!(tooltip(2, 0), "ticketd: Chats are still working");
    // Finished while hidden: the app stays open for its results and for sync.
    assert_eq!(tooltip(0, 0), "ticketd is running in the background");
    // A Chat waiting for an approval still counts as working, but the person is needed.
    assert_eq!(tooltip(1, 1), "ticketd: 1 Chat needs you");
    assert_eq!(tooltip(0, 2), "ticketd: 2 Chats need you");
}

#[tokio::test(start_paused = true)]
async fn quit_stops_running_chats_and_nothing_is_accepted_afterwards() {
    let f = Fixture::new().await;
    let id = f.chat().await;

    assert!(f.chats.quit().await.is_empty());

    assert_eq!(f.chats.working(), 0);
    assert!(f.chats.send(&id, "more", SendMode::Auto).await.is_err());
    assert_eq!(f.submitted(), ["first"]);
}

#[tokio::test(start_paused = true)]
async fn a_chat_without_a_chosen_folder_gets_its_own_folder_beside_the_workspace() {
    let f = Fixture::new().await;
    let mut input = f.input("Plan the release\nwith details");
    input.folder = None;

    let id = f.chats.create(input).await.unwrap().chat_id;

    let chat = f.core().chat(&id).unwrap();
    let managed = format!("{}.chats", f.core().workspace_info().unwrap().path);
    assert!(chat.folder_managed);
    assert!(Path::new(&chat.execution_folder).starts_with(&managed));
    assert!(Path::new(&chat.execution_folder).is_dir());
    assert_eq!(chat.title.as_deref(), Some("Plan the release"));
    assert_eq!(f.chats.folder_use(&chat.execution_folder).unwrap(), 1);
}

#[tokio::test(start_paused = true)]
async fn requests_are_checked_before_anything_is_stored() {
    let f = Fixture::new().await;
    let mut claude = f.input("first");
    claude.harness_id = "claude-code".to_owned();
    let mut missing = f.input("first");
    missing.folder = Some(f.dir.path().join("gone").to_string_lossy().into_owned());

    let refused = f.chats.create(claude).await.unwrap_err();
    assert_eq!(
        refused.message,
        "Claude Code is unavailable: the bridge is missing."
    );
    assert!(f.chats.create(missing).await.is_err());
    assert!(f.chats.create(f.input("  ")).await.is_err());
    assert!(
        f.core()
            .list_chats(ChatListFilter::Active)
            .unwrap()
            .is_empty()
    );

    let unknown_field = json!({ "command_id": "c", "harness_id": "codex", "folder": null, "links": [], "message": "m", "shell": "rm" });
    assert!(serde_json::from_value::<NewChatInput>(unknown_field).is_err());
    assert!(serde_json::from_value::<LinkRef>(json!({ "kind": "plan", "id": "p" })).is_err());
    assert!(serde_json::from_value::<Answer>(json!({ "option_id": 1 })).is_err());
    assert!(serde_json::from_value::<HistorySelection>(json!({ "kind": "everything" })).is_err());
    // A setting is one the bridge names; anything else is refused before the host.
    assert_eq!(
        serde_json::from_value::<SettingKey>(json!("effort")).unwrap(),
        SettingKey::Effort
    );
    assert!(serde_json::from_value::<SettingKey>(json!("sandbox")).is_err());

    let statuses = f.chats.harnesses().await.unwrap();
    let status = |id: &str| statuses.iter().find(|s| s.id == id).unwrap().status;
    assert_eq!(status("claude-code"), HarnessState::Unavailable);
    assert_ne!(status("codex"), HarnessState::Unavailable);
}

#[tokio::test(start_paused = true)]
async fn a_view_follows_numbered_changes_in_ticketd_terms_and_answers_only_live_requests() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    let (opened, seen) = f.open(&id).await;
    assert_eq!(opened.snapshot.cursor, 0);
    assert_eq!(opened.snapshot.chat.activity, "working");
    // The turn that took the message gives its timing, which the view folds it by.
    let [
        Item::User {
            delivery: "delivered",
            text,
            turn_id: Some(took),
            steer: false,
            ..
        },
        Item::Turn {
            turn_id,
            outcome: "active",
            ended_at: None,
            ..
        },
    ] = opened.snapshot.items.as_slice()
    else {
        panic!(
            "expected the message and its turn: {:?}",
            opened.snapshot.items
        );
    };
    assert_eq!((text.as_str(), took), ("first", turn_id));
    let turn_id = turn_id.clone();

    f.emit(EventKind::TextDelta {
        turn: turn(),
        item: NativeItemId::new("m1"),
        text: "Hel".to_owned(),
    })
    .await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    f.emit(EventKind::MessageCompleted {
        turn: turn(),
        item: NativeItemId::new("m1"),
        text: "Hello".to_owned(),
    })
    .await;
    f.emit(EventKind::InteractionRequested(InteractionRequest {
        request: NativeRequestId::new("approval-1"),
        turn: Some(turn()),
        item: None,
        kind: InteractionKind::Approval {
            description: "Run cargo test".to_owned(),
            reason: None,
            decisions: vec![ApprovalDecision::Allow, ApprovalDecision::Deny],
        },
        detail: None,
    }))
    .await;

    let changes = seen.lock().unwrap().clone();
    let sequences: Vec<_> = changes.iter().map(|c| c["seq"].as_u64().unwrap()).collect();
    assert_eq!(sequences, (1..=changes.len() as u64).collect::<Vec<_>>());
    let responses: Vec<_> = changes
        .iter()
        .filter(|change| change["item"]["kind"] == "response")
        .map(|change| (&change["item"]["state"], &change["item"]["text"]))
        .collect();
    assert!(
        changes
            .iter()
            .filter(|change| change["item"]["kind"] == "response")
            .all(|change| change["item"]["turn_id"] == json!(turn_id)),
        "a streamed response says which turn it belongs to"
    );
    assert_eq!(
        responses.first().unwrap(),
        &(&json!("streaming"), &json!("Hel"))
    );
    assert_eq!(
        responses.last().unwrap(),
        &(&json!("complete"), &json!("Hello"))
    );
    let request = changes
        .iter()
        .rev()
        .find(|change| change["item"]["kind"] == "request")
        .unwrap()["item"]
        .clone();
    assert_eq!(request["state"], "pending");
    assert_eq!(request["subject"], "Run cargo test");
    assert_eq!(
        request["options"],
        json!([{ "id": "allow", "label": "Allow once" }, { "id": "deny", "label": "Deny" }])
    );
    let waiting = changes.iter().rev().find(|c| c["kind"] == "chat").unwrap();
    assert_eq!(waiting["chat"]["activity"], "waiting");
    assert_eq!(f.chats.overview().unwrap().needs_you, 1);

    let request_id = request["id"].as_str().unwrap();
    let not_offered = Answer::Choice {
        option_id: "allow_for_session".to_owned(),
    };
    let allow = || Answer::Choice {
        option_id: "allow".to_owned(),
    };
    let refused = f.chats.answer(&id, request_id, not_offered).await;
    assert_eq!(refused.unwrap_err().code, "failed");
    f.chats.answer(&id, request_id, allow()).await.unwrap();
    settle().await;
    let again = f.chats.answer(&id, request_id, allow()).await;
    assert_eq!(again.unwrap_err().code, "stale");
}

fn command_tool(item: &str, command: &str, status: ToolStatus) -> EventKind {
    EventKind::ToolUpdated {
        turn: turn(),
        item: NativeItemId::new(item),
        title: "commandExecution".to_owned(),
        status,
        output: None,
        detail: Some(ProviderDetail::new(
            "commandExecution",
            &json!({ "type": "commandExecution", "command": command, "status": "inProgress" })
                .to_string(),
        )),
    }
}

#[tokio::test(start_paused = true)]
async fn a_decided_approval_folds_into_the_step_it_answered_and_no_other() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    f.emit(command_tool(
        "cmd-1",
        "rm -rf node_modules",
        ToolStatus::Running,
    ))
    .await;
    f.emit(EventKind::InteractionRequested(InteractionRequest {
        request: NativeRequestId::new("approval-1"),
        turn: Some(turn()),
        item: Some(NativeItemId::new("cmd-1")),
        kind: InteractionKind::Approval {
            description: "rm -rf node_modules".to_owned(),
            reason: None,
            decisions: vec![ApprovalDecision::Allow, ApprovalDecision::Deny],
        },
        detail: None,
    }))
    .await;
    let (opened, seen) = f.open(&id).await;
    let (request_id, title, subject) = opened
        .snapshot
        .items
        .iter()
        .find_map(|item| match item {
            Item::Request {
                id, title, subject, ..
            } => Some((id.clone(), title.clone(), subject.clone())),
            _ => None,
        })
        .unwrap();
    // Its title says what it would do, with the command inline after it.
    assert_eq!(
        (title.as_str(), subject.as_deref()),
        ("Codex wants to delete", Some("node_modules"))
    );
    let deny = Answer::Choice {
        option_id: "deny".to_owned(),
    };
    f.chats.answer(&id, &request_id, deny).await.unwrap();
    settle().await;
    // The step it answered is shown again with the decision; the request is folded.
    let changes = seen.lock().unwrap().clone();
    let step = changes
        .iter()
        .rev()
        .find(|change| change["item"]["kind"] == "steps")
        .map(|change| change["item"]["steps"][0]["decision"].clone());
    assert_eq!(step, Some(json!("You declined this")));
    let request = changes
        .iter()
        .rev()
        .find(|change| change["item"]["kind"] == "request")
        .map(|change| change["item"]["folded"].clone());
    assert_eq!(request, Some(json!(true)));

    // A later step is not the one it answered, and a snapshot folds the same way.
    f.emit(command_tool("cmd-2", "npm test", ToolStatus::Running))
        .await;
    let (opened, _) = f.open(&id).await;
    let decisions: Vec<Option<String>> = opened
        .snapshot
        .items
        .iter()
        .filter_map(|item| match item {
            Item::Steps { steps, .. } => Some(steps[0].decision.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        decisions,
        [Some("You declined this".to_owned()), None],
        "{:?}",
        opened.snapshot.items
    );
}

#[tokio::test(start_paused = true)]
async fn a_steer_the_harness_refused_waits_in_the_queue_saying_why() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    let reply = f.fake.hold_next_submit();
    f.chats
        .send(&id, "also this", SendMode::Auto)
        .await
        .unwrap();
    settle().await;
    reply
        .send(SubmitReply::Reject("a tool is still running".to_owned()))
        .unwrap();
    settle().await;
    let (opened, _) = f.open(&id).await;
    let queued: Vec<_> = opened
        .snapshot
        .chat
        .queue
        .iter()
        .map(|queued| (queued.text.as_str(), queued.refused_steer.as_deref()))
        .collect();
    assert_eq!(queued, [("also this", Some("a tool is still running"))]);
}

#[tokio::test(start_paused = true)]
async fn the_harness_s_slash_commands_reach_the_composer() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    f.emit(EventKind::CommandsListed(vec![
        ticketd_chat_host::HarnessCommand {
            name: "review".to_owned(),
            description: Some("Review a pull request".to_owned()),
        },
    ]))
    .await;
    let (opened, _) = f.open(&id).await;
    let commands: Vec<_> = opened
        .snapshot
        .chat
        .commands
        .iter()
        .map(|command| (command.name.as_str(), command.description.as_deref()))
        .collect();
    assert_eq!(commands, [("review", Some("Review a pull request"))]);
}

#[tokio::test(start_paused = true)]
async fn the_view_reopens_with_what_the_person_read_through() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    let (opened, _) = f.open(&id).await;
    assert_eq!(opened.snapshot.chat.read_through, None);
    let turn_item = opened
        .snapshot
        .items
        .iter()
        .find_map(|item| match item {
            Item::Turn { id, .. } => Some(id.clone()),
            _ => None,
        })
        .unwrap();
    f.chats.read_through(&id, &turn_item).unwrap();
    let (opened, _) = f.open(&id).await;
    // Kept by the record it names, so it is the same item when read back.
    let read = opened.snapshot.chat.read_through.unwrap();
    assert_eq!(format!("turn:{read}"), turn_item);
}

#[tokio::test(start_paused = true)]
async fn reopening_attaches_to_the_running_chat_and_closing_a_view_stops_nothing() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    let (first, seen) = f.open(&id).await;

    f.chats.close(first.subscription);
    settle().await;
    let (second, _) = f.open(&id).await;

    assert_eq!(seen.lock().unwrap().last().unwrap()["kind"], "resync");
    assert_eq!(second.snapshot.chat.activity, "working");
    assert_eq!(f.fake.opens().len(), 1, "no second runtime was started");
    assert_eq!(f.submitted(), ["first"]);
    assert_eq!(f.chats.working(), 1);
}

#[tokio::test(start_paused = true)]
async fn queued_input_is_shown_as_the_queue_and_can_be_withdrawn() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    f.chats.stop(&id).await.unwrap();
    f.chats.send(&id, "later", SendMode::Queue).await.unwrap();
    settle().await;
    let (opened, seen) = f.open(&id).await;
    let [queued] = opened.snapshot.chat.queue.as_slice() else {
        panic!("expected one queued message");
    };
    assert_eq!(queued.text, "later");
    assert!(opened.snapshot.chat.queue_paused);
    let shown: Vec<_> = opened
        .snapshot
        .items
        .iter()
        .filter(|item| !matches!(item, Item::Turn { .. }))
        .collect();
    assert_eq!(shown.len(), 1, "queued input is not history: {shown:?}");

    f.chats.remove_queued(&id, &queued.id).await.unwrap();
    settle().await;

    assert!(f.core().chat_queue(&id).unwrap().is_empty());
    assert_eq!(seen.lock().unwrap().last().unwrap()["kind"], "resync");
    assert!(f.chats.remove_queued(&id, &queued.id).await.is_err());
}

/// #363: Steer always says what it does, Stop reads as in progress until the harness
/// confirms or the wait ends, and Send now takes one queued message out of the queue.
#[tokio::test(start_paused = true)]
async fn steering_says_its_effect_stop_shows_progress_and_send_now_takes_one_queued_message() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    let (opened, _) = f.open(&id).await;
    let chat = &opened.snapshot.chat;
    assert!(chat.steering.available);
    assert!(chat.steering.effect.is_some());
    assert!(!chat.stopping);

    f.chats.send(&id, "later", SendMode::Queue).await.unwrap();
    f.chats.send(&id, "now", SendMode::Queue).await.unwrap();
    settle().await;
    let (opened, _) = f.open(&id).await;
    let now = opened.snapshot.chat.queue[1].id.clone();
    f.chats.send_queued_now(&id, &now).await.unwrap();
    settle().await;
    assert_eq!(f.submitted(), ["first", "now"]);

    f.chats.stop(&id).await.unwrap();
    settle().await;
    let (opened, _) = f.open(&id).await;
    assert!(opened.snapshot.chat.stopping);
    let queue: Vec<_> = opened.snapshot.chat.queue.iter().map(|q| &q.text).collect();
    assert_eq!(queue, ["later"]);
}

#[tokio::test(start_paused = true)]
async fn an_uncertain_submission_waits_for_the_person_and_is_resent_only_when_they_say_so() {
    let f = Fixture::new().await;
    f.fake.script_submit(SubmitReply::LoseProcess);
    let id = f.chats.create(f.input("first")).await.unwrap().chat_id;
    settle().await;
    let (opened, _) = f.open(&id).await;
    let problem = opened.snapshot.chat.problem.unwrap();
    assert_eq!(problem.kind, ChatProblemKind::UncertainDelivery);
    let message_id = problem.message_id.unwrap();
    assert!(matches!(
        opened.snapshot.items.as_slice(),
        [Item::User {
            delivery: "uncertain",
            ..
        }]
    ));
    assert_eq!(f.chats.overview().unwrap().needs_you, 1);
    assert_eq!(f.submitted(), ["first"], "nothing was resent by itself");

    let resend = UncertainDecision::Resend;
    f.chats
        .resolve_uncertain(&id, &message_id, resend)
        .await
        .unwrap();
    settle().await;

    assert_eq!(f.submitted(), ["first", "first"]);
    let again = f.chats.resolve_uncertain(&id, &message_id, resend).await;
    assert_eq!(again.unwrap_err().code, "stale");
}

#[test]
fn missing_harness_guidance_includes_install_help_and_its_own_sign_in_command() {
    for (id, name, command, help) in [
        (
            "codex",
            "Codex",
            "codex login",
            "https://developers.openai.com/codex/cli",
        ),
        (
            "claude-code",
            "Claude Code",
            "claude /login",
            "https://code.claude.com/docs/en/setup",
        ),
    ] {
        let status = harness_status(id, name, Inspection::NotInstalled);
        assert_eq!(status.status, HarnessState::NotInstalled);
        assert_eq!(status.command.as_deref(), Some(command));
        assert_eq!(status.help_url.as_deref(), Some(help));
        assert!(!status.status.usable());
    }
}

#[tokio::test(start_paused = true)]
async fn a_fresh_session_starts_with_the_history_the_person_selected_and_replays_nothing() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    f.emit(EventKind::SessionIdentified {
        native_session: NativeSessionId::new("native-1"),
    })
    .await;
    f.emit(EventKind::MessageCompleted {
        turn: turn(),
        item: NativeItemId::new("m1"),
        text: "The plan is ready.".to_owned(),
    })
    .await;
    f.fake.lose_process().await;
    settle().await;

    let selection = HistorySelection::LastMessages { count: 2 };
    f.chats.resume(&id, selection).await.unwrap();
    f.emit(EventKind::SessionIdentified {
        native_session: NativeSessionId::new("native-2"),
    })
    .await;

    assert_eq!(f.submitted(), ["first"], "nothing was replayed");
    let (opened, _) = f.open(&id).await;
    assert!(opened.snapshot.items.iter().any(|item| matches!(
        item,
        Item::Session {
            history: "last_messages",
            count: 2,
            ..
        }
    )));
    f.chats.send(&id, "continue", SendMode::Auto).await.unwrap();
    settle().await;
    let sent = f.submitted().pop().unwrap();
    assert!(sent.contains("User:\nfirst") && sent.contains("Assistant:\nThe plan is ready."));
    assert!(sent.ends_with("\n\ncontinue"));
    let too_many = HistorySelection::LastMessages { count: 0 };
    assert!(f.chats.resume(&id, too_many).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn a_response_is_saved_as_a_document_and_retention_changes_reach_the_list() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    f.emit(EventKind::MessageCompleted {
        turn: turn(),
        item: NativeItemId::new("m1"),
        text: "The plan is ready.".to_owned(),
    })
    .await;
    let (opened, _) = f.open(&id).await;
    let Some(Item::Response { id: response, .. }) = opened.snapshot.items.last() else {
        panic!("expected the response");
    };
    let user = match &opened.snapshot.items[0] {
        Item::User { id, .. } => id.clone(),
        other => panic!("expected the user message, got {other:?}"),
    };

    let document = f
        .chats
        .save_as_document(&id, response, "Release plan")
        .unwrap();
    assert_eq!(
        f.core().show_document(&document).unwrap().body,
        "The plan is ready."
    );
    assert!(f.chats.save_as_document(&id, &user, "Mine").is_err());

    f.chats
        .set_retention(&id, Retention::Archive)
        .await
        .unwrap();
    let archived = f.chats.list(ChatListFilter::Archived).unwrap();
    assert_eq!(
        archived[0].activity, "working",
        "archive leaves work running"
    );
    assert_eq!(archived[0].preview.as_deref(), Some("The plan is ready."));
    f.chats.set_retention(&id, Retention::Trash).await.unwrap();
    assert_eq!(f.chats.working(), 0, "trash stops it");
    f.chats
        .set_retention(&id, Retention::Restore)
        .await
        .unwrap();
    settle().await;
    assert_eq!(f.submitted(), ["first"], "restore replays nothing");
}

fn user_deliveries(opened: &Opened) -> Vec<&'static str> {
    let items = opened.snapshot.items.iter();
    items
        .filter_map(|item| match item {
            Item::User { delivery, .. } => Some(*delivery),
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn input_a_turn_processed_reads_as_delivered_and_never_as_awaiting_a_decision() {
    let f = Fixture::new().await;
    // As Claude Code does: no acknowledgment, only a turn correlated with the input.
    f.fake.script_submit(SubmitReply::Timeout);
    let id = f.chats.create(f.input("first")).await.unwrap().chat_id;
    settle().await;
    let attempt = match f.fake.written().remove(0) {
        Written::Submit(submission) => submission.submission,
        other => panic!("expected the submission, got {other:?}"),
    };
    f.emit(EventKind::SubmissionEvidence {
        submission: attempt.clone(),
        evidence: DeliveryEvidence::Processing { turn: turn() },
    })
    .await;
    f.emit(EventKind::TurnEnded {
        turn: turn(),
        outcome: TurnOutcome::Completed,
        submissions: vec![attempt],
    })
    .await;

    // Contact ends after the turn completed, as on any quit or restart.
    f.fake.lose_process().await;
    settle().await;

    let (opened, _) = f.open(&id).await;
    assert_eq!(user_deliveries(&opened), ["delivered"]);
    let problem = opened.snapshot.chat.problem.map(|problem| problem.kind);
    assert_ne!(problem, Some(ChatProblemKind::UncertainDelivery));
}

#[tokio::test(start_paused = true)]
async fn discarding_an_uncertain_message_keeps_it_and_its_uncertainty_and_sends_nothing() {
    let f = Fixture::new().await;
    f.fake.script_submit(SubmitReply::LoseProcess);
    let id = f.chats.create(f.input("first")).await.unwrap().chat_id;
    settle().await;
    f.chats.send(&id, "later", SendMode::Queue).await.unwrap();
    let (opened, _) = f.open(&id).await;
    let message_id = opened.snapshot.chat.problem.unwrap().message_id.unwrap();

    let discard = UncertainDecision::Discard;
    f.chats
        .resolve_uncertain(&id, &message_id, discard)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(3_600)).await;

    let (opened, _) = f.open(&id).await;
    assert_eq!(user_deliveries(&opened), ["set_aside"]);
    assert_eq!(
        opened.snapshot.chat.problem.map(|p| p.kind),
        Some(ChatProblemKind::Failed)
    );
    let stored = messages(&f.core(), &id).unwrap().remove(0);
    assert_eq!(stored.attempts.len(), 1);
    assert_eq!(stored.attempts[0].delivery, ChatDelivery::Uncertain);
    assert_eq!(f.submitted(), ["first"]);
    assert_eq!(f.core().chat_queue(&id).unwrap().len(), 1);
    let again = f.chats.resolve_uncertain(&id, &message_id, discard).await;
    assert_eq!(again.unwrap_err().code, "stale");
}

#[tokio::test(start_paused = true)]
async fn resending_an_uncertain_message_sends_that_message_alone_as_a_new_submission() {
    let f = Fixture::new().await;
    f.fake.script_submit(SubmitReply::LoseProcess);
    let id = f.chats.create(f.input("first")).await.unwrap().chat_id;
    settle().await;
    f.chats.send(&id, "later", SendMode::Queue).await.unwrap();
    let (opened, _) = f.open(&id).await;
    let message_id = opened.snapshot.chat.problem.unwrap().message_id.unwrap();

    let resend = UncertainDecision::Resend;
    f.chats
        .resolve_uncertain(&id, &message_id, resend)
        .await
        .unwrap();
    settle().await;
    f.emit(EventKind::TurnEnded {
        turn: turn(),
        outcome: TurnOutcome::Completed,
        submissions: Vec::new(),
    })
    .await;
    tokio::time::sleep(Duration::from_secs(3_600)).await;

    assert_eq!(f.submitted(), ["first", "first"], "the queue was not sent");
    let stored = messages(&f.core(), &id).unwrap().remove(0);
    let deliveries: Vec<_> = stored.attempts.iter().map(|a| a.delivery).collect();
    assert_eq!(
        deliveries,
        [ChatDelivery::Uncertain, ChatDelivery::Acknowledged]
    );
    assert_ne!(stored.attempts[0].id, stored.attempts[1].id);
    assert!(f.core().chat(&id).unwrap().queue_paused);
}

#[tokio::test(start_paused = true)]
async fn restoring_the_workspace_stops_chats_reconciles_and_dispatches_nothing() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    let (_, seen) = f.open(&id).await;
    assert_eq!(f.chats.working(), 1);

    let unconfirmed = f.chats.begin_restore().await;
    assert!(unconfirmed.is_empty());
    assert_eq!(f.chats.working(), 0, "no harness runs across a restore");
    assert!(matches!(f.fake.written().last(), Some(Written::Close(_))));
    assert!(f.chats.send(&id, "during", SendMode::Auto).await.is_err());
    // What a backup can hold: a turn in progress, a submission in flight, queued input.
    let mut core = f.core();
    core.set_chat_queue_paused(&id, false).unwrap();
    let flying = core.save_chat_input(None, &id, "in flight").unwrap();
    core.record_chat_submission(&id, &flying.id, "a-restored", ChatSubmissionIntent::NewTurn)
        .unwrap();
    core.save_chat_input(None, &id, "queued in the backup")
        .unwrap();
    drop(core);

    f.chats.finish_restore().unwrap();
    tokio::time::sleep(Duration::from_secs(3_600)).await;

    assert_eq!(f.submitted(), ["first"], "nothing restored was dispatched");
    assert_eq!(f.fake.opens().len(), 1, "no harness was started");
    let chat = f.core().chat(&id).unwrap();
    assert!(chat.queue_paused && chat.active_turn.is_none());
    assert_eq!(seen.lock().unwrap().last().unwrap()["kind"], "resync");
    let (opened, _) = f.open(&id).await;
    assert_eq!(
        opened.snapshot.chat.problem.unwrap().kind,
        ChatProblemKind::UncertainDelivery
    );
    assert_eq!(opened.snapshot.chat.queue.len(), 1);
    assert_eq!(f.fake.opens().len(), 1, "opening the view started nothing");
}

#[tokio::test(start_paused = true)]
async fn a_typed_failure_notices_and_reported_settings_reach_a_view_opened_afterwards() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    let problem = |kind| Problem {
        kind,
        message: "said by the harness".to_owned(),
        detail: None,
        resets_at: None,
    };
    f.emit(EventKind::Notice {
        turn: None,
        kind: NoticeKind::EffectiveSettings,
        message: "settings".to_owned(),
        detail: Some(ProviderDetail::new(
            "settings",
            r#"{"model":"m-1","permission_mode":"default"}"#,
        )),
    })
    .await;
    f.emit(EventKind::Notice {
        turn: Some(turn()),
        kind: NoticeKind::Retrying,
        message: "Reconnecting (2/5)".to_owned(),
        detail: None,
    })
    .await;
    f.emit(EventKind::TurnEnded {
        turn: turn(),
        outcome: TurnOutcome::Failed(problem(ProblemKind::QuotaExhausted)),
        submissions: Vec::new(),
    })
    .await;
    // A failed turn waits for the person until they have seen it.
    assert_eq!(f.chats.overview().unwrap().needs_you, 1);

    let (opened, _) = f.open(&id).await;
    let shown = opened.snapshot.chat.problem.unwrap();
    assert_eq!(shown.kind, ChatProblemKind::UsageLimit);
    assert_eq!(shown.message.as_deref(), Some("said by the harness"));
    assert!(opened.snapshot.items.iter().any(|item| matches!(
        item,
        Item::Marker { reason: "warning", message: Some(text), .. } if text == "Reconnecting (2/5)"
    )));
    let permissions = opened.snapshot.chat.harness.permissions.unwrap();
    assert!(permissions.contains("model m-1") && permissions.contains("permission mode default"));
    assert_eq!(
        f.chats.overview().unwrap().needs_you,
        0,
        "opening it saw it"
    );
    f.chats.close(opened.subscription);

    // A sign-in failure that stopped a turn counts too, until seen.
    f.chats.send(&id, "again", SendMode::Auto).await.unwrap();
    settle().await;
    f.emit(EventKind::TurnEnded {
        turn: NativeTurnId::new("turn-2"),
        outcome: TurnOutcome::Failed(problem(ProblemKind::LoginRequired)),
        submissions: Vec::new(),
    })
    .await;
    assert_eq!(f.chats.overview().unwrap().needs_you, 1);
    let (opened, _) = f.open(&id).await;
    let shown = opened.snapshot.chat.problem.unwrap();
    assert_eq!(shown.kind, ChatProblemKind::NotSignedIn);
    assert_eq!(shown.command.as_deref(), Some("codex login"));
    assert_eq!(f.chats.overview().unwrap().needs_you, 0);
}

#[tokio::test(start_paused = true)]
async fn api_key_and_unknown_sign_in_are_their_own_statuses_with_an_explanation() {
    let f = Fixture::new().await;
    let status = |login| {
        let inspection = Inspection::Installed {
            executable: PathBuf::from("harness"),
            version: Some("1.0".to_owned()),
            login,
            capabilities: ticketd_chat_host::Capabilities {
                steering: ticketd_chat_host::Capability::Unknown {
                    reason: String::new(),
                },
                native_resume: ticketd_chat_host::Capability::Unknown {
                    reason: String::new(),
                },
            },
        };
        harness_status("claude-code", "Claude Code", inspection)
    };

    let ready = status(LoginState::SignedIn);
    assert_eq!(ready.status, HarnessState::Ready);
    // The context popover's "1.0 · harness" (#368).
    assert_eq!(
        (ready.version.as_deref(), ready.path.as_deref()),
        (Some("1.0"), Some("harness"))
    );
    let api_key = status(LoginState::NonSubscription);
    assert_eq!(api_key.status, HarnessState::NotSubscription);
    assert!(api_key.message.unwrap().contains("not a subscription"));
    let unknown = status(LoginState::Unknown);
    assert_eq!(unknown.status, HarnessState::SignInUnknown);
    assert!(unknown.message.unwrap().contains("cannot check"));
    let signed_out = status(LoginState::SignedOut);
    assert_eq!(signed_out.status, HarnessState::NotSignedIn);
    assert_eq!(signed_out.command.as_deref(), Some("claude /login"));

    // Neither blocks a Chat; both are told before the first message.
    f.fake.set_inspection(Inspection::NotInstalled);
    let listed = f.chats.harnesses().await.unwrap();
    let codex = listed.iter().find(|status| status.id == "codex").unwrap();
    assert_eq!(codex.status, HarnessState::NotInstalled);
    assert!(codex.help_url.is_some());
}

#[tokio::test(start_paused = true)]
async fn a_fresh_session_leaves_out_uncertain_input_unless_picked_and_marks_partial_text() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    f.emit(EventKind::TextDelta {
        turn: turn(),
        item: NativeItemId::new("m1"),
        text: "Half an ans".to_owned(),
    })
    .await;
    f.fake.lose_process().await;
    settle().await;
    f.fake.script_submit(SubmitReply::LoseProcess);
    f.chats
        .send(&id, "maybe sent", SendMode::Auto)
        .await
        .unwrap();
    settle().await;
    let uncertain = messages(&f.core(), &id)
        .unwrap()
        .into_iter()
        .find(|message| message.text == "maybe sent")
        .unwrap();
    assert!(uncertain.awaits_decision());

    f.chats.resume(&id, HistorySelection::All).await.unwrap();
    f.chats.send(&id, "continue", SendMode::Auto).await.unwrap();
    settle().await;
    let sent = f.submitted().pop().unwrap();
    assert!(!sent.contains("maybe sent"));
    assert!(sent.contains("Assistant (incomplete"));
    assert!(sent.contains("Half an ans"));

    f.fake.lose_process().await;
    settle().await;
    let picked = HistorySelection::Picked {
        ids: vec![uncertain.id],
    };
    f.chats.resume(&id, picked).await.unwrap();
    f.chats.send(&id, "go on", SendMode::Auto).await.unwrap();
    settle().await;
    let sent = f.submitted().pop().unwrap();
    assert!(sent.contains("User (it is not known whether"));
    assert!(sent.contains("maybe sent"));

    f.chats.set_retention(&id, Retention::Trash).await.unwrap();
    let opens = f.fake.opens().len();
    assert!(f.chats.resume(&id, HistorySelection::All).await.is_err());
    assert_eq!(f.fake.opens().len(), opens, "a trashed Chat starts nothing");
}

#[tokio::test(start_paused = true)]
async fn a_failed_first_send_returns_the_chat_and_a_retry_makes_no_second_one() {
    let f = Fixture::new().await;
    let mut linked = f.input("first");
    linked.folder = None;
    linked.links = vec![LinkRef {
        kind: LinkKind::Ticket,
        id: "no-such-ticket".to_owned(),
    }];
    assert!(f.chats.create(linked).await.is_err());
    let managed = format!("{}.chats", f.core().workspace_info().unwrap().path);
    assert!(
        !Path::new(&managed).exists(),
        "a refused Chat leaves no folder"
    );

    // The Chat is stored, then its first message cannot be saved.
    let input = f.input("first");
    f.chats.quit().await;
    let first = f.chats.create(input.clone()).await.unwrap();
    assert!(first.send_error.is_some());

    let again = f.chats.create(input).await.unwrap();
    assert_eq!(again.chat_id, first.chat_id);
    assert_eq!(
        f.core().list_chats(ChatListFilter::Active).unwrap().len(),
        1
    );
}

#[tokio::test(start_paused = true)]
async fn repeating_a_new_chat_request_sends_its_first_message_once() {
    let f = Fixture::new().await;
    let input = f.input("first");

    let first = f.chats.create(input.clone()).await.unwrap();
    settle().await;
    let again = f.chats.create(input).await.unwrap();
    settle().await;

    assert_eq!(
        (again.chat_id.as_str(), again.send_error),
        (first.chat_id.as_str(), None)
    );
    assert_eq!(f.submitted(), ["first"]);
    assert_eq!(messages(&f.core(), &first.chat_id).unwrap().len(), 1);
    let not_a_uuid = NewChatInput {
        command_id: "../elsewhere".to_owned(),
        ..f.input("first")
    };
    assert!(f.chats.create(not_a_uuid).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn the_list_is_not_read_again_for_checkpointed_text_and_shared_folders_are_named() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    f.emit(EventKind::TextDelta {
        turn: turn(),
        item: NativeItemId::new("m1"),
        text: "x".repeat(200),
    })
    .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let (_, before, _) = f.chats.overview_digest().unwrap();
    let written = f.chats.digest();

    f.emit(EventKind::TextDelta {
        turn: turn(),
        item: NativeItemId::new("m1"),
        text: " and more".to_owned(),
    })
    .await;
    tokio::time::sleep(Duration::from_secs(2)).await;

    assert_ne!(f.chats.digest(), written, "the checkpoint was written");
    assert_eq!(f.chats.overview_digest().unwrap().1, before);

    let other = f.chats.create(f.input("second")).await.unwrap().chat_id;
    settle().await;
    let titles = |opened: &Opened| {
        let shared = &opened.snapshot.chat.folder.shared_with;
        shared
            .iter()
            .map(|chat| chat.title.clone())
            .collect::<Vec<_>>()
    };
    let (opened, _) = f.open(&other).await;
    assert_eq!(titles(&opened), ["first"]);
    // Each is named by its id too, so the popover can open it.
    assert_eq!(opened.snapshot.chat.folder.shared_with[0].id, id);
    let (opened, _) = f.open(&id).await;
    assert_eq!(titles(&opened), ["second"]);
}

#[tokio::test(start_paused = true)]
async fn a_project_can_be_linked_found_and_named_to_the_agent_without_moving_the_chat() {
    let f = Fixture::new().await;
    let project = f
        .core()
        .create_project("Storefront", "/work/store")
        .unwrap();
    let link = || LinkRef {
        kind: LinkKind::Project,
        id: project.id.clone(),
    };
    assert_eq!(
        serde_json::from_value::<LinkRef>(json!({ "kind": "project", "id": project.id })).unwrap(),
        link()
    );
    // With nothing typed, the recently updated records are offered.
    let ticket = f.core().create_ticket("Recent work").unwrap();
    let recent = f.chats.search_records("").unwrap();
    assert!(
        recent.iter().any(|record| matches!(
            record,
            LinkedRecord::Ticket { id, .. } if *id == ticket.id
        )),
        "{recent:?}"
    );
    let found = f.chats.search_records("store").unwrap();
    assert_eq!(
        found,
        [LinkedRecord::Project {
            id: project.id.clone(),
            title: "Storefront".to_owned()
        }]
    );

    let id = f.chat().await;
    let folder = f.core().chat(&id).unwrap().execution_folder;
    f.chats.set_link(&id, link(), true).await.unwrap();

    let (opened, _) = f.open(&id).await;
    assert_eq!(opened.snapshot.chat.links, found);
    assert_eq!(f.core().chat(&id).unwrap().execution_folder, folder);
    assert_eq!(opened.snapshot.chat.folder.path, folder);
    // The reference block the agent is given names it (worded in the host's tests).
    let linked = f.core().chat_linked_records(&id).unwrap();
    assert_eq!(linked[0].kind, ChatLinkKind::Project);

    f.chats.set_link(&id, link(), false).await.unwrap();
    let (opened, _) = f.open(&id).await;
    assert!(opened.snapshot.chat.links.is_empty());
}

/// #368: the header names the folder's Project and branch; a list row names the
/// harness, the Project and the linked tickets.
#[tokio::test(start_paused = true)]
async fn the_branch_is_read_again_when_the_window_regains_focus() {
    let f = Fixture::new().await;
    let folder = f.dir.path().join("web-app");
    std::fs::create_dir_all(folder.join(".git")).unwrap();
    std::fs::write(folder.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let mut input = f.input("first");
    input.folder = Some(folder.to_string_lossy().into_owned());
    let id = f.chats.create(input).await.unwrap().chat_id;
    settle().await;
    let (_view, seen) = f.open(&id).await;
    // Switched outside ticketd while the window was in the background.
    f.chats.set_focused(false).await;
    std::fs::write(folder.join(".git/HEAD"), "ref: refs/heads/rate-limit\n").unwrap();
    f.chats.set_focused(true).await;
    settle().await;
    let branch = seen
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|change| change["kind"] == "chat")
        .map(|change| change["chat"]["folder"]["branch"]["name"].clone());
    assert_eq!(branch, Some(json!("rate-limit")));
}

#[tokio::test(start_paused = true)]
async fn a_chat_names_its_folders_project_and_branch_and_its_row_names_its_tickets() {
    let f = Fixture::new().await;
    let folder = f.dir.path().join("web-app");
    std::fs::create_dir_all(folder.join(".git")).unwrap();
    std::fs::write(
        folder.join(".git/HEAD"),
        "ref: refs/heads/rate-limit-logins\n",
    )
    .unwrap();
    let project = f
        .core()
        .create_project("Web App", folder.to_str().unwrap())
        .unwrap();
    let first = f.core().create_ticket("Rate-limit failed logins").unwrap();
    let second = f.core().create_ticket("Show the wait").unwrap();
    let mut input = f.input("first");
    input.folder = Some(folder.to_string_lossy().into_owned());
    input.links = [&first, &second]
        .map(|ticket| LinkRef {
            kind: LinkKind::Ticket,
            id: ticket.id.clone(),
        })
        .to_vec();
    let id = f.chats.create(input).await.unwrap().chat_id;
    settle().await;

    let (opened, _) = f.open(&id).await;
    let named = Some(ProjectRef {
        id: project.id.clone(),
        title: "Web App".to_owned(),
    });
    assert_eq!(opened.snapshot.chat.folder.project, named);
    // New Chat names the same Project for the folder before any Chat uses it.
    assert_eq!(
        f.chats.folder_project(folder.to_str().unwrap()).unwrap(),
        named
    );
    assert_eq!(
        opened.snapshot.chat.folder.branch,
        Some(BranchView {
            kind: "branch",
            name: Some("rate-limit-logins".to_owned())
        })
    );

    let rows = f.chats.list(ChatListFilter::Active).unwrap();
    let row = rows.iter().find(|row| row.id == id).unwrap();
    assert_eq!(row.harness_id, "codex");
    assert_eq!(row.project, named);
    let references: Vec<&str> = row.tickets.iter().map(|t| t.reference.as_str()).collect();
    assert_eq!(
        references,
        [first.reference.as_str(), second.reference.as_str()]
    );
    assert_eq!(row.tickets[0].status, "Todo");
}

fn failure(kind: ProblemKind) -> Problem {
    Problem {
        kind,
        message: "said by the harness".to_owned(),
        detail: None,
        resets_at: None,
    }
}

fn failed_turn(turn: &str, problem: Problem) -> EventKind {
    EventKind::TurnEnded {
        turn: NativeTurnId::new(turn),
        outcome: TurnOutcome::Failed(problem),
        submissions: Vec::new(),
    }
}

#[tokio::test(start_paused = true)]
async fn a_failure_of_the_last_turn_is_told_as_past_and_a_live_one_is_not() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    let kinds = [
        (ProblemKind::QuotaExhausted, ChatProblemKind::UsageLimit),
        (ProblemKind::LoginRequired, ChatProblemKind::NotSignedIn),
        (
            ProblemKind::PermissionUnavailable,
            ChatProblemKind::SandboxUnavailable,
        ),
        (ProblemKind::SessionInUse, ChatProblemKind::SessionInUse),
    ];
    for (turn, (kind, shown_as)) in kinds.into_iter().enumerate() {
        let turn = format!("turn-{}", turn + 1);
        f.emit(failed_turn(&turn, failure(kind))).await;
        let (opened, _) = f.open(&id).await;
        let shown = opened.snapshot.chat.problem.unwrap();
        assert_eq!((shown.kind, shown.past), (shown_as, true));
        assert!(!shown.blocks_send, "{shown_as:?}");
        // It says why the last turn stopped; it does not stop the next message.
        f.chats.send(&id, "again", SendMode::Auto).await.unwrap();
        settle().await;
        assert_eq!(f.submitted().len(), turn_number(&turn) + 1, "{shown_as:?}");
    }

    // The same kind met when the harness cannot be started is the present state.
    f.emit(failed_turn("turn-5", failure(ProblemKind::Other)))
        .await;
    f.fake.lose_process().await;
    settle().await;
    f.fake.fail_next_open(failure(ProblemKind::LoginRequired));
    f.chats.send(&id, "blocked", SendMode::Auto).await.unwrap();
    settle().await;
    let (opened, _) = f.open(&id).await;
    let shown = opened.snapshot.chat.problem.unwrap();
    assert_eq!(
        (shown.kind, shown.past),
        (ChatProblemKind::NotSignedIn, false)
    );
    assert!(shown.blocks_send);
    assert_eq!(shown.title, "Codex isn't signed in");
}

fn turn_number(turn: &str) -> usize {
    turn.trim_start_matches("turn-").parse().unwrap()
}

#[tokio::test(start_paused = true)]
async fn checking_again_after_a_past_sign_in_failure_reports_what_the_probe_finds() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    f.emit(failed_turn("turn-1", failure(ProblemKind::LoginRequired)))
        .await;
    let (_, seen) = f.open(&id).await;
    let row = |f: &Fixture| f.chats.list(ChatListFilter::Active).unwrap().remove(0);
    assert_eq!(row(&f).problem, Some(ChatProblemKind::NotSignedIn));
    assert!(
        row(&f).problem_past,
        "the row says it as the last turn's too"
    );
    assert!(!row(&f).needs_you, "a sign-in step is shown, not counted");

    // Still signed out: the check says so and the notice stays.
    let installed = |login| Inspection::Installed {
        executable: PathBuf::from("harness"),
        version: Some("1.0".to_owned()),
        login,
        capabilities: ticketd_chat_host::Capabilities {
            steering: ticketd_chat_host::Capability::Unknown {
                reason: String::new(),
            },
            native_resume: ticketd_chat_host::Capability::Unknown {
                reason: String::new(),
            },
        },
    };
    f.fake.set_inspection(installed(LoginState::SignedOut));
    assert!(f.chats.check_again(&id).await.is_err());
    // A sign-in the probe cannot see is not taken as being in order.
    f.fake.set_inspection(installed(LoginState::Unknown));
    let unseen = f.chats.check_again(&id).await.unwrap_err();
    assert!(unseen.message.contains("cannot check"), "{unseen:?}");
    let (opened, _) = f.open(&id).await;
    assert_eq!(
        opened.snapshot.chat.problem.map(|p| p.kind),
        Some(ChatProblemKind::NotSignedIn)
    );

    // Signed in now: the notice about the past turn is cleared, and what is left is
    // a Chat whose last turn Failed, already seen, so it no longer counts.
    f.fake.set_inspection(installed(LoginState::SignedIn));
    f.chats.check_again(&id).await.unwrap();
    settle().await;
    assert_eq!(seen.lock().unwrap().last().unwrap()["kind"], "resync");
    let (opened, _) = f.open(&id).await;
    assert_eq!(opened.snapshot.chat.problem, None);
    assert_eq!(opened.snapshot.chat.activity, "failed");
    assert_eq!(row(&f).problem, None);
    assert!(!row(&f).needs_you, "a seen failure is Idle");
    assert_eq!(row(&f).status.word, "Failed");
    assert_eq!(f.submitted(), ["first"], "checking sent nothing");

    // A later turn that fails the same way is told again.
    f.chats.send(&id, "again", SendMode::Auto).await.unwrap();
    settle().await;
    f.emit(failed_turn("turn-2", failure(ProblemKind::LoginRequired)))
        .await;
    let (opened, _) = f.open(&id).await;
    assert_eq!(
        opened.snapshot.chat.problem.map(|p| p.kind),
        Some(ChatProblemKind::NotSignedIn)
    );
}

#[tokio::test(start_paused = true)]
async fn a_usage_limit_shows_its_reset_time_when_the_provider_gave_one() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    let mut limit = failure(ProblemKind::QuotaExhausted);
    limit.resets_at = Some(1_730_948_100);
    f.emit(failed_turn("turn-1", limit)).await;
    let (opened, _) = f.open(&id).await;
    let shown = opened.snapshot.chat.problem.unwrap();
    assert_eq!(
        (shown.kind, shown.past),
        (ChatProblemKind::UsageLimit, true)
    );
    assert_eq!(shown.resets_at, Some(1_730_948_100));

    // Without a reset time from the provider there is none to show.
    f.chats.send(&id, "again", SendMode::Auto).await.unwrap();
    settle().await;
    f.emit(failed_turn("turn-2", failure(ProblemKind::QuotaExhausted)))
        .await;
    let (opened, _) = f.open(&id).await;
    let shown = opened.snapshot.chat.problem.unwrap();
    assert_eq!(
        (shown.kind, shown.resets_at),
        (ChatProblemKind::UsageLimit, None)
    );
}

#[tokio::test(start_paused = true)]
async fn an_unavailable_capability_is_a_notice_line_and_never_hides_why_a_turn_stopped() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    f.emit(EventKind::Notice {
        turn: Some(NativeTurnId::new("turn-1")),
        kind: NoticeKind::CapabilityUnavailable,
        message: "Codex could not start the MCP server github: exited with 1".to_owned(),
        detail: None,
    })
    .await;

    // It is a line in the conversation that names what is unavailable; it is not the
    // Chat's problem, and the Chat keeps working and is not counted.
    let (opened, _) = f.open(&id).await;
    assert!(opened.snapshot.items.iter().any(|item| matches!(
        item,
        Item::Marker { reason: "warning", message: Some(said), .. }
            if said == "Codex could not start the MCP server github: exited with 1"
    )));
    assert_eq!(opened.snapshot.chat.problem, None);
    assert_eq!(opened.snapshot.chat.activity, "working");
    assert_eq!(f.chats.overview().unwrap().needs_you, 0);

    // A usage limit that then stops the turn is still told, with its reset time.
    let mut limit = failure(ProblemKind::QuotaExhausted);
    limit.resets_at = Some(1_730_948_100);
    f.emit(failed_turn("turn-1", limit)).await;
    let (opened, _) = f.open(&id).await;
    let shown = opened.snapshot.chat.problem.unwrap();
    assert_eq!(
        (shown.kind, shown.past),
        (ChatProblemKind::UsageLimit, true)
    );
    assert_eq!(shown.resets_at, Some(1_730_948_100));

    // So is a sign-in failure, with its guidance, and it is shown, not counted.
    f.chats.send(&id, "again", SendMode::Auto).await.unwrap();
    settle().await;
    f.emit(failed_turn("turn-2", failure(ProblemKind::LoginRequired)))
        .await;
    let (opened, _) = f.open(&id).await;
    let shown = opened.snapshot.chat.problem.unwrap();
    assert_eq!(
        (shown.kind, shown.past),
        (ChatProblemKind::NotSignedIn, true)
    );
    assert!(shown.command.is_some(), "the harness's own sign-in command");
    let row = f.chats.list(ChatListFilter::Active).unwrap().remove(0);
    assert_eq!(
        (row.problem, row.needs_you),
        (Some(ChatProblemKind::NotSignedIn), false)
    );
    assert_eq!(f.chats.overview().unwrap().needs_you, 0);
}

#[tokio::test(start_paused = true)]
async fn a_refused_resend_asks_the_person_again_and_says_what_happened() {
    let f = Fixture::new().await;
    f.fake.script_submit(SubmitReply::LoseProcess);
    let id = f.chats.create(f.input("first")).await.unwrap().chat_id;
    settle().await;
    let (opened, _) = f.open(&id).await;
    let message_id = opened.snapshot.chat.problem.unwrap().message_id.unwrap();
    f.fake
        .script_submit(SubmitReply::Reject("busy elsewhere".to_owned()));

    let resend = UncertainDecision::Resend;
    f.chats
        .resolve_uncertain(&id, &message_id, resend)
        .await
        .unwrap();
    settle().await;

    let (opened, _) = f.open(&id).await;
    // The first attempt may still have arrived: the message does not read "Not sent".
    assert_eq!(user_deliveries(&opened), ["uncertain"]);
    let problem = opened.snapshot.chat.problem.unwrap();
    assert_eq!(problem.kind, ChatProblemKind::UncertainDelivery);
    assert_eq!(problem.message_id.as_deref(), Some(message_id.as_str()));
    let said = problem.message.unwrap();
    assert!(said.contains("busy elsewhere"), "{said}");
    assert!(!said.contains("queue"), "{said}");
    assert!(opened.snapshot.chat.queue.is_empty());
    assert_eq!(f.chats.overview().unwrap().needs_you, 1);

    // The person can decide again; setting it aside sends nothing more.
    let discard = UncertainDecision::Discard;
    f.chats
        .resolve_uncertain(&id, &message_id, discard)
        .await
        .unwrap();
    f.chats.resume_queue(&id).await.unwrap();
    tokio::time::sleep(Duration::from_secs(3_600)).await;
    let (opened, _) = f.open(&id).await;
    assert_eq!(user_deliveries(&opened), ["set_aside"]);
    assert_eq!(f.submitted(), ["first", "first"]);
    let said = opened.snapshot.chat.problem.and_then(|p| p.message);
    assert!(!said.unwrap_or_default().contains("back in the queue"));
}

#[tokio::test(start_paused = true)]
async fn a_backup_that_cannot_be_restored_stops_no_chat() {
    let f = Fixture::new().await;
    f.chat().await;
    let not_a_backup = f.dir.path().join("notes.txt");
    std::fs::write(&not_a_backup, "not a database").unwrap();
    // Each refusal is a sentence for a person, as the restore review words it.
    let backups = [
        (
            f.dir.path().join("missing.ticketd-backup"),
            "That backup file wasn't found.",
        ),
        (not_a_backup, "This isn't a ticketd backup."),
        (
            f.dir.path().join("workspace.sqlite3"),
            "This is the current workspace.",
        ),
    ];

    for (backup, reason) in backups {
        let refused = f
            .chats
            .restore(backup.clone(), |_| Err("replaced".to_owned()))
            .await
            .unwrap_err();

        assert_eq!(refused, reason, "{backup:?}");
        assert_eq!(f.chats.working(), 1, "{backup:?} stopped the Chat");
    }
    assert!(
        !f.fake
            .written()
            .iter()
            .any(|written| matches!(written, Written::Close(_)))
    );
}

/// What a backup lacks is more than tables (columns, triggers and unique indexes too),
/// so the refusal names it without calling it one kind of thing.
#[test]
fn an_incomplete_backup_is_refused_listing_what_it_lacks_without_calling_it_tables() {
    let reason = refusal(BackupCheck::MissingTables {
        tables: vec!["notes".to_owned(), "chat_turns.ending".to_owned()],
    });

    assert_eq!(
        reason.as_deref(),
        Some("This backup is incomplete. It is missing: notes, chat_turns.ending.")
    );
}

#[test]
fn a_restore_that_replaced_the_data_is_a_success_whatever_followed_it() {
    let safety = || Ok(PathBuf::from("/backups/safety.sqlite3"));
    let clean = restore_outcome(safety(), Ok(()), 0).unwrap();
    assert_eq!(clean.safety_path, "/backups/safety.sqlite3");
    assert_eq!(clean.warning, None);

    let unstopped = restore_outcome(safety(), Ok(()), 2).unwrap();
    assert_eq!(unstopped.safety_path, "/backups/safety.sqlite3");
    assert!(unstopped.warning.unwrap().contains("2 Chat"));

    let unchecked = restore_outcome(safety(), Err(failed("disk")), 1).unwrap();
    assert_eq!(unchecked.safety_path, "/backups/safety.sqlite3");
    let warning = unchecked.warning.unwrap();
    assert!(warning.contains("disk") && warning.contains("1 Chat"));

    // Only a restore that did not happen is a failure.
    let refused = restore_outcome(Err("not a ticketd backup".to_owned()), Ok(()), 3);
    assert_eq!(refused.unwrap_err(), "not a ticketd backup");
}

fn responses<'a>(changes: &'a [Value], item: &str) -> Vec<&'a str> {
    changes
        .iter()
        .filter(|change| {
            change["item"]["kind"] == "response"
                && change["item"]["id"]
                    .as_str()
                    .is_some_and(|id| id.ends_with(item))
        })
        .map(|change| change["item"]["state"].as_str().unwrap())
        .collect()
}

/// L1, L2: a turn that starts after the view attached streams as streaming, its
/// working line counts from its own start, and a turn that ended leaves no response
/// reading as cut off.
#[tokio::test(start_paused = true)]
async fn a_turn_started_after_the_view_attached_streams_and_times_from_its_own_start() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    let (_, seen) = f.open(&id).await;
    // A Chat change while turn-1 is active, so the view holds the Chat with that turn.
    f.chats
        .set_retention(&id, Retention::Archive)
        .await
        .unwrap();
    settle().await;
    f.emit(EventKind::TurnEnded {
        turn: turn(),
        outcome: TurnOutcome::Completed,
        submissions: Vec::new(),
    })
    .await;
    tokio::time::sleep(Duration::from_millis(20)).await;

    f.chats.send(&id, "second", SendMode::Auto).await.unwrap();
    settle().await;
    f.emit(EventKind::TextDelta {
        turn: NativeTurnId::new("turn-2"),
        item: NativeItemId::new("m2"),
        text: "Hel".to_owned(),
    })
    .await;
    // Past a checkpoint: the stored, unfinished text reaches the view as a record.
    tokio::time::sleep(Duration::from_secs(2)).await;

    let changes = seen.lock().unwrap().clone();
    let current = f.core().chat(&id).unwrap().active_turn.unwrap();
    let chat = changes.iter().rev().find(|c| c["kind"] == "chat").unwrap();
    assert_eq!(chat["chat"]["doing"]["since"], json!(current.started_at));
    let states = responses(&changes, ":m2");
    assert!(states.len() >= 2, "streamed and checkpointed: {states:?}");
    assert!(
        states.iter().all(|state| *state == "streaming"),
        "{states:?}"
    );

    // The harness ended the turn without a final text: nothing was lost, so it is
    // complete, not "Incomplete".
    f.emit(EventKind::TurnEnded {
        turn: NativeTurnId::new("turn-2"),
        outcome: TurnOutcome::Interrupted,
        submissions: Vec::new(),
    })
    .await;
    let changes = seen.lock().unwrap().clone();
    assert_eq!(responses(&changes, ":m2").last(), Some(&"complete"));
    let (opened, _) = f.open(&id).await;
    assert!(opened.snapshot.items.iter().any(|item| matches!(
        item,
        Item::Response { state: "complete", text, .. } if text == "Hel"
    )));
}

/// L3: what the agent changed in ticketd during a turn is a records row after the turn
/// and the list row's latest change.
#[tokio::test(start_paused = true)]
async fn what_the_agent_changed_in_ticketd_is_shown_after_its_turn_and_on_the_list() {
    let f = Fixture::new().await;
    let ticket = f.core().create_ticket("Reset email").unwrap();
    let id = f.chat().await;
    let (_, seen) = f.open(&id).await;
    let moved = ticketd_core::TicketPatch {
        status: Some(ticketd_core::Status::InProgress),
        editing_agent: Some("codex".into()),
        ..Default::default()
    };
    f.core().change_ticket(&ticket.reference, moved).unwrap();
    f.emit(EventKind::TurnEnded {
        turn: turn(),
        outcome: TurnOutcome::Completed,
        submissions: Vec::new(),
    })
    .await;

    let status = json!({
        "kind": "status",
        "reference": ticket.reference,
        "title": "Reset email",
        "from": "Todo",
        "to": "In progress",
    });
    let changes = seen.lock().unwrap().clone();
    let records = changes
        .iter()
        .find(|change| change["item"]["kind"] == "records")
        .expect("a records row");
    assert_eq!(records["item"]["changes"], json!([status]));
    let rows = f.chats.list(ChatListFilter::Active).unwrap();
    assert_eq!(
        serde_json::to_value(&rows[0]).unwrap()["last_change"],
        status
    );

    // Trashed since, the receipt says so instead of linking it.
    f.core().set_trashed(&ticket.reference, true, None).unwrap();
    let (opened, _) = f.open(&id).await;
    let gone = opened.snapshot.items.iter().find_map(|item| match item {
        Item::Records { gone, .. } => Some(gone.clone()),
        _ => None,
    });
    assert_eq!(gone, Some(vec![Some("trashed")]));
}

#[tokio::test(start_paused = true)]
async fn a_linked_record_in_trash_is_named_as_such() {
    let f = Fixture::new().await;
    let ticket = f.core().create_ticket("Reset email").unwrap();
    let mut input = f.input("first");
    input.links = vec![LinkRef {
        kind: LinkKind::Ticket,
        id: ticket.id.clone(),
    }];
    let id = f.chats.create(input).await.unwrap().chat_id;
    settle().await;
    f.core().set_trashed(&ticket.reference, true, None).unwrap();
    let (opened, _) = f.open(&id).await;
    assert_eq!(opened.snapshot.chat.trashed_links, [ticket.id]);
}

fn user_items(changes: &[Value]) -> Vec<(String, String)> {
    changes
        .iter()
        .filter(|change| change["kind"] == "item" && change["item"]["kind"] == "user")
        .map(|change| {
            let item = &change["item"];
            (
                item["text"].as_str().unwrap().to_owned(),
                item["delivery"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn last_queue(changes: &[Value]) -> Option<Value> {
    let chat = changes
        .iter()
        .rev()
        .find(|change| change["kind"] == "chat")?;
    Some(chat["chat"]["queue"].clone())
}

/// U15: a message sent into a failed Chat waits only for its session to open; it reads
/// as being sent, not as an item of the person's queue, and the queue stays paused.
#[tokio::test(start_paused = true)]
async fn a_message_waiting_for_its_session_to_open_reads_as_sending_not_queued() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    f.fake.lose_process().await;
    settle().await;
    f.chats.send(&id, "kept", SendMode::Queue).await.unwrap();
    settle().await;
    let (_, seen) = f.open(&id).await;

    let opening = f.fake.hold_next_open();
    f.chats.send(&id, "again", SendMode::Auto).await.unwrap();
    settle().await;

    let changes = seen.lock().unwrap().clone();
    assert_eq!(
        user_items(&changes),
        [("again".to_owned(), "sending".to_owned())]
    );
    let queue = last_queue(&changes).unwrap();
    let texts: Vec<_> = queue
        .as_array()
        .unwrap()
        .iter()
        .map(|q| q["text"].clone())
        .collect();
    assert_eq!(texts, [json!("kept")], "explicit queue items stay queued");
    let (opened, _) = f.open(&id).await;
    assert!(
        opened.snapshot.chat.queue_paused,
        "the paused queue stays paused"
    );
    assert_eq!(opened.snapshot.chat.queue.len(), 1);
    assert_eq!(user_deliveries(&opened).last(), Some(&"sending"));

    opening.send(()).unwrap();
    settle().await;
    assert_eq!(f.submitted(), ["first", "again"], "nothing else is sent");
}

/// U15: when the session does not open, the message is back in the visible queue and
/// is no longer told as being sent; nothing resends it.
#[tokio::test(start_paused = true)]
async fn a_message_whose_session_did_not_open_is_back_in_the_queue() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    f.fake.lose_process().await;
    settle().await;
    let (_, seen) = f.open(&id).await;

    let opening = f.fake.hold_next_open();
    f.fake.fail_next_open(failure(ProblemKind::Other));
    f.chats.send(&id, "again", SendMode::Auto).await.unwrap();
    settle().await;
    opening.send(()).unwrap();
    settle().await;

    assert_eq!(seen.lock().unwrap().last().unwrap()["kind"], "resync");
    let (opened, _) = f.open(&id).await;
    let texts: Vec<_> = opened
        .snapshot
        .chat
        .queue
        .iter()
        .map(|q| q.text.as_str())
        .collect();
    assert_eq!(texts, ["again"]);
    assert!(!user_deliveries(&opened).contains(&"sending"));
    tokio::time::sleep(Duration::from_secs(3_600)).await;
    assert_eq!(f.submitted(), ["first"], "nothing is resent automatically");
}

/// N4: losing the harness mid-turn is told once, by the transcript's marker ("whether
/// this turn finished is unknown"), not again by an error card claiming the turn is
/// not complete.
#[tokio::test(start_paused = true)]
async fn contact_lost_mid_turn_is_told_once() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    f.emit(EventKind::TextDelta {
        turn: turn(),
        item: NativeItemId::new("m1"),
        text: "Half an ans".to_owned(),
    })
    .await;
    f.fake.lose_process().await;
    settle().await;

    let (opened, _) = f.open(&id).await;
    let markers = opened
        .snapshot
        .items
        .iter()
        .filter(|item| matches!(item, Item::Marker { message: Some(text), .. } if text.starts_with("Contact with")))
        .count();
    assert_eq!(markers, 1);
    assert_eq!(
        opened.snapshot.chat.problem.map(|problem| problem.kind),
        None
    );
}

/// L9: a Chat's folder that goes missing, or comes back, is seen when ticketd checks
/// folders again (window focus, "Check again"): open views and the list follow from the
/// Chat change log, with nothing else having to change first.
#[tokio::test(start_paused = true)]
async fn a_folder_that_comes_back_clears_the_missing_folder_state() {
    let f = Fixture::new().await;
    let folder = f.dir.path().join("work");
    std::fs::create_dir(&folder).unwrap();
    let mut input = f.input("first");
    input.folder = Some(folder.to_string_lossy().into_owned());
    let id = f.chats.create(input).await.unwrap().chat_id;
    settle().await;
    let (_, seen) = f.open(&id).await;
    let shown = |seen: &Arc<Mutex<Vec<Value>>>| {
        let seen = seen.lock().unwrap();
        let chat = seen.iter().rev().find(|change| change["kind"] == "chat");
        chat.map(|change| change["chat"]["problem"]["kind"].clone())
    };
    // The list is fetched again when the digest moves.
    let before = f.chats.digest();

    let moved = f.dir.path().join("moved");
    std::fs::rename(&folder, &moved).unwrap();
    f.chats.recheck_folders().await.unwrap();
    settle().await;
    assert_eq!(shown(&seen), Some(json!("folder_missing")));
    // With the folder gone there is nothing to type into.
    let has_composer = seen
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|change| change["kind"] == "chat")
        .map(|change| change["chat"]["has_composer"].clone());
    assert_eq!(has_composer, Some(json!(false)));
    let missing = f.chats.digest();
    assert_ne!(missing, before);

    std::fs::rename(&moved, &folder).unwrap();
    f.chats.recheck_folders().await.unwrap();
    settle().await;
    assert_eq!(shown(&seen), Some(Value::Null));
    assert_ne!(f.chats.digest(), missing);
    // Nothing changed since: checking again logs nothing.
    let settled = f.chats.digest();
    f.chats.recheck_folders().await.unwrap();
    assert_eq!(f.chats.digest(), settled);
}

#[test]
fn an_incompatible_harness_says_what_was_found_and_needed_once() {
    let status = harness_status(
        "codex",
        "Codex",
        Inspection::Incompatible {
            executable: PathBuf::from("/opt/bin/codex"),
            version: Some("codex-cli 0.150.0".to_owned()),
            requirement: "Codex 0.163.0 or newer".to_owned(),
        },
    );
    assert_eq!(status.status, HarnessState::Incompatible);
    assert_eq!(
        status.message.as_deref(),
        Some("Found Codex 0.150.0 at `/opt/bin/codex`. ticketd needs Codex 0.163.0 or newer.")
    );
    assert_eq!(status.path.as_deref(), Some("/opt/bin/codex"));
    assert_eq!(status.version.as_deref(), Some("0.150.0"));
    assert_eq!(version_number("2.1.322 (Claude Code)"), "2.1.322");
}

/// Spec 21.3: a Chat in view never turns unread; any other one does until opened.
#[tokio::test(start_paused = true)]
async fn a_turn_that_ends_out_of_view_is_unread_until_the_chat_is_opened() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    let row = |f: &Fixture| f.chats.list(ChatListFilter::Active).unwrap().remove(0);
    assert_eq!(row(&f).status.rank, Rank::Working);
    f.emit(EventKind::TurnEnded {
        turn: turn(),
        outcome: TurnOutcome::Completed,
        submissions: Vec::new(),
    })
    .await;
    assert_eq!(row(&f).status.rank, Rank::Done);
    assert_eq!(f.chats.overview().unwrap().unread, 1);

    let (_view, _) = f.open(&id).await;
    assert_eq!(row(&f).status.rank, Rank::Idle);
    assert_eq!(f.chats.overview().unwrap().unread, 0);
    assert_eq!(f.chats.in_view(), HashSet::from([id.clone()]));

    // Mark as unread, and mute: the row keeps its words, the dot comes back.
    f.chats.mark_unread(&id).await.unwrap();
    f.chats.set_muted(&id, true).await.unwrap();
    let marked = row(&f);
    assert!(marked.status.unread() && marked.muted);

    // Another turn ends while the Chat is open and the window has focus: seen.
    f.chats.send(&id, "again", SendMode::Auto).await.unwrap();
    settle().await;
    f.emit(EventKind::TurnEnded {
        turn: NativeTurnId::new("turn-2"),
        outcome: TurnOutcome::Completed,
        submissions: Vec::new(),
    })
    .await;
    assert!(!row(&f).status.unseen);

    // The window lost focus: the open Chat is not in view.
    f.chats.set_focused(false).await;
    assert!(f.chats.in_view().is_empty());
}

#[test]
fn files_for_a_mention_are_found_by_name_in_the_folder_without_build_output_or_hidden_folders() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for path in [
        "src/auth/limiter.ts",
        "src/limits.md",
        "node_modules/x/limiter.js",
        ".git/limiter",
        "README.md",
    ] {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, "").unwrap();
    }
    let found = folder_files(root, "limit");
    let paths: Vec<_> = found.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(paths, ["src/limits.md", "src/auth/limiter.ts"]);
    assert!(!found[0].folder);
    // Nothing typed lists what is nearest the top first, folders included.
    let top = folder_files(root, "");
    assert_eq!(top[0].path, "README.md");
    assert!(top.iter().any(|file| file.path == "src" && file.folder));
}

#[tokio::test(start_paused = true)]
async fn a_ticket_lists_its_chats_and_records_mentioned_in_a_message_link_when_it_is_sent() {
    let f = Fixture::new().await;
    let ticket = f.core().create_ticket("Reset email").unwrap();
    let link = || LinkRef {
        kind: LinkKind::Ticket,
        id: ticket.id.clone(),
    };
    let id = f.chat().await;
    let other = f.chat().await;
    assert!(f.chats.linked_to(&link()).unwrap().is_empty());

    f.chats
        .send_linking(&id, "Look at it", SendMode::Queue, &[link()])
        .await
        .unwrap();
    let linked = f.chats.linked_to(&link()).unwrap();
    assert_eq!(
        linked.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        [id.as_str()]
    );
    assert_eq!(f.core().chat(&id).unwrap().links.len(), 1);
    assert!(f.core().chat(&other).unwrap().links.is_empty());

    // A record that cannot be linked refuses the message before anything is queued.
    let gone = LinkRef {
        kind: LinkKind::Document,
        id: "no-such-document".to_owned(),
    };
    let refused = f
        .chats
        .send_linking(&other, "And this", SendMode::Queue, &[gone])
        .await;
    assert!(refused.is_err());
    let (opened, _) = f.open(&other).await;
    assert!(opened.snapshot.chat.queue.is_empty());

    // A trashed Chat is never listed on the ticket.
    f.chats.set_retention(&id, Retention::Trash).await.unwrap();
    assert!(f.chats.linked_to(&link()).unwrap().is_empty());
}

#[test]
fn a_program_or_script_is_shown_in_its_folder_instead_of_run() {
    let dir = tempfile::tempdir().unwrap();
    let file = |name: &str| {
        let path = dir.path().join(name);
        std::fs::write(&path, "echo hi").unwrap();
        path
    };
    assert!(!runs_when_opened(&file("limiter.ts")));
    assert!(!runs_when_opened(&file("notes.md")));
    assert!(runs_when_opened(&file("deploy.command")));
    assert!(runs_when_opened(&file("setup.sh")));
    assert!(runs_when_opened(&file("install.BAT")));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let check = file("check");
        std::fs::set_permissions(&check, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(runs_when_opened(&check));
    }
}

#[test]
fn a_file_opens_only_inside_the_chat_folder() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("work");
    std::fs::create_dir_all(folder.join("src")).unwrap();
    std::fs::write(folder.join("src/limiter.ts"), "").unwrap();
    std::fs::write(dir.path().join("secret.txt"), "").unwrap();
    let code = |path: &str| file_in(&folder, path).unwrap_err().code;
    // A step names it relative to the folder; a changed-files row, absolutely.
    assert!(file_in(&folder, "src/limiter.ts").is_ok());
    let absolute = folder.join("src/limiter.ts");
    assert!(file_in(&folder, &absolute.to_string_lossy()).is_ok());
    // No longer there.
    let gone = file_in(&folder, "src/gone.ts").unwrap_err();
    assert_eq!(gone.code, "gone");
    assert_eq!(gone.message, "gone.ts is no longer in this folder.");
    assert_eq!(code(&folder.join("src/gone.ts").to_string_lossy()), "gone");
    // Out of the folder, as written or through a link.
    assert_eq!(code("../secret.txt"), "failed");
    assert_eq!(code("../missing.txt"), "failed");
    assert_eq!(code("/etc/hosts"), "failed");
    assert_eq!(
        code(&dir.path().join("secret.txt").to_string_lossy()),
        "failed"
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), folder.join("link.txt")).unwrap();
        assert_eq!(code("link.txt"), "failed");
    }
}
