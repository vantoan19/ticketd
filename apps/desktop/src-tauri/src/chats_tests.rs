//! The Chat service as the bridge commands use it, with the fake adapter as the harness
//! and a temporary workspace behind the real core. No window and no real harness.
#![allow(clippy::unwrap_used, clippy::panic)] // test setup and assertions

use std::time::Duration;

use serde_json::json;
use ticketd_chat_host::testing::{FakeAdapter, SubmitReply, Written};
use ticketd_chat_host::{
    ApprovalDecision, DeliveryEvidence, EventKind, InteractionRequest, NativeItemId,
    NativeRequestId, NativeSessionId, NativeTurnId, NoticeKind, Problem, ProblemKind,
    ProviderDetail, TurnOutcome,
};
use ticketd_core::{ChatDelivery, ChatSubmissionIntent};

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
            command_id: uuid::Uuid::new_v4().to_string(),
            harness_id: "codex".to_owned(),
            folder: Some(self.dir.path().to_string_lossy().into_owned()),
            links: Vec::new(),
            message: message.to_owned(),
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

#[test]
fn the_tray_says_what_the_hidden_chats_are_doing_now() {
    let tooltip = |working, needs_you| tray_tooltip(&Overview { needs_you, working });
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
    let id = f.chats.create(f.input("first")).await.unwrap().chat_id;
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
    assert_ne!(problem, Some("uncertain_delivery"));
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
    assert_eq!(opened.snapshot.chat.problem.map(|p| p.kind), Some("failed"));
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
        "uncertain_delivery"
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

    let (opened, _) = f.open(&id).await;
    let shown = opened.snapshot.chat.problem.unwrap();
    assert_eq!(shown.kind, "usage_limit");
    assert_eq!(shown.message.as_deref(), Some("said by the harness"));
    assert!(opened.snapshot.items.iter().any(|item| matches!(
        item,
        Item::Marker { reason: "note", message: Some(text), .. } if text == "Reconnecting (2/5)"
    )));
    let permissions = opened.snapshot.chat.harness.permissions.unwrap();
    assert!(permissions.contains("model m-1") && permissions.contains("permission mode default"));
    assert_eq!(f.chats.overview().unwrap().needs_you, 1);

    // A sign-in failure in the middle of a turn is a setup step: shown, not counted.
    f.chats.send(&id, "again", SendMode::Auto).await.unwrap();
    settle().await;
    f.emit(EventKind::TurnEnded {
        turn: NativeTurnId::new("turn-2"),
        outcome: TurnOutcome::Failed(problem(ProblemKind::LoginRequired)),
        submissions: Vec::new(),
    })
    .await;
    let (opened, _) = f.open(&id).await;
    let shown = opened.snapshot.chat.problem.unwrap();
    assert_eq!(shown.kind, "not_signed_in");
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

    assert_eq!(status(LoginState::SignedIn).status, "ready");
    let api_key = status(LoginState::NonSubscription);
    assert_eq!(api_key.status, "not_subscription");
    assert!(api_key.message.unwrap().contains("not a subscription"));
    let unknown = status(LoginState::Unknown);
    assert_eq!(unknown.status, "sign_in_unknown");
    assert!(unknown.message.unwrap().contains("cannot check"));
    let signed_out = status(LoginState::SignedOut);
    assert_eq!(signed_out.status, "not_signed_in");
    assert_eq!(signed_out.command.as_deref(), Some("claude /login"));

    // Neither blocks a Chat; both are told before the first message.
    f.fake.set_inspection(Inspection::NotInstalled);
    let listed = f.chats.harnesses().await.unwrap();
    let codex = listed.iter().find(|status| status.id == "codex").unwrap();
    assert_eq!(codex.status, "not_installed");
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
    let (_, before) = f.chats.overview_digest().unwrap();
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
    let (opened, _) = f.open(&other).await;
    assert_eq!(opened.snapshot.chat.folder.shared_with, ["first"]);
    let (opened, _) = f.open(&id).await;
    assert_eq!(opened.snapshot.chat.folder.shared_with, ["second"]);
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
        (ProblemKind::QuotaExhausted, "usage_limit"),
        (ProblemKind::LoginRequired, "not_signed_in"),
        (ProblemKind::PermissionUnavailable, "sandbox_unavailable"),
        (ProblemKind::SessionInUse, "session_in_use"),
    ];
    for (turn, (kind, shown_as)) in kinds.into_iter().enumerate() {
        let turn = format!("turn-{}", turn + 1);
        f.emit(failed_turn(&turn, failure(kind))).await;
        let (opened, _) = f.open(&id).await;
        let shown = opened.snapshot.chat.problem.unwrap();
        assert_eq!((shown.kind, shown.past), (shown_as, true));
        // It says why the last turn stopped; it does not stop the next message.
        f.chats.send(&id, "again", SendMode::Auto).await.unwrap();
        settle().await;
        assert_eq!(f.submitted().len(), turn_number(&turn) + 1, "{shown_as}");
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
    assert_eq!((shown.kind, shown.past), ("not_signed_in", false));
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
    assert_eq!(row(&f).problem, Some("not_signed_in"));
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
        Some("not_signed_in")
    );

    // Signed in now: the notice about the past turn is cleared, and what is left is
    // a Chat whose last turn Failed, which counts.
    f.fake.set_inspection(installed(LoginState::SignedIn));
    f.chats.check_again(&id).await.unwrap();
    settle().await;
    assert_eq!(seen.lock().unwrap().last().unwrap()["kind"], "resync");
    let (opened, _) = f.open(&id).await;
    assert_eq!(opened.snapshot.chat.problem, None);
    assert_eq!(opened.snapshot.chat.activity, "failed");
    assert_eq!(row(&f).problem, None);
    assert!(row(&f).needs_you, "a Failed Chat counts");
    assert_eq!(f.submitted(), ["first"], "checking sent nothing");

    // A later turn that fails the same way is told again.
    f.chats.send(&id, "again", SendMode::Auto).await.unwrap();
    settle().await;
    f.emit(failed_turn("turn-2", failure(ProblemKind::LoginRequired)))
        .await;
    let (opened, _) = f.open(&id).await;
    assert_eq!(
        opened.snapshot.chat.problem.map(|p| p.kind),
        Some("not_signed_in")
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
    assert_eq!((shown.kind, shown.past), ("usage_limit", true));
    assert_eq!(shown.resets_at, Some(1_730_948_100));

    // Without a reset time from the provider there is none to show.
    f.chats.send(&id, "again", SendMode::Auto).await.unwrap();
    settle().await;
    f.emit(failed_turn("turn-2", failure(ProblemKind::QuotaExhausted)))
        .await;
    let (opened, _) = f.open(&id).await;
    let shown = opened.snapshot.chat.problem.unwrap();
    assert_eq!((shown.kind, shown.resets_at), ("usage_limit", None));
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
        Item::Marker { reason: "note", message: Some(said), .. }
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
    assert_eq!((shown.kind, shown.past), ("usage_limit", true));
    assert_eq!(shown.resets_at, Some(1_730_948_100));

    // So is a sign-in failure, with its guidance, and it is shown, not counted.
    f.chats.send(&id, "again", SendMode::Auto).await.unwrap();
    settle().await;
    f.emit(failed_turn("turn-2", failure(ProblemKind::LoginRequired)))
        .await;
    let (opened, _) = f.open(&id).await;
    let shown = opened.snapshot.chat.problem.unwrap();
    assert_eq!((shown.kind, shown.past), ("not_signed_in", true));
    assert!(shown.command.is_some(), "the harness's own sign-in command");
    let row = f.chats.list(ChatListFilter::Active).unwrap().remove(0);
    assert_eq!((row.problem, row.needs_you), (Some("not_signed_in"), false));
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
    assert_eq!(problem.kind, "uncertain_delivery");
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
