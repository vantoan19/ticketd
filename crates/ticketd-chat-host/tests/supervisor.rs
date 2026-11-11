//! The Chat supervisor through its host interface, with the fake adapter as the harness
//! and a temporary SQLite workspace behind the real core. The clock is paused: time
//! moves only when every task is waiting, so `settle` means "until nothing more happens".
#![allow(clippy::unwrap_used, clippy::panic)] // test setup and assertions

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ticketd_chat_host::testing::{FakeAdapter, SubmitReply, Written};
use ticketd_chat_host::{
    Activity, ApprovalDecision, CONTEXT_RECORD_NAME, Capabilities, Capability, ChatHost,
    ChatProblem, ChatUpdate, CloseOutcome, DeliveryEvidence, EventKind, Harness, HarnessAdapter,
    HostError, INTERRUPT_TIMEOUT, InteractionAnswer, InteractionKind, InteractionRequest,
    NativeItemId, NativeRequestId, NativeSessionId, NativeTurnId, Problem, ProblemKind, ResumeMode,
    RuntimeGeneration, SUBSCRIBER_BACKLOG_ITEMS, SendMode, SessionStart, StopState, Submission,
    SubmissionId, SubmissionKind, Subscription, TEXT_CHECKPOINT_INTERVAL, TEXT_UPDATE_INTERVAL,
    ToolStatus, TurnOutcome, UnconfirmedCleanup, WorkspaceOpener,
};
use ticketd_core::{
    Chat, ChatDelivery, ChatInteractionState, ChatItem, ChatMessage, ChatRecord, ChatRole,
    ChatSessionOrigin, ChatSubmissionIntent, ChatTurn, ChatTurnState, Error, NewChat, Workspace,
};

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    storage_up: Arc<AtomicBool>,
    fake: FakeAdapter,
    host: ChatHost,
    chat: Chat,
}

fn new_chat(workspace: &mut Workspace, harness: &str) -> Chat {
    workspace
        .create_chat(
            None,
            NewChat {
                title: None,
                harness: harness.to_owned(),
                execution_folder: "/work/app".to_owned(),
                folder_managed: false,
                links: Vec::new(),
            },
        )
        .unwrap()
}

impl Fixture {
    fn new(fake: FakeAdapter) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite3");
        let chat = new_chat(&mut Workspace::open(&path).unwrap(), "codex");
        let storage_up = Arc::new(AtomicBool::new(true));
        let host = start_host(&path, &storage_up, &fake);
        Self {
            _dir: dir,
            path,
            storage_up,
            fake,
            host,
            chat,
        }
    }

    fn core(&self) -> Workspace {
        Workspace::open(&self.path).unwrap()
    }

    fn items(&self) -> Vec<ChatItem> {
        self.core()
            .chat_snapshot(&self.chat.id, 5_000)
            .unwrap()
            .items
    }

    fn message(&self, id: &str) -> ChatMessage {
        self.items()
            .into_iter()
            .find_map(|item| match item {
                ChatItem::Message(message) if message.id == id => Some(message),
                _ => None,
            })
            .unwrap()
    }

    fn turns(&self) -> Vec<ChatTurn> {
        self.items()
            .into_iter()
            .filter_map(|item| match item {
                ChatItem::Turn(turn) => Some(turn),
                _ => None,
            })
            .collect()
    }

    fn queued(&self) -> Vec<String> {
        let queue = self.core().chat_queue(&self.chat.id).unwrap();
        queue.into_iter().map(|message| message.text).collect()
    }

    fn submits(&self) -> Vec<Submission> {
        self.fake
            .written()
            .into_iter()
            .filter_map(|written| match written {
                Written::Submit(submission) => Some(submission),
                _ => None,
            })
            .collect()
    }

    async fn send(&self, text: &str) -> ChatMessage {
        let message = self.host.send(&self.chat.id, None, text, SendMode::Auto);
        let message = message.await.unwrap();
        settle().await;
        message
    }

    async fn queue(&self, text: &str) -> ChatMessage {
        let message = self.host.send(&self.chat.id, None, text, SendMode::Queue);
        let message = message.await.unwrap();
        settle().await;
        message
    }

    async fn emit(&self, kind: EventKind) {
        assert!(self.fake.emit(kind).await);
        settle().await;
    }

    async fn live(&self) -> ticketd_chat_host::ChatLive {
        self.host.attach(&self.chat.id).await.unwrap().0.live
    }

    async fn request_approval(&self) -> String {
        self.emit(EventKind::InteractionRequested(InteractionRequest {
            request: NativeRequestId::new("approval-1"),
            turn: None,
            kind: InteractionKind::Approval {
                description: "Run cargo test".to_owned(),
                decisions: vec![ApprovalDecision::Allow, ApprovalDecision::Deny],
            },
            detail: None,
        }))
        .await;
        let live = self.live().await;
        assert_eq!(live.activity, Activity::WaitingForYou);
        live.interactions[0].interaction_id.clone()
    }
}

fn start_host(
    path: &std::path::Path,
    storage_up: &Arc<AtomicBool>,
    fake: &FakeAdapter,
) -> ChatHost {
    let (path, storage_up) = (path.to_owned(), storage_up.clone());
    let opener: WorkspaceOpener = Arc::new(move || {
        if storage_up.load(Ordering::SeqCst) {
            Workspace::open(&path)
        } else {
            Err(Error::NoDataDirectory)
        }
    });
    ChatHost::new(
        opener,
        vec![Arc::new(fake.clone()) as Arc<dyn HarnessAdapter>],
    )
    .unwrap()
}

/// Lets every task run until all of them wait.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

async fn drain(subscription: &mut Subscription) -> Vec<ChatUpdate> {
    let mut updates = Vec::new();
    while let Ok(Some(update)) =
        tokio::time::timeout(Duration::from_millis(1), subscription.next()).await
    {
        updates.push(update);
    }
    updates
}

fn turn_1() -> NativeTurnId {
    NativeTurnId::new("turn-1")
}

fn turn_ended(turn: NativeTurnId, outcome: TurnOutcome) -> EventKind {
    EventKind::TurnEnded {
        turn,
        outcome,
        submissions: Vec::new(),
    }
}

fn text_delta(text: &str) -> EventKind {
    EventKind::TextDelta {
        turn: turn_1(),
        item: NativeItemId::new("message-1"),
        text: text.to_owned(),
    }
}

fn approve(decision: ApprovalDecision) -> InteractionAnswer {
    InteractionAnswer::Approval(decision)
}

#[tokio::test(start_paused = true)]
async fn input_is_recorded_as_possibly_submitted_before_the_write_and_acknowledged_after() {
    let f = Fixture::new(FakeAdapter::codex());
    let reply = f.fake.hold_next_submit();

    let input = f.send("hello").await;

    let attempt = f.message(&input.id).attempts[0].clone();
    assert_eq!(attempt.delivery, ChatDelivery::Possible);
    assert_eq!(f.submits()[0].submission, SubmissionId(attempt.id.clone()));
    assert_eq!(f.submits()[0].text, "hello");

    reply.send(SubmitReply::Acknowledge).unwrap();
    settle().await;

    let attempt = f.message(&input.id).attempts[0].clone();
    let turn = f.core().chat(&f.chat.id).unwrap().active_turn.unwrap();
    assert_eq!(attempt.delivery, ChatDelivery::Acknowledged);
    assert_eq!(attempt.turn_id, Some(turn.id));
    assert_eq!(turn.native_turn_id.as_deref(), Some("turn-1"));
}

#[tokio::test(start_paused = true)]
async fn process_loss_after_the_write_leaves_the_attempt_uncertain_and_nothing_is_resent() {
    let f = Fixture::new(FakeAdapter::codex());
    let reply = f.fake.hold_next_submit();
    let input = f.send("hello").await;
    f.queue("next").await;

    f.fake.lose_process().await;
    settle().await;
    reply.send(SubmitReply::Acknowledge).unwrap();
    tokio::time::sleep(Duration::from_secs(3_600)).await;

    assert_eq!(
        f.message(&input.id).attempts[0].delivery,
        ChatDelivery::Uncertain
    );
    assert_eq!(f.submits().len(), 1);
    assert_eq!(f.fake.opens().len(), 1);
    assert_eq!(f.queued(), ["next"]);
    assert!(f.core().chat(&f.chat.id).unwrap().queue_paused);
    assert!(matches!(
        f.live().await.problem,
        Some(ChatProblem::RuntimeLost { .. })
    ));
}

#[tokio::test(start_paused = true)]
async fn a_crash_between_recording_and_writing_is_uncertain_after_restart_and_not_sent() {
    let f = Fixture::new(FakeAdapter::codex());
    let mut core = f.core();
    let input = core.save_chat_input(None, &f.chat.id, "hello").unwrap();
    core.record_chat_submission(&f.chat.id, &input.id, "a1", ChatSubmissionIntent::NewTurn)
        .unwrap();
    core.save_chat_input(None, &f.chat.id, "queued before the crash")
        .unwrap();
    drop(core);

    let restarted = start_host(&f.path, &f.storage_up, &f.fake);
    let (view, _subscription) = restarted.attach(&f.chat.id).await.unwrap();
    tokio::time::sleep(Duration::from_secs(3_600)).await;

    assert_eq!(view.live.activity, Activity::Idle);
    assert_eq!(
        f.message(&input.id).attempts[0].delivery,
        ChatDelivery::Uncertain
    );
    assert_eq!(f.queued(), ["queued before the crash"]);
    assert_eq!(f.fake.opens(), vec![]);
    assert_eq!(f.fake.written(), vec![]);
}

#[tokio::test(start_paused = true)]
async fn a_late_acknowledgment_settles_the_same_attempt_and_the_queue_then_continues() {
    let f = Fixture::new(FakeAdapter::codex());
    f.fake.script_submit(SubmitReply::Timeout);
    let input = f.send("first").await;
    f.queue("second").await;
    tokio::time::sleep(Duration::from_secs(60)).await;

    let attempt = f.message(&input.id).attempts[0].clone();
    assert_eq!(attempt.delivery, ChatDelivery::Possible);
    assert!(f.live().await.delivery_unconfirmed);
    assert_eq!(f.submits().len(), 1);

    let late = NativeTurnId::new("turn-late");
    f.emit(EventKind::SubmissionEvidence {
        submission: SubmissionId(attempt.id),
        evidence: DeliveryEvidence::Acknowledged { turn: late.clone() },
    })
    .await;
    let attempts = f.message(&input.id).attempts;
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].delivery, ChatDelivery::Acknowledged);
    assert!(attempts[0].turn_id.is_some());

    f.emit(turn_ended(late, TurnOutcome::Completed)).await;
    let submits = f.submits();
    assert_eq!(submits.len(), 2);
    assert_eq!(submits[1].text, "second");
    assert_eq!(submits[1].kind, SubmissionKind::StartTurn);
}

#[tokio::test(start_paused = true)]
async fn sending_during_a_turn_steers_it_when_the_harness_supports_steering() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    assert!(f.live().await.steering.is_some());

    let steer = f.send("also this").await;

    assert_eq!(
        f.submits()[1].kind,
        SubmissionKind::Steer {
            expected_turn: turn_1()
        }
    );
    let attempt = f.message(&steer.id).attempts[0].clone();
    assert_eq!(attempt.intent, ChatSubmissionIntent::Steer);
    assert_eq!(attempt.delivery, ChatDelivery::Acknowledged);
    assert_eq!(f.turns().len(), 1);
    assert_eq!(attempt.turn_id, Some(f.turns()[0].id.clone()));
}

#[tokio::test(start_paused = true)]
async fn a_steer_refused_after_the_turn_ended_falls_back_to_the_queue_and_runs_next() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    let reply = f.fake.hold_next_submit();
    let steer = f.send("also this").await;

    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    reply
        .send(SubmitReply::Reject("the turn already completed".to_owned()))
        .unwrap();
    settle().await;

    let attempts = f.message(&steer.id).attempts;
    assert_eq!(attempts[0].delivery, ChatDelivery::Rejected);
    assert_eq!(attempts[1].intent, ChatSubmissionIntent::NewTurn);
    assert_eq!(attempts[1].delivery, ChatDelivery::Acknowledged);
    assert_eq!(f.submits()[2].kind, SubmissionKind::StartTurn);
    assert_eq!(f.live().await.problem, None);
}

#[tokio::test(start_paused = true)]
async fn without_steering_a_send_during_a_turn_waits_in_the_visible_queue() {
    let f = Fixture::new(FakeAdapter::without_steering());
    f.send("first").await;
    assert_eq!(f.live().await.steering, None);

    f.send("second").await;
    assert_eq!(f.submits().len(), 1);
    assert_eq!(f.queued(), ["second"]);

    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    assert_eq!(f.submits()[1].kind, SubmissionKind::StartTurn);
    assert_eq!(f.submits()[1].text, "second");
}

#[tokio::test(start_paused = true)]
async fn stop_during_a_pending_submission_interrupts_its_turn_and_keeps_unsent_input() {
    let f = Fixture::new(FakeAdapter::codex());
    let reply = f.fake.hold_next_submit();
    f.send("first").await;
    f.queue("later").await;

    f.host.stop(&f.chat.id).await.unwrap();
    settle().await;
    assert_eq!(f.fake.written().len(), 1, "nothing to interrupt yet");

    reply.send(SubmitReply::Acknowledge).unwrap();
    settle().await;
    assert!(matches!(
        f.fake.written().last(),
        Some(Written::Interrupt(request)) if request.expected_turn == turn_1()
    ));

    f.emit(turn_ended(turn_1(), TurnOutcome::Interrupted)).await;
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(f.turns()[0].state, ChatTurnState::Interrupted);
    assert_eq!(f.live().await.stop, None);
    assert_eq!(f.queued(), ["later"]);
    assert_eq!(f.submits().len(), 1);

    f.host.resume_queue(&f.chat.id).await.unwrap();
    settle().await;
    assert_eq!(f.submits()[1].text, "later");
}

#[tokio::test(start_paused = true)]
async fn a_stop_the_harness_never_confirms_is_reported_as_unconfirmed() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;

    f.host.stop(&f.chat.id).await.unwrap();
    settle().await;
    assert_eq!(f.live().await.stop, Some(StopState::Acknowledged));

    tokio::time::sleep(INTERRUPT_TIMEOUT).await;
    assert_eq!(f.live().await.stop, Some(StopState::Unconfirmed));
    assert_eq!(f.turns()[0].state, ChatTurnState::Active);
}

#[tokio::test(start_paused = true)]
async fn only_the_first_of_two_answers_reaches_the_harness() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    let interaction = f.request_approval().await;

    let (first, second) = tokio::join!(
        f.host
            .respond(&f.chat.id, &interaction, approve(ApprovalDecision::Deny)),
        f.host
            .respond(&f.chat.id, &interaction, approve(ApprovalDecision::Allow)),
    );

    assert!(first.is_ok());
    assert!(matches!(second, Err(HostError::InteractionExpired)));
    let responses: Vec<_> = f
        .fake
        .written()
        .into_iter()
        .filter_map(|written| match written {
            Written::Respond(response) => Some(response.answer),
            _ => None,
        })
        .collect();
    assert_eq!(responses, [approve(ApprovalDecision::Deny)]);
    let stored = f.items().into_iter().find_map(|item| match item {
        ChatItem::Interaction(interaction) => Some(interaction),
        _ => None,
    });
    let stored = stored.unwrap();
    assert_eq!(stored.state, ChatInteractionState::Answered);
    assert_eq!(stored.response.as_deref(), Some("deny"));
    assert_eq!(f.live().await.interactions, vec![]);
}

#[tokio::test(start_paused = true)]
async fn an_approval_and_a_stop_from_before_a_replacement_runtime_cannot_reach_it() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(EventKind::SessionIdentified {
        native_session: NativeSessionId::new("native-1"),
    })
    .await;
    let interaction = f.request_approval().await;
    f.fake.lose_process().await;
    settle().await;

    f.host.resume(&f.chat.id, ResumeMode::Native).await.unwrap();
    let reopened = f.fake.opens()[1].clone();
    assert_eq!(reopened.generation, RuntimeGeneration(2));
    assert_eq!(
        reopened.session,
        SessionStart::Resume(NativeSessionId::new("native-1"))
    );

    let answer = f
        .host
        .respond(&f.chat.id, &interaction, approve(ApprovalDecision::Allow));
    assert!(matches!(answer.await, Err(HostError::InteractionExpired)));
    f.host.stop(&f.chat.id).await.unwrap();
    settle().await;

    assert_eq!(f.fake.written().len(), 1, "only the first submission");
    assert!(f.items().iter().any(|item| matches!(
        item,
        ChatItem::Interaction(stored) if stored.state == ChatInteractionState::Expired
    )));
    assert_eq!(f.turns()[0].state, ChatTurnState::Unknown);
}

#[tokio::test(start_paused = true)]
async fn provider_requests_are_handled_and_answered_while_a_submission_is_pending() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    let reply = f.fake.hold_next_submit();
    let steer = f.send("also this").await;

    let interaction = f.request_approval().await;
    f.emit(text_delta("Working on it")).await;
    let answer = f
        .host
        .respond(&f.chat.id, &interaction, approve(ApprovalDecision::Allow));
    answer.await.unwrap();

    assert_eq!(
        f.message(&steer.id).attempts[0].delivery,
        ChatDelivery::Possible
    );
    reply.send(SubmitReply::Acknowledge).unwrap();
    settle().await;
    assert_eq!(
        f.message(&steer.id).attempts[0].delivery,
        ChatDelivery::Acknowledged
    );
}

#[tokio::test(start_paused = true)]
async fn streamed_text_is_coalesced_checkpointed_and_flushed_before_a_request() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    let (_, mut subscription) = f.host.attach(&f.chat.id).await.unwrap();
    let texts = |updates: &[ChatUpdate]| -> Vec<String> {
        updates
            .iter()
            .filter_map(|update| match update {
                ChatUpdate::Text { delta, .. } => Some(delta.clone()),
                _ => None,
            })
            .collect()
    };
    let assistant = |f: &Fixture| {
        f.items().into_iter().find_map(|item| match item {
            ChatItem::Message(message) if message.role == ChatRole::Assistant => Some(message),
            _ => None,
        })
    };

    for part in ["Hel", "lo ", "there"] {
        f.emit(text_delta(part)).await;
    }
    assert_eq!(texts(&drain(&mut subscription).await), Vec::<String>::new());

    tokio::time::sleep(TEXT_UPDATE_INTERVAL).await;
    assert_eq!(texts(&drain(&mut subscription).await), ["Hello there"]);
    assert_eq!(assistant(&f), None);

    tokio::time::sleep(TEXT_CHECKPOINT_INTERVAL).await;
    let saved = assistant(&f).unwrap();
    assert_eq!(
        (saved.text.as_str(), saved.complete),
        ("Hello there", false)
    );
    drain(&mut subscription).await;

    assert!(f.fake.emit(text_delta("!")).await);
    f.request_approval().await;
    let updates = drain(&mut subscription).await;
    let text_at = updates
        .iter()
        .position(|update| matches!(update, ChatUpdate::Text { delta, .. } if delta == "!"));
    let request_at = updates.iter().position(|update| match update {
        ChatUpdate::Changes(changes) => changes
            .iter()
            .any(|change| matches!(change.record, ChatRecord::Item(ChatItem::Interaction(_)))),
        _ => false,
    });
    assert!(text_at.unwrap() < request_at.unwrap());
    assert_eq!(assistant(&f).unwrap().text, "Hello there!");

    f.emit(EventKind::MessageCompleted {
        turn: turn_1(),
        item: NativeItemId::new("message-1"),
        text: "Hello there! Done.".to_owned(),
    })
    .await;
    let done = assistant(&f).unwrap();
    assert_eq!(
        (done.text.as_str(), done.complete),
        ("Hello there! Done.", true)
    );
}

#[tokio::test(start_paused = true)]
async fn a_view_that_falls_behind_is_told_to_resync_while_work_continues() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    let (_, mut slow) = f.host.attach(&f.chat.id).await.unwrap();

    for tool in 0..=SUBSCRIBER_BACKLOG_ITEMS {
        let update = EventKind::ToolUpdated {
            turn: turn_1(),
            item: NativeItemId::new(format!("tool-{tool}")),
            title: "cargo test".to_owned(),
            status: ToolStatus::Succeeded,
            output: None,
            detail: None,
        };
        assert!(f.fake.emit(update).await);
    }
    settle().await;

    assert_eq!(slow.next().await, Some(ChatUpdate::Resync));
    assert_eq!(slow.next().await, None);
    let (view, _fresh) = f.host.attach(&f.chat.id).await.unwrap();
    assert!(view.snapshot.earlier);
    assert!(view.live.running);
    let tools = f
        .items()
        .into_iter()
        .filter(|item| matches!(item, ChatItem::Tool(_)));
    assert_eq!(tools.count(), SUBSCRIBER_BACKLOG_ITEMS + 1);
}

#[tokio::test(start_paused = true)]
async fn detaching_a_view_does_not_stop_the_turn_and_reattaching_starts_nothing() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    let (_, subscription) = f.host.attach(&f.chat.id).await.unwrap();
    drop(subscription);

    f.emit(EventKind::MessageCompleted {
        turn: turn_1(),
        item: NativeItemId::new("message-1"),
        text: "Done while nobody watched".to_owned(),
    })
    .await;

    let (view, _subscription) = f.host.attach(&f.chat.id).await.unwrap();
    assert!(view.snapshot.items.iter().any(|item| matches!(
        item,
        ChatItem::Message(message) if message.text == "Done while nobody watched"
    )));
    assert_eq!(view.live.activity, Activity::Working);
    assert_eq!(f.fake.opens().len(), 1);
    assert_eq!(f.fake.written().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_storage_failure_stops_admission_and_the_runtime_until_storage_returns() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;

    f.storage_up.store(false, Ordering::SeqCst);
    assert!(f.fake.emit(text_delta("lost")).await);
    tokio::time::sleep(Duration::from_secs(60)).await;

    let written = f.fake.written();
    assert!(matches!(written[1], Written::Interrupt(_)));
    assert!(matches!(written[2], Written::Close(_)));
    let refused = f.host.send(&f.chat.id, None, "more", SendMode::Auto).await;
    assert!(matches!(refused, Err(HostError::StorageFailed(_))));

    f.storage_up.store(true, Ordering::SeqCst);
    assert!(matches!(
        f.live().await.problem,
        Some(ChatProblem::StorageFailed { .. })
    ));
    f.send("again").await;
    assert_eq!(f.turns()[0].state, ChatTurnState::Unknown);
    assert_eq!(f.submits()[1].text, "again");
    assert_eq!(f.live().await.problem, None);
}

#[tokio::test(start_paused = true)]
async fn a_turn_with_no_final_event_stays_active_until_contact_is_lost() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.queue("second").await;

    tokio::time::sleep(Duration::from_secs(3_600)).await;
    assert_eq!(f.turns()[0].state, ChatTurnState::Active);
    assert_eq!(f.live().await.activity, Activity::Working);
    assert_eq!(f.submits().len(), 1);

    f.fake.lose_process().await;
    tokio::time::sleep(Duration::from_secs(3_600)).await;
    assert_eq!(f.turns()[0].state, ChatTurnState::Unknown);
    assert_eq!(f.live().await.activity, Activity::Idle);
    assert_eq!(f.queued(), ["second"]);
    assert_eq!(f.submits().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_failed_native_resume_keeps_the_chat_readable_and_a_fresh_session_is_explicit() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(EventKind::SessionIdentified {
        native_session: NativeSessionId::new("native-1"),
    })
    .await;
    f.fake.lose_process().await;
    settle().await;
    f.fake.fail_next_open(Problem {
        kind: ProblemKind::NativeHistoryUnavailable,
        message: "the session file is missing".to_owned(),
        detail: None,
    });

    let resumed = f.host.resume(&f.chat.id, ResumeMode::Native).await;
    assert!(matches!(
        resumed,
        Err(HostError::Harness(problem)) if problem.kind == ProblemKind::NativeHistoryUnavailable
    ));
    tokio::time::sleep(Duration::from_secs(3_600)).await;
    let (view, _subscription) = f.host.attach(&f.chat.id).await.unwrap();
    assert!(!view.snapshot.items.is_empty());
    assert!(matches!(
        view.live.problem,
        Some(ChatProblem::OpenFailed {
            native_resume: true,
            ..
        })
    ));
    assert_eq!(
        f.fake.opens().len(),
        1,
        "no session was started automatically"
    );

    let fresh = ResumeMode::FreshSession {
        history: "Earlier: we agreed on the plan.".to_owned(),
    };
    f.host.resume(&f.chat.id, fresh).await.unwrap();
    f.emit(EventKind::SessionIdentified {
        native_session: NativeSessionId::new("native-2"),
    })
    .await;

    assert_eq!(f.fake.opens()[1].session, SessionStart::New);
    assert_eq!(f.submits().len(), 1, "nothing was replayed");
    let sessions: Vec<_> = f
        .items()
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::Session(session) => Some((session.native_session_id, session.origin)),
            _ => None,
        })
        .collect();
    assert_eq!(
        sessions,
        [
            ("native-1".to_owned(), ChatSessionOrigin::New),
            ("native-2".to_owned(), ChatSessionOrigin::FreshSession),
        ]
    );

    f.send("continue").await;
    assert_eq!(
        f.submits()[1].text,
        "Earlier: we agreed on the plan.\n\ncontinue"
    );
}

#[tokio::test(start_paused = true)]
async fn quit_stops_runtimes_refuses_new_work_and_reports_unconfirmed_cleanup() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.fake.set_close_outcome(CloseOutcome::Unconfirmed {
        reason: "child processes may remain".to_owned(),
    });

    let unconfirmed = f.host.quit().await;

    assert_eq!(
        unconfirmed,
        [UnconfirmedCleanup {
            chat_id: f.chat.id.clone(),
            reason: "child processes may remain".to_owned(),
        }]
    );
    let written = f.fake.written();
    assert!(matches!(written[1], Written::Interrupt(_)));
    assert!(matches!(written[2], Written::Close(_)));
    assert_eq!(f.turns()[0].state, ChatTurnState::Unknown);
    let refused = f.host.send(&f.chat.id, None, "more", SendMode::Auto).await;
    assert!(matches!(refused, Err(HostError::Quitting)));
}

#[tokio::test(start_paused = true)]
async fn archive_leaves_the_turn_running_and_trash_stops_it() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;

    f.core().set_chat_archived(&f.chat.id, true).unwrap();
    f.host.notify_changed(&f.chat.id).await.unwrap();
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(f.fake.written().len(), 1);
    assert!(f.live().await.running);

    assert_eq!(f.host.trash(&f.chat.id).await.unwrap(), None);
    assert!(matches!(f.fake.written().last(), Some(Written::Close(_))));
    assert!(!f.live().await.running);
    let refused = f.host.send(&f.chat.id, None, "more", SendMode::Auto).await;
    assert!(matches!(
        refused,
        Err(HostError::Core(Error::ChatTrashed(_)))
    ));
}

#[tokio::test(start_paused = true)]
async fn chats_run_at_the_same_time_each_in_its_own_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut core = Workspace::open(&path).unwrap();
    let (codex_chat, claude_chat) = (
        new_chat(&mut core, "codex"),
        new_chat(&mut core, "claude-code"),
    );
    drop(core);
    let codex = FakeAdapter::codex();
    let claude = FakeAdapter::new(
        Harness::ClaudeCode,
        Capabilities {
            steering: Capability::Unknown {
                reason: "not probed".to_owned(),
            },
            native_resume: Capability::Unknown {
                reason: "not probed".to_owned(),
            },
        },
    );
    let opener: WorkspaceOpener = {
        let path = path.clone();
        Arc::new(move || Workspace::open(&path))
    };
    let adapters: Vec<Arc<dyn HarnessAdapter>> =
        vec![Arc::new(codex.clone()), Arc::new(claude.clone())];
    let host = ChatHost::new(opener, adapters).unwrap();

    host.send(&codex_chat.id, None, "one", SendMode::Auto)
        .await
        .unwrap();
    host.send(&claude_chat.id, None, "two", SendMode::Auto)
        .await
        .unwrap();
    settle().await;

    let core = Workspace::open(&path).unwrap();
    for (chat, fake) in [(&codex_chat, &codex), (&claude_chat, &claude)] {
        assert!(core.chat(&chat.id).unwrap().active_turn.is_some());
        assert_eq!(fake.opens().len(), 1);
        assert_eq!(fake.written().len(), 1);
    }
}

#[tokio::test(start_paused = true)]
async fn a_new_session_gets_the_ticketd_context_once_and_it_is_kept_apart_from_the_input() {
    let mut f = Fixture::new(FakeAdapter::codex());
    let path = f.path.clone();
    f.host = ChatHost::with_context(
        Arc::new(move || Workspace::open(&path)),
        vec![Arc::new(f.fake.clone()) as Arc<dyn HarnessAdapter>],
        Some(Arc::new(|chat_id| Some(format!("context for {chat_id}")))),
    )
    .unwrap();

    let first = f.send("first").await;
    f.emit(EventKind::TurnEnded {
        turn: NativeTurnId::new("turn-1"),
        outcome: TurnOutcome::Completed,
        submissions: Vec::new(),
    })
    .await;
    f.send("second").await;

    let context = format!("context for {}", f.chat.id);
    assert_eq!(f.submits()[0].text, format!("{context}\n\nfirst"));
    assert_eq!(f.submits()[1].text, "second");
    assert_eq!(f.message(&first.id).text, "first");
    let kept: Vec<_> = f
        .items()
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::Tool(tool) if tool.name == CONTEXT_RECORD_NAME => Some(tool.input),
            _ => None,
        })
        .collect();
    assert_eq!(kept, [context]);
}

#[tokio::test(start_paused = true)]
async fn live_state_is_readable_without_a_view_and_cleared_when_the_chat_stops() {
    let f = Fixture::new(FakeAdapter::codex());
    let mut changed = f.host.changed();
    changed.borrow_and_update();

    f.send("first").await;

    assert!(changed.has_changed().unwrap());
    assert_eq!(f.host.live()[&f.chat.id].activity, Activity::Working);
    f.host.stop_all().await;
    assert!(f.host.live().is_empty());
}
