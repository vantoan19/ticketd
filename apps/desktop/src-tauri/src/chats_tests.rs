//! The Chat service as the bridge commands use it, with the fake adapter as the harness
//! and a temporary workspace behind the real core. No window and no real harness.
#![allow(clippy::unwrap_used, clippy::panic)] // test setup and assertions

use std::time::Duration;

use serde_json::json;
use ticketd_chat_host::testing::{FakeAdapter, SubmitReply, Written};
use ticketd_chat_host::{
    ApprovalDecision, EventKind, InteractionRequest, NativeItemId, NativeRequestId,
    NativeSessionId, NativeTurnId,
};

use super::*;

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
        let fake = FakeAdapter::codex();
        let chats = Chats::new(
            Arc::new(move || Workspace::open(&path)),
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
            harness_id: "codex".to_owned(),
            folder: Some(self.dir.path().to_string_lossy().into_owned()),
            links: Vec::new(),
            message: message.to_owned(),
        }
    }

    /// A Chat whose first message was acknowledged and started `turn-1`.
    async fn chat(&self) -> String {
        let id = self.chats.create(self.input("first")).await.unwrap();
        settle().await;
        id
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
        close_action(f.chats.enabled(), f.chats.working()),
        CloseAction::Exit
    );

    f.chats.set_enabled(true).await;
    f.chat().await;
    assert_eq!(f.chats.working(), 1);
    assert_eq!(f.chats.overview().unwrap().working, 1);
    assert_eq!(
        close_action(f.chats.enabled(), f.chats.working()),
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

#[test]
fn closing_keeps_chats_running_only_when_some_are_working_and_quit_asks_before_stopping_them() {
    assert_eq!(close_action(false, 0), CloseAction::Exit);
    assert_eq!(close_action(true, 0), CloseAction::Exit);
    assert_eq!(close_action(true, 2), CloseAction::KeepRunning);
    assert_eq!(quit_action(0, false), QuitAction::Quit);
    assert_eq!(quit_action(2, false), QuitAction::Confirm(2));
    assert_eq!(quit_action(2, true), QuitAction::Quit);
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

    let id = f.chats.create(input).await.unwrap();

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

    let unknown_field = json!({ "harness_id": "codex", "folder": null, "links": [], "message": "m", "shell": "rm" });
    assert!(serde_json::from_value::<NewChatInput>(unknown_field).is_err());
    assert!(serde_json::from_value::<LinkRef>(json!({ "kind": "project", "id": "p" })).is_err());
    assert!(serde_json::from_value::<Answer>(json!({ "option_id": 1 })).is_err());
    assert!(serde_json::from_value::<HistorySelection>(json!({ "kind": "everything" })).is_err());

    let statuses = f.chats.harnesses().await.unwrap();
    let status = |id: &str| statuses.iter().find(|s| s.id == id).unwrap().status;
    assert_eq!(status("claude-code"), "incompatible");
    assert_ne!(status("codex"), "incompatible");
}

#[tokio::test(start_paused = true)]
async fn a_view_follows_numbered_changes_in_ticketd_terms_and_answers_only_live_requests() {
    let f = Fixture::new().await;
    let id = f.chat().await;
    let (opened, seen) = f.open(&id).await;
    assert_eq!(opened.snapshot.cursor, 0);
    assert_eq!(opened.snapshot.chat.activity, "working");
    assert!(matches!(
        opened.snapshot.items.as_slice(),
        [Item::User { delivery: "delivered", text, .. }] if text == "first"
    ));

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
        kind: InteractionKind::Approval {
            description: "Run cargo test".to_owned(),
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
    assert_eq!(
        opened.snapshot.items.len(),
        1,
        "queued input is not history"
    );

    f.chats.remove_queued(&id, &queued.id).await.unwrap();
    settle().await;

    assert!(f.core().chat_queue(&id).unwrap().is_empty());
    assert_eq!(seen.lock().unwrap().last().unwrap()["kind"], "resync");
    assert!(f.chats.remove_queued(&id, &queued.id).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn an_uncertain_submission_waits_for_the_person_and_is_resent_only_when_they_say_so() {
    let f = Fixture::new().await;
    f.fake.script_submit(SubmitReply::LoseProcess);
    let id = f.chats.create(f.input("first")).await.unwrap();
    settle().await;
    let (opened, _) = f.open(&id).await;
    let problem = opened.snapshot.chat.problem.unwrap();
    assert_eq!(problem.kind, "uncertain_delivery");
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
