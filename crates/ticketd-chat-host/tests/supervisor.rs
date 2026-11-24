//! The Chat supervisor through its host interface, with the fake adapter as the harness
//! and a temporary SQLite workspace behind the real core. The clock is paused: time
//! moves only when every task is waiting, so `settle` means "until nothing more happens".
#![allow(clippy::unwrap_used, clippy::panic)] // test setup and assertions

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ticketd_chat_host::records::{FILES_RECORD_NAME, PLAN_RECORD_NAME, REASONING_RECORD_NAME};
use ticketd_chat_host::testing::{FakeAdapter, SubmitReply, Written};
use ticketd_chat_host::{
    AGENT_CHANGES_RECORD_NAME, Activity, ApprovalDecision, CONTEXT_RECORD_NAME, Capabilities,
    Capability, ChatHost, ChatProblem, ChatUpdate, CloseOutcome, DELIVERY_CONFIRMATION_TIMEOUT,
    DeliveryEvidence, EventKind, HarnessAdapter, HostError, INTERRUPT_TIMEOUT, InteractionAnswer,
    InteractionKind, InteractionRequest, InteractionResolution, NativeItemId, NativeRequestId,
    NativeSessionId, NativeTurnId, NoticeKind, Problem, ProblemKind, ProviderDetail, ResumeMode,
    RuntimeGeneration, SUBSCRIBER_BACKLOG_ITEMS, SendMode, SessionStart, StopReason, StopState,
    Submission, SubmissionId, SubmissionKind, Subscription, TEXT_CHECKPOINT_INTERVAL,
    TEXT_UPDATE_INTERVAL, ToolStatus, TurnEnding, TurnOutcome, UnconfirmedCleanup, WorkspaceOpener,
    problem_kind,
};
use ticketd_chat_host::{
    AppliesFrom, ContextUsage, FileChange, FileChangeKind, HarnessSettings, PermissionKind, Plan,
    PlanStep, PlanStepStatus, Setting, SettingChange, SettingChangeState, SettingKey,
    SettingOption, SettingOutcome, StartSettings,
};
use ticketd_core::{
    Chat, ChatDelivery, ChatDeliveryDecision, ChatInteractionState, ChatItem, ChatMessage,
    ChatRecord, ChatRole, ChatSessionOrigin, ChatSubmissionIntent, ChatToolState, ChatTurn,
    ChatTurnState, Error, NewChat, Workspace, WorkspaceSession,
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
        let harness = fake.harness().key.as_str();
        let chat = new_chat(&mut Workspace::open(&path).unwrap(), harness);
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

    /// How the Chat's first turn ended, as the supervisor stored it.
    fn first_ending(&self) -> Option<TurnEnding> {
        TurnEnding::of(&self.turns()[0])
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
            item: None,
            kind: InteractionKind::Approval {
                description: "Run cargo test".to_owned(),
                reason: None,
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
            WorkspaceSession::for_file(&path)?.workspace()
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
async fn new_chats_picks_open_the_first_session() {
    let f = Fixture::new(FakeAdapter::codex());
    let picks = StartSettings {
        model: Some("gpt-b".to_owned()),
        effort: Some("high".to_owned()),
        permission: None,
    };
    f.host.start_with(&f.chat.id, picks.clone()).await.unwrap();

    f.send("hello").await;

    assert_eq!(f.fake.opens()[0].settings, picks);
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

    // Later work carries the queued and the new input, in the order they were saved,
    // never the input whose delivery is uncertain.
    let after = restarted.send(&f.chat.id, None, "after the restart", SendMode::Auto);
    after.await.unwrap();
    settle().await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    let sent: Vec<_> = f.submits().into_iter().map(|sent| sent.text).collect();
    assert_eq!(sent, ["queued before the crash", "after the restart"]);
    let attempts = f.message(&input.id).attempts;
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].delivery, ChatDelivery::Uncertain);
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
async fn a_claude_like_harness_never_acknowledges_a_new_turn_so_it_stays_unconfirmed_until_processed()
 {
    let f = Fixture::new(FakeAdapter::claude());
    let input = f.send("first").await;
    f.queue("second").await;

    // The harness took the input and said nothing more: possibly delivered, not
    // acknowledged, and nothing else is sent while it is unconfirmed.
    let attempt = f.message(&input.id).attempts[0].clone();
    assert_eq!(attempt.delivery, ChatDelivery::Possible);
    assert!(f.live().await.delivery_unconfirmed);
    assert_eq!(f.submits().len(), 1);

    // Processing correlates the input with a turn, which is only known now. It is
    // evidence the input arrived, not an acknowledgment.
    f.emit(EventKind::TurnStarted { turn: turn_1() }).await;
    f.emit(EventKind::SubmissionEvidence {
        submission: SubmissionId(attempt.id),
        evidence: DeliveryEvidence::Processing { turn: turn_1() },
    })
    .await;
    let attempts = f.message(&input.id).attempts;
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].delivery, ChatDelivery::Possible);
    assert!(attempts[0].turn_id.is_some());
    assert!(!f.live().await.delivery_unconfirmed);
    assert_eq!(f.submits().len(), 1);

    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    let submits = f.submits();
    assert_eq!(submits.len(), 2);
    assert_eq!(submits[1].text, "second");
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
async fn a_turn_the_person_stopped_is_interrupted_even_when_the_harness_says_completed() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.host.stop(&f.chat.id).await.unwrap();
    settle().await;
    assert!(matches!(
        f.fake.written().last(),
        Some(Written::Interrupt(_))
    ));
    // Codex can end an interrupted turn as `completed`.
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    assert_eq!(f.turns()[0].state, ChatTurnState::Interrupted);
    assert_eq!(f.live().await.stop, None);
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

/// N5: Codex confirms an answer (`serverRequest/resolved`) before the write of it
/// returns. The card still says what the person chose, not a bare "Answered".
#[tokio::test(start_paused = true)]
async fn an_answer_the_harness_confirms_before_the_write_returns_keeps_the_choice() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    let interaction = f.request_approval().await;
    let release = f.fake.hold_next_respond();

    let answering = f
        .host
        .respond(&f.chat.id, &interaction, approve(ApprovalDecision::Allow));
    let confirm = async {
        settle().await;
        f.emit(EventKind::InteractionResolved {
            request: NativeRequestId::new("approval-1"),
            resolution: InteractionResolution::Answered,
        })
        .await;
        release.send(()).unwrap();
    };
    let (answered, ()) = tokio::join!(answering, confirm);
    settle().await;

    assert!(answered.is_ok(), "{answered:?}");
    let stored = f.items().into_iter().find_map(|item| match item {
        ChatItem::Interaction(interaction) => Some(interaction),
        _ => None,
    });
    let stored = stored.unwrap();
    assert_eq!(stored.state, ChatInteractionState::Answered);
    assert_eq!(stored.response.as_deref(), Some("allow"));
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
    // The second answer is refused by the host itself, not left for the harness to refuse.
    assert_eq!(f.fake.respond_calls(), 1);
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
    assert_eq!(
        f.first_ending(),
        Some(TurnEnding::StoppedByTicketd(StopReason::StorageFailed))
    );
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
        resets_at: None,
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
        &ticketd_core::harnesses::CLAUDE_CODE,
        Capabilities {
            steering: Capability::Unknown {
                reason: "not probed".to_owned(),
            },
        },
    );
    let opener: WorkspaceOpener = {
        let path = path.clone();
        Arc::new(move || WorkspaceSession::for_file(&path)?.workspace())
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
        Arc::new(move || WorkspaceSession::for_file(&path)?.workspace()),
        vec![Arc::new(f.fake.clone()) as Arc<dyn HarnessAdapter>],
        Some(Arc::new(|chat_id| {
            Ok(Some(format!("context for {chat_id}")))
        })),
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
    f.host.stop_all(ticketd_chat_host::StopReason::Quit).await;
    assert!(f.host.live().is_empty());
}

fn notices(f: &Fixture) -> Vec<String> {
    f.items()
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::Notice(notice) => Some(notice.text),
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn input_a_turn_only_processed_is_not_uncertain_after_a_restart() {
    let f = Fixture::new(FakeAdapter::codex());
    // As Claude Code does: the write is never acknowledged, only correlated with a turn.
    f.fake.script_submit(SubmitReply::Timeout);
    let input = f.send("first").await;
    let attempt = f.message(&input.id).attempts[0].id.clone();
    f.emit(EventKind::SubmissionEvidence {
        submission: SubmissionId(attempt.clone()),
        evidence: DeliveryEvidence::Processing { turn: turn_1() },
    })
    .await;
    f.emit(EventKind::TurnEnded {
        turn: turn_1(),
        outcome: TurnOutcome::Completed,
        submissions: vec![SubmissionId(attempt)],
    })
    .await;
    f.host.quit().await;

    start_host(&f.path, &f.storage_up, &f.fake);

    let attempts = f.message(&input.id).attempts;
    assert_eq!(attempts[0].delivery, ChatDelivery::Possible);
    assert!(attempts[0].received());
    assert!(!f.message(&input.id).awaits_decision());
    assert_eq!(f.turns()[0].state, ChatTurnState::Completed);
}

#[tokio::test(start_paused = true)]
async fn a_stop_before_the_turn_is_known_becomes_unconfirmed_and_the_wait_for_it_is_bounded() {
    let f = Fixture::new(FakeAdapter::codex());
    f.fake.script_submit(SubmitReply::Timeout);
    let input = f.send("first").await;
    f.queue("later").await;

    f.host.stop(&f.chat.id).await.unwrap();
    settle().await;
    assert_eq!(f.live().await.stop, Some(StopState::Requested));

    tokio::time::sleep(INTERRUPT_TIMEOUT).await;
    let live = f.live().await;
    assert_eq!(live.stop, Some(StopState::Unconfirmed));
    assert_eq!(live.activity, Activity::Working);

    tokio::time::sleep(DELIVERY_CONFIRMATION_TIMEOUT).await;
    let live = f.live().await;
    assert_eq!(live.activity, Activity::Idle);
    assert!(!live.delivery_unconfirmed);
    assert_eq!(live.stop, None);
    assert!(f.message(&input.id).awaits_decision());
    assert_eq!(f.submits().len(), 1, "nothing was sent again");
    assert_eq!(f.queued(), ["later"]);
}

#[tokio::test(start_paused = true)]
async fn a_failed_turn_keeps_its_problem_kind_and_notices_and_settings_reach_later_views() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(EventKind::Notice {
        turn: None,
        kind: NoticeKind::EffectiveSettings,
        message: "settings".to_owned(),
        detail: Some(ProviderDetail::new("settings", r#"{"model":"m"}"#)),
    })
    .await;
    f.emit(EventKind::Notice {
        turn: Some(turn_1()),
        kind: NoticeKind::Retrying,
        message: "Reconnecting (2/5)".to_owned(),
        detail: None,
    })
    .await;
    f.emit(turn_ended(
        turn_1(),
        TurnOutcome::Failed(Problem {
            kind: ProblemKind::QuotaExhausted,
            message: "You have hit your usage limit".to_owned(),
            detail: None,
            resets_at: Some(1_730_948_100),
        }),
    ))
    .await;

    // Nothing was attached while this happened; it is all in the records.
    let turn = f.turns().remove(0);
    assert_eq!(turn.state, ChatTurnState::Failed);
    assert_eq!(turn.problem.as_deref(), Some("quota_exhausted"));
    assert_eq!(turn.problem_resets_at, Some(1_730_948_100));
    assert_eq!(problem_kind("quota_exhausted"), ProblemKind::QuotaExhausted);
    assert_eq!(notices(&f), ["Reconnecting (2/5)"]);
    let chat = f.core().chat(&f.chat.id).unwrap();
    assert_eq!(chat.effective_settings.as_deref(), Some(r#"{"model":"m"}"#));
}

#[tokio::test(start_paused = true)]
async fn a_trashed_chat_cannot_be_resumed() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.host.trash(&f.chat.id).await.unwrap();

    for mode in [
        ResumeMode::Native,
        ResumeMode::FreshSession {
            history: "earlier".to_owned(),
        },
    ] {
        let refused = f.host.resume(&f.chat.id, mode).await;
        assert!(matches!(
            refused,
            Err(HostError::Core(Error::ChatTrashed(_)))
        ));
    }
    settle().await;
    assert_eq!(f.fake.opens().len(), 1, "no runtime was started");
}

#[tokio::test(start_paused = true)]
async fn the_feed_of_a_view_ends_when_the_supervisor_of_its_chat_stops() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    let (_view, mut subscription) = f.host.attach(&f.chat.id).await.unwrap();

    f.host.stop_all(ticketd_chat_host::StopReason::Quit).await;

    let ended = tokio::time::timeout(Duration::from_secs(60), async {
        while subscription.next().await.is_some() {}
    });
    assert!(ended.await.is_ok(), "the feed must end, not wait forever");
}

#[tokio::test(start_paused = true)]
async fn a_resend_is_a_new_submission_of_that_input_alone_and_only_when_asked() {
    let f = Fixture::new(FakeAdapter::codex());
    f.fake.script_submit(SubmitReply::LoseProcess);
    let input = f.send("first").await;
    f.host.resume_queue(&f.chat.id).await.unwrap();
    tokio::time::sleep(Duration::from_secs(3_600)).await;
    assert_eq!(f.submits().len(), 1, "nothing is resent by itself");
    f.queue("later").await;

    f.host.resend(&f.chat.id, &input.id).await.unwrap();
    settle().await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    tokio::time::sleep(Duration::from_secs(3_600)).await;

    let sent: Vec<_> = f.submits().into_iter().map(|sent| sent.text).collect();
    assert_eq!(sent, ["first", "first"]);
    let attempts = f.message(&input.id).attempts;
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0].delivery, ChatDelivery::Uncertain);
    assert_eq!(attempts[0].decision, Some(ChatDeliveryDecision::Resent));
    assert_ne!(f.submits()[0].submission, f.submits()[1].submission);
    assert_eq!(f.queued(), ["later"], "the queue waits for the person");
    // It was decided once; there is nothing left to resend.
    f.host.resend(&f.chat.id, &input.id).await.unwrap();
    settle().await;
    assert_eq!(f.submits().len(), 2);
    assert_eq!(notices(&f).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_context_that_cannot_be_read_is_said_and_the_session_starts_without_it() {
    let mut f = Fixture::new(FakeAdapter::codex());
    let path = f.path.clone();
    f.host = ChatHost::with_context(
        Arc::new(move || WorkspaceSession::for_file(&path)?.workspace()),
        vec![Arc::new(f.fake.clone()) as Arc<dyn HarnessAdapter>],
        Some(Arc::new(|_| {
            Err("the workspace could not be opened".to_owned())
        })),
    )
    .unwrap();

    f.send("first").await;

    assert_eq!(f.submits()[0].text, "first");
    assert!(notices(&f)[0].contains("the workspace could not be opened"));
}

#[tokio::test(start_paused = true)]
async fn a_discarded_message_is_never_sent_even_when_its_rejection_arrives_late() {
    let f = Fixture::new(FakeAdapter::codex());
    f.fake.script_submit(SubmitReply::Timeout);
    let input = f.send("first").await;
    tokio::time::sleep(DELIVERY_CONFIRMATION_TIMEOUT + Duration::from_secs(1)).await;
    settle().await;
    assert!(f.message(&input.id).awaits_decision());
    f.core()
        .discard_uncertain_chat_submission(&f.chat.id, &input.id)
        .unwrap();
    f.host.notify_changed(&f.chat.id).await.unwrap();

    // The harness turns out to have refused it, after the person set it aside.
    f.emit(EventKind::SubmissionEvidence {
        submission: f.submits()[0].submission.clone(),
        evidence: DeliveryEvidence::Rejected {
            reason: "late".to_owned(),
        },
    })
    .await;
    f.host.resume_queue(&f.chat.id).await.unwrap();
    tokio::time::sleep(Duration::from_secs(3_600)).await;

    let after = f.message(&input.id);
    assert_eq!(after.attempts[0].delivery, ChatDelivery::Rejected);
    assert_eq!(
        after.attempts[0].decision,
        Some(ChatDeliveryDecision::Discarded)
    );
    assert!(!after.queued && !after.awaits_decision());
    assert_eq!(f.queued(), [] as [&str; 0]);
    assert_eq!(
        f.submits().len(),
        1,
        "a discarded message is not sent again"
    );
}

#[tokio::test(start_paused = true)]
async fn a_refused_resend_returns_the_message_to_the_person_and_keeps_the_uncertainty() {
    let f = Fixture::new(FakeAdapter::codex());
    f.fake.script_submit(SubmitReply::LoseProcess);
    let input = f.send("first").await;
    f.fake
        .script_submit(SubmitReply::Reject("not now".to_owned()));

    f.host.resend(&f.chat.id, &input.id).await.unwrap();
    settle().await;
    f.host.resume_queue(&f.chat.id).await.unwrap();
    tokio::time::sleep(Duration::from_secs(3_600)).await;

    let after = f.message(&input.id);
    let deliveries: Vec<_> = after.attempts.iter().map(|a| a.delivery).collect();
    assert_eq!(
        deliveries,
        [ChatDelivery::Uncertain, ChatDelivery::Rejected]
    );
    assert!(after.awaits_decision(), "the person decides again");
    assert_eq!(f.queued(), [] as [&str; 0]);
    assert_eq!(f.submits().len(), 2, "the refused resend is not repeated");

    // Asking again is a new submission of the same message.
    f.host.resend(&f.chat.id, &input.id).await.unwrap();
    settle().await;
    assert_eq!(f.submits().len(), 3);
    assert_eq!(f.message(&input.id).attempts.len(), 3);
}

#[tokio::test(start_paused = true)]
async fn an_unavailable_optional_capability_is_a_stored_notice_and_never_the_chats_problem() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(EventKind::Notice {
        turn: Some(turn_1()),
        kind: NoticeKind::CapabilityUnavailable,
        message: "The MCP server 'github' did not start".to_owned(),
        detail: None,
    })
    .await;

    let live = f.live().await;
    assert_eq!(live.problem, None, "it is not what stops a Chat");
    assert_eq!(live.activity, Activity::Working, "the turn goes on");
    assert_eq!(notices(&f), ["The MCP server 'github' did not start"]);

    // Other work stays available, and a real problem is reported as before.
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    f.send("second").await;
    assert_eq!(f.submits().len(), 2);
    f.fake.lose_process().await;
    settle().await;
    assert!(matches!(
        f.live().await.problem,
        Some(ChatProblem::RuntimeLost { .. })
    ));
}

#[tokio::test(start_paused = true)]
async fn a_host_handle_taken_before_a_restore_can_start_nothing_during_it() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    let held = f.host.clone();

    assert_eq!(f.host.begin_restore().await, Vec::new());
    assert_eq!(f.fake.opens().len(), 1);
    let refused = held.send(&f.chat.id, None, "during", SendMode::Auto).await;
    assert!(matches!(refused, Err(HostError::Restoring)));
    assert!(matches!(
        held.attach(&f.chat.id).await,
        Err(HostError::Restoring)
    ));
    assert!(matches!(
        held.resume(&f.chat.id, ResumeMode::Native).await,
        Err(HostError::Restoring)
    ));
    assert!(matches!(
        held.notify_changed(&f.chat.id).await,
        Err(HostError::Restoring)
    ));
    tokio::time::sleep(Duration::from_secs(3_600)).await;
    assert_eq!(
        f.fake.opens().len(),
        1,
        "no harness starts during a restore"
    );
    assert!(
        held.live().is_empty(),
        "no supervisor runs during a restore"
    );
    assert_eq!(f.queued(), [] as [&str; 0], "nothing was saved either");

    f.host.finish_restore();
    held.send(&f.chat.id, None, "after", SendMode::Auto)
        .await
        .unwrap();
    settle().await;
    assert_eq!(f.fake.opens().len(), 2);
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

    // Switching Chat off closes the host the same way.
    assert_eq!(f.host.turn_off().await, Vec::new());
    let refused = held.send(&f.chat.id, None, "while off", SendMode::Auto);
    assert!(matches!(refused.await, Err(HostError::TurnedOff)));
    tokio::time::sleep(Duration::from_secs(3_600)).await;
    assert_eq!(
        f.fake.opens().len(),
        2,
        "no harness starts while Chat is off"
    );
    f.host.turn_on();
    assert!(held.attach(&f.chat.id).await.is_ok());
}

/// L7: an idle harness that exits ended its session; no turn failed.
#[tokio::test(start_paused = true)]
async fn a_harness_that_exits_while_idle_is_not_a_failed_turn() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

    f.fake.lose_process().await;
    settle().await;

    let live = f.live().await;
    assert_eq!(live.problem, None);
    assert_eq!(live.activity, Activity::Idle);
    assert!(!live.running);
    assert!(!f.core().chat(&f.chat.id).unwrap().queue_paused);
    assert_eq!(f.turns()[0].state, ChatTurnState::Completed);
    // The next message opens the session again.
    f.send("second").await;
    assert_eq!(f.fake.opens().len(), 2);
    assert_eq!(f.submits().len(), 2);
}

/// L7: ticketd closing an idle runtime itself (trash) is not a lost harness either.
#[tokio::test(start_paused = true)]
async fn closing_an_idle_runtime_leaves_no_problem_behind() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

    assert_eq!(f.host.trash(&f.chat.id).await.unwrap(), None);
    f.core().set_chat_trashed(&f.chat.id, false).unwrap();
    f.host.notify_changed(&f.chat.id).await.unwrap();
    settle().await;

    assert_eq!(f.live().await.problem, None);
}

/// L6: Resume on a paused queue opens a session when none is live, and the queue goes
/// out in the order it was saved.
#[tokio::test(start_paused = true)]
async fn resuming_the_queue_with_no_session_opens_one_and_sends_in_queue_order() {
    let f = Fixture::new(FakeAdapter::codex());
    f.queue("older").await;
    f.host.stop(&f.chat.id).await.unwrap();
    f.queue("old").await;
    settle().await;
    assert!(f.fake.opens().is_empty(), "queueing starts nothing");

    f.host.resume_queue(&f.chat.id).await.unwrap();
    settle().await;
    assert_eq!(f.fake.opens().len(), 1);
    let texts = |f: &Fixture| f.submits().into_iter().map(|s| s.text).collect::<Vec<_>>();
    assert_eq!(texts(&f), ["older"]);
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    assert_eq!(texts(&f), ["older", "old"]);
}

/// L6: a message sent while older input waits in a queue that is not paused goes after
/// it, and the queue runs.
#[tokio::test(start_paused = true)]
async fn a_message_sent_while_older_input_waits_in_a_running_queue_goes_after_it() {
    let f = Fixture::new(FakeAdapter::codex());
    f.queue("older").await;
    f.send("newer").await;

    let texts = |f: &Fixture| f.submits().into_iter().map(|s| s.text).collect::<Vec<_>>();
    assert_eq!(texts(&f), ["older"], "queue order is kept");
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    assert_eq!(texts(&f), ["older", "newer"]);
}

/// L8: streamed text is shown without reading the workspace for every fragment, so a
/// fast harness does not leave the view seconds behind it.
#[tokio::test(start_paused = true)]
async fn streamed_text_does_not_read_the_workspace_for_every_fragment() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let chat = new_chat(&mut Workspace::open(&path).unwrap(), "codex");
    let fake = FakeAdapter::codex();
    let opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = opens.clone();
    let host = ChatHost::new(
        Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            WorkspaceSession::for_file(&path)?.workspace()
        }),
        vec![Arc::new(fake.clone()) as Arc<dyn HarnessAdapter>],
    )
    .unwrap();
    host.send(&chat.id, None, "first", SendMode::Auto)
        .await
        .unwrap();
    settle().await;
    let (_view, mut subscription) = host.attach(&chat.id).await.unwrap();
    assert!(fake.emit(text_delta("start ")).await);
    settle().await;

    let before = opens.load(Ordering::SeqCst);
    for _ in 0..200 {
        assert!(fake.emit(text_delta("word ")).await);
    }
    tokio::time::sleep(TEXT_UPDATE_INTERVAL * 2).await;

    let reads = opens.load(Ordering::SeqCst) - before;
    assert!(reads < 10, "{reads} workspace opens for 200 fragments");
    let shown: String = drain(&mut subscription)
        .await
        .into_iter()
        .filter_map(|update| match update {
            ChatUpdate::Text { delta, .. } => Some(delta),
            _ => None,
        })
        .collect();
    assert!(shown.ends_with(&"word ".repeat(200)), "{shown}");
}

/// L5: a notice the harness repeats word for word is kept once per session.
#[tokio::test(start_paused = true)]
async fn a_notice_the_harness_repeats_is_kept_once_per_session() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    let repeated = || {
        [
            EventKind::Notice {
                turn: None,
                kind: NoticeKind::Warning,
                message: "Codex reported a warning".to_owned(),
                detail: None,
            },
            EventKind::Unknown {
                summary: "Unrecognized Codex message: thread/new".to_owned(),
                detail: ProviderDetail::new("thread/new", "{}"),
            },
        ]
    };
    for _ in 0..3 {
        for event in repeated() {
            f.emit(event).await;
        }
    }
    assert_eq!(
        notices(&f),
        [
            "Codex reported a warning",
            "Unrecognized Codex message: thread/new"
        ]
    );

    // A new session says it again, once.
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    f.host.stop_all(ticketd_chat_host::StopReason::Quit).await;
    f.send("second").await;
    for _ in 0..2 {
        for event in repeated() {
            f.emit(event).await;
        }
    }
    assert_eq!(notices(&f).len(), 4);
}

/// L4: links changed after the session started reach the agent with the next new turn,
/// kept as context like the first delivery; a resumed native session is told only
/// when its context differs from what it was given.
#[tokio::test(start_paused = true)]
async fn links_changed_after_the_session_started_reach_the_agent_with_the_next_message() {
    let mut f = Fixture::new(FakeAdapter::codex());
    let path = f.path.clone();
    let context = Arc::new(std::sync::Mutex::new("links: none".to_owned()));
    let source = context.clone();
    f.host = ChatHost::with_context(
        Arc::new(move || WorkspaceSession::for_file(&path)?.workspace()),
        vec![Arc::new(f.fake.clone()) as Arc<dyn HarnessAdapter>],
        Some(Arc::new(move |_| Ok(Some(source.lock().unwrap().clone())))),
    )
    .unwrap();
    f.send("first").await;
    f.emit(EventKind::SessionIdentified {
        native_session: NativeSessionId::new("session-1"),
    })
    .await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

    *context.lock().unwrap() = "links: T-KQ1".to_owned();
    f.host.links_changed(&f.chat.id).await.unwrap();
    f.send("second").await;
    f.emit(turn_ended(
        NativeTurnId::new("turn-2"),
        TurnOutcome::Completed,
    ))
    .await;
    f.send("third").await;
    f.emit(turn_ended(
        NativeTurnId::new("turn-3"),
        TurnOutcome::Completed,
    ))
    .await;

    let texts = |f: &Fixture| f.submits().into_iter().map(|s| s.text).collect::<Vec<_>>();
    assert_eq!(
        texts(&f),
        ["links: none\n\nfirst", "links: T-KQ1\n\nsecond", "third"]
    );
    let kept: Vec<_> = f
        .items()
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::Tool(tool) if tool.name == CONTEXT_RECORD_NAME => Some(tool.input),
            _ => None,
        })
        .collect();
    assert_eq!(kept, ["links: none", "links: T-KQ1"]);

    // A resumed native session already has what it was given ...
    f.host.stop_all(ticketd_chat_host::StopReason::Quit).await;
    f.send("fourth").await;
    assert_eq!(texts(&f)[3], "fourth");
    f.emit(turn_ended(
        NativeTurnId::new("turn-4"),
        TurnOutcome::Completed,
    ))
    .await;
    // ... and is told when the links changed while no session was live.
    f.host.stop_all(ticketd_chat_host::StopReason::Quit).await;
    *context.lock().unwrap() = "links: T-KQ2".to_owned();
    f.host.links_changed(&f.chat.id).await.unwrap();
    f.send("fifth").await;
    assert_eq!(texts(&f)[4], "links: T-KQ2\n\nfifth");
}

/// L3: what the agent changed in ticketd during a turn is kept with the turn when it
/// ends, as one record the Chat view shows.
#[tokio::test(start_paused = true)]
async fn what_the_agent_changed_in_ticketd_is_kept_with_its_turn() {
    let f = Fixture::new(FakeAdapter::codex());
    let ticket = f.core().create_ticket("Reset email").unwrap();
    f.send("first").await;
    // As the agent does, through the CLI under its agent name.
    f.core()
        .add_activity(&ticket.reference, "Drafted the copy", Some("codex"))
        .unwrap();
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    // A turn that changed nothing gets no record.
    f.send("second").await;
    f.emit(turn_ended(
        NativeTurnId::new("turn-2"),
        TurnOutcome::Completed,
    ))
    .await;

    let kept: Vec<_> = f
        .items()
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::Tool(tool) if tool.name == AGENT_CHANGES_RECORD_NAME => Some(tool.input),
            _ => None,
        })
        .collect();
    let [changes] = kept.as_slice() else {
        panic!("one record, got {kept:?}");
    };
    let changes: Vec<ticketd_core::ChatAgentChange> = serde_json::from_str(changes).unwrap();
    assert_eq!(
        changes,
        [ticketd_core::ChatAgentChange::Update {
            reference: ticket.reference,
            excerpt: "Drafted the copy".to_owned(),
        }]
    );
}

/// N1: input sent from the queue enters the conversation when it is sent, which is
/// where a live view shows it; read again later it sits before its own reply, not
/// where it was typed.
#[tokio::test(start_paused = true)]
async fn queued_input_is_kept_in_history_where_it_was_sent() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.queue("queued").await;
    f.emit(EventKind::MessageCompleted {
        turn: turn_1(),
        item: NativeItemId::new("m1"),
        text: "one".to_owned(),
    })
    .await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    assert_eq!(f.submits().len(), 2, "the queued input was sent");

    let texts: Vec<String> = f
        .items()
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::Message(message) => Some(message.text),
            _ => None,
        })
        .collect();
    assert_eq!(texts, ["first", "one", "queued"]);
}

/// U21: a harness process alone is not a session that is working yet.
#[tokio::test(start_paused = true)]
async fn work_is_its_session_opening_until_the_sessions_first_turn_starts() {
    let f = Fixture::new(FakeAdapter::codex());
    let reply = f.fake.hold_next_submit();
    f.send("first").await;

    let live = f.live().await;
    assert!(live.running);
    assert_eq!(live.opening, Some(ChatSessionOrigin::New));

    reply.send(SubmitReply::Acknowledge).unwrap();
    settle().await;
    assert_eq!(f.live().await.opening, None);

    // The next turn of the same session is not its session opening.
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    let _reply = f.fake.hold_next_submit();
    f.send("second").await;
    assert_eq!(f.live().await.activity, Activity::Working);
    assert_eq!(f.live().await.opening, None);
}

/// Send now on a queued card: during a turn it steers that input alone; the rest of
/// the queue keeps waiting for the turn to end.
#[tokio::test(start_paused = true)]
async fn send_now_steers_one_queued_input_and_leaves_the_rest_queued() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.queue("later").await;
    let now = f.queue("this one now").await;

    f.host.send_queued_now(&f.chat.id, &now.id).await.unwrap();
    settle().await;

    assert_eq!(
        f.submits()[1].kind,
        SubmissionKind::Steer {
            expected_turn: turn_1()
        }
    );
    assert_eq!(f.submits()[1].text, "this one now");
    assert_eq!(f.queued(), ["later"]);
}

/// Send now on a paused queue starts a turn with that input only; the queue stays
/// paused until the person resumes it.
#[tokio::test(start_paused = true)]
async fn send_now_on_a_paused_queue_sends_only_that_input() {
    let f = Fixture::new(FakeAdapter::codex());
    f.host.stop(&f.chat.id).await.unwrap();
    f.queue("older").await;
    let now = f.queue("this one now").await;

    f.host.send_queued_now(&f.chat.id, &now.id).await.unwrap();
    settle().await;

    let texts = |f: &Fixture| f.submits().into_iter().map(|s| s.text).collect::<Vec<_>>();
    assert_eq!(texts(&f), ["this one now"]);
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    assert_eq!(texts(&f), ["this one now"], "the paused queue stays paused");
    assert_eq!(f.queued(), ["older"]);
}

/// Without steering, a turn in progress cannot take it now: it stays in the queue.
#[tokio::test(start_paused = true)]
async fn send_now_is_refused_during_a_turn_that_cannot_be_steered() {
    let f = Fixture::new(FakeAdapter::without_steering());
    f.send("first").await;
    let later = f.queue("later").await;

    let refused = f.host.send_queued_now(&f.chat.id, &later.id).await;

    assert!(matches!(refused, Err(HostError::Working)));
    assert_eq!(f.queued(), ["later"]);
}

/// The tool records of the history whose name is `name`, as their stored JSON.
fn records(f: &Fixture, name: &str) -> Vec<(String, ChatToolState, serde_json::Value)> {
    f.items()
        .into_iter()
        .filter_map(|item| match item {
            ChatItem::Tool(tool) if tool.name == name => Some((
                tool.id,
                tool.state,
                serde_json::from_str(&tool.input).unwrap(),
            )),
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn reasoning_plan_and_files_are_kept_with_their_turn_each_replacing_the_last() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("Add a limiter").await;
    let reasoning = |running, text: Option<&str>| EventKind::ReasoningUpdated {
        turn: turn_1(),
        item: NativeItemId::new("rs-1"),
        running,
        started_at: Some(1_000),
        ended_at: (!running).then_some(13_000),
        text: text.map(str::to_owned),
        heading: None,
    };
    let plan = |done| EventKind::PlanUpdated {
        turn: turn_1(),
        plan: Plan {
            steps: vec![PlanStep {
                text: "Add the limiter".to_owned(),
                status: if done {
                    PlanStepStatus::Completed
                } else {
                    PlanStepStatus::InProgress
                },
                active_label: None,
            }],
            explanation: None,
        },
    };
    let files = |confirmed| EventKind::FilesChanged {
        turn: turn_1(),
        files: vec![FileChange {
            path: "/work/app/src/limiter.ts".to_owned(),
            kind: FileChangeKind::Added,
            added_lines: Some(48),
            removed_lines: Some(0),
            confirmed,
        }],
    };

    for event in [
        reasoning(true, None),
        reasoning(false, Some("The handler has no limit.")),
        plan(false),
        plan(true),
        files(false),
        files(true),
    ] {
        f.emit(event).await;
    }

    let [(_, state, kept)] = records(&f, REASONING_RECORD_NAME).try_into().unwrap();
    assert_eq!(state, ChatToolState::Completed);
    assert_eq!(kept["text"], "The handler has no limit.");
    assert_eq!(kept["ended_at"], 13_000);
    let [(_, _, kept)] = records(&f, PLAN_RECORD_NAME).try_into().unwrap();
    assert_eq!(kept["steps"][0]["status"], "completed");
    let [(_, _, kept)] = records(&f, FILES_RECORD_NAME).try_into().unwrap();
    assert_eq!(kept["files"][0]["kind"], "added");
    assert_eq!(kept["files"][0]["confirmed"], true);
}

fn settings(permission: &str) -> HarnessSettings {
    let option = |id: &str, kind| SettingOption {
        id: id.to_owned(),
        label: id.to_owned(),
        description: None,
        is_default: false,
        permission: kind,
        allowed: true,
    };
    HarnessSettings {
        model: Some(Setting {
            current: Some("gpt-a".to_owned()),
            options: vec![option("gpt-a", None), option("gpt-b", None)],
            unchangeable: None,
            applies_from: AppliesFrom::NextTurn,
            answered_by: None,
        }),
        effort: Some(Setting {
            current: Some("low".to_owned()),
            options: vec![option("low", None), option("high", None)],
            unchangeable: None,
            applies_from: AppliesFrom::NextTurn,
            answered_by: None,
        }),
        permission: Some(Setting {
            current: Some(permission.to_owned()),
            options: vec![
                option("ask", Some(PermissionKind::Ask)),
                option("full", Some(PermissionKind::FullAccess)),
            ],
            unchangeable: None,
            applies_from: AppliesFrom::NextTurn,
            answered_by: None,
        }),
    }
}

fn setting_changes(f: &Fixture) -> Vec<SettingChange> {
    f.fake
        .written()
        .into_iter()
        .filter_map(|written| match written {
            Written::Setting(change) => Some(change),
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_setting_changed_during_a_turn_is_held_until_it_ends() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("Start").await;
    f.emit(EventKind::SettingsState(settings("ask"))).await;
    f.emit(EventKind::ContextUsage(ContextUsage {
        used: 124_000,
        window: 200_000,
        categories: Vec::new(),
        compacts_at: None,
    }))
    .await;
    assert_eq!(f.live().await.context.unwrap().usage.used, 124_000);

    let full = f
        .host
        .change_setting(&f.chat.id, SettingKey::Permission, "full")
        .await
        .unwrap();
    let unknown = f
        .host
        .change_setting(&f.chat.id, SettingKey::Model, "gpt-z")
        .await
        .unwrap();
    let held = f
        .host
        .change_setting(&f.chat.id, SettingKey::Model, "gpt-b")
        .await
        .unwrap();
    settle().await;

    // Full access is held like any other choice.
    assert_eq!(full, SettingChangeState::Held);
    assert!(matches!(
        unknown,
        SettingChangeState::Done(SettingOutcome::Refused { .. })
    ));
    assert_eq!(held, SettingChangeState::Held);
    // Nothing reaches the harness while the turn runs.
    assert!(setting_changes(&f).is_empty());

    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

    let mut sent: Vec<String> = setting_changes(&f)
        .into_iter()
        .map(|change| change.value)
        .collect();
    sent.sort();
    assert_eq!(sent, ["full", "gpt-b"]);
    let live = f.live().await;
    let settings = live.settings.unwrap();
    assert_eq!(
        settings.reported.model.unwrap().current.as_deref(),
        Some("gpt-b")
    );
    assert!(settings.changes.iter().any(|change| change.value == "gpt-b"
        && change.state == SettingChangeState::Done(SettingOutcome::Applied)));
}

/// T-QZ66: with no session running, a Chat shows the permission its next session opens
/// with, as its record says, and a change then goes to that session, resumed too.
#[tokio::test(start_paused = true)]
async fn an_idle_chat_shows_its_next_permission_and_a_pick_goes_to_the_resumed_session() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(EventKind::SessionIdentified {
        native_session: NativeSessionId::new("native-1"),
    })
    .await;
    f.emit(EventKind::Notice {
        turn: None,
        kind: NoticeKind::EffectiveSettings,
        message: String::new(),
        detail: Some(ProviderDetail::new("settings", r#"{"permission":"full"}"#)),
    })
    .await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    f.fake.lose_process().await;
    settle().await;

    let idle = f
        .live()
        .await
        .settings
        .expect("shown with no session running");
    assert_eq!(
        idle.reported.permission.and_then(|p| p.current).as_deref(),
        Some("full")
    );
    assert!(idle.reported.model.is_none(), "models wait for a session");

    let picked = f
        .host
        .change_setting(&f.chat.id, SettingKey::Permission, "ask")
        .await
        .unwrap();
    assert_eq!(picked, SettingChangeState::Held);
    let shown = f
        .live()
        .await
        .settings
        .unwrap()
        .reported
        .permission
        .unwrap();
    assert_eq!(shown.current.as_deref(), Some("ask"));
    // Saved at once: a restart before the next message keeps it.
    assert_eq!(
        f.core()
            .chat(&f.chat.id)
            .unwrap()
            .effective_settings
            .as_deref(),
        Some(r#"{"permission":"ask"}"#)
    );
    let model = f
        .host
        .change_setting(&f.chat.id, SettingKey::Model, "gpt-b")
        .await
        .unwrap();
    assert!(matches!(
        model,
        SettingChangeState::Done(SettingOutcome::Refused { .. })
    ));

    f.host.resume(&f.chat.id, ResumeMode::Native).await.unwrap();
    let reopened = f.fake.opens()[1].clone();
    assert_eq!(
        reopened.session,
        SessionStart::Resume(NativeSessionId::new("native-1"))
    );
    assert_eq!(reopened.settings.permission.as_deref(), Some("ask"));
    assert_eq!(
        reopened.recorded_settings.as_deref(),
        Some(r#"{"permission":"ask"}"#)
    );
}

fn recorded(permission: &str) -> EventKind {
    EventKind::Notice {
        turn: None,
        kind: NoticeKind::EffectiveSettings,
        message: String::new(),
        detail: Some(ProviderDetail::new(
            "settings",
            &format!(r#"{{"permission":"{permission}"}}"#),
        )),
    }
}

/// A permission change the live session accepts is saved with the Chat at once, not at
/// its next turn: quitting before another message must not bring Full access back.
#[tokio::test(start_paused = true)]
async fn an_accepted_permission_change_is_recorded_at_once() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(recorded("full")).await;
    f.emit(EventKind::SettingsState(settings("full"))).await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

    let changed = f
        .host
        .change_setting(&f.chat.id, SettingKey::Permission, "ask")
        .await
        .unwrap();
    settle().await;

    assert_eq!(changed, SettingChangeState::Sent);
    assert_eq!(
        f.core()
            .chat(&f.chat.id)
            .unwrap()
            .effective_settings
            .as_deref(),
        Some(r#"{"permission":"ask"}"#)
    );
}

fn written_kinds(f: &Fixture) -> Vec<&'static str> {
    f.fake
        .written()
        .iter()
        .filter_map(|written| match written {
            Written::Submit(_) => Some("submit"),
            Written::Setting(_) => Some("setting"),
            _ => None,
        })
        .collect()
}

/// A permission change held during a turn reaches the harness before the queued message
/// after it: that message runs on the mode the person last chose, never the one they left.
#[tokio::test(start_paused = true)]
async fn a_queued_message_waits_for_a_permission_change_on_its_way() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(EventKind::SettingsState(settings("full"))).await;
    let held = f
        .host
        .change_setting(&f.chat.id, SettingKey::Permission, "ask")
        .await
        .unwrap();
    assert_eq!(held, SettingChangeState::Held);
    f.queue("second").await;

    let answer = f.fake.hold_next_setting();
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    settle().await;
    assert_eq!(
        written_kinds(&f),
        ["submit", "setting"],
        "the message waits"
    );

    answer.send(SettingOutcome::Applied).unwrap();
    settle().await;
    assert_eq!(written_kinds(&f), ["submit", "setting", "submit"]);
}

/// A permission change the harness did not confirm pauses the queue: nothing runs until
/// the person, told why in the dock, resumes it.
#[tokio::test(start_paused = true)]
async fn an_unconfirmed_permission_change_pauses_the_queue() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(EventKind::SettingsState(settings("full"))).await;
    f.host
        .change_setting(&f.chat.id, SettingKey::Permission, "ask")
        .await
        .unwrap();
    f.queue("second").await;

    drop(f.fake.hold_next_setting());
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    settle().await;

    assert_eq!(written_kinds(&f), ["submit", "setting"]);
    assert!(f.core().chat(&f.chat.id).unwrap().queue_paused);
    assert_eq!(f.queued(), ["second"]);
}

/// A harness lost while a permission change is on its way stops the queue, and its next
/// session opens with that change: nothing runs on the mode the person left.
#[tokio::test(start_paused = true)]
async fn a_harness_lost_with_a_permission_change_on_its_way_pauses_and_keeps_it() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(recorded("full")).await;
    f.emit(EventKind::SettingsState(settings("full"))).await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

    let answer = f.fake.hold_next_setting();
    let changed = f
        .host
        .change_setting(&f.chat.id, SettingKey::Permission, "ask")
        .await
        .unwrap();
    assert_eq!(changed, SettingChangeState::Sent);
    f.fake.lose_process().await;
    settle().await;
    drop(answer);
    settle().await;

    let chat = f.core().chat(&f.chat.id).unwrap();
    assert!(
        chat.queue_paused,
        "a loss with a change in flight is not quiet"
    );
    assert_eq!(
        chat.effective_settings.as_deref(),
        Some(r#"{"permission":"ask"}"#)
    );
    let live = f.live().await;
    assert!(matches!(
        live.problem,
        Some(ChatProblem::RuntimeLost { .. })
    ));
    assert_eq!(
        live.settings
            .and_then(|settings| settings.reported.permission)
            .and_then(|permission| permission.current)
            .as_deref(),
        Some("ask")
    );
}

/// A pick made while no session runs is refused when it cannot be saved: the idle Chat
/// keeps showing the mode it would reopen in, never one only memory holds.
#[tokio::test(start_paused = true)]
async fn an_idle_pick_that_cannot_be_saved_is_refused() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(recorded("full")).await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    f.fake.lose_process().await;
    settle().await;

    f.storage_up.store(false, Ordering::SeqCst);
    let picked = f
        .host
        .change_setting(&f.chat.id, SettingKey::Permission, "ask")
        .await
        .unwrap();
    f.storage_up.store(true, Ordering::SeqCst);

    assert!(matches!(
        picked,
        SettingChangeState::Done(SettingOutcome::Refused { .. })
    ));
    let shown = f
        .live()
        .await
        .settings
        .unwrap()
        .reported
        .permission
        .unwrap();
    assert_eq!(shown.current.as_deref(), Some("full"));
}

/// A runtime closed for an explicit resume while a permission change waits for its turn
/// to end: the replacement session opens with that change, saved with the Chat.
#[tokio::test(start_paused = true)]
async fn a_resume_opens_with_a_permission_change_the_closed_runtime_never_answered() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(EventKind::SessionIdentified {
        native_session: NativeSessionId::new("native-1"),
    })
    .await;
    f.emit(recorded("full")).await;
    f.emit(EventKind::SettingsState(settings("full"))).await;
    let held = f
        .host
        .change_setting(&f.chat.id, SettingKey::Permission, "ask")
        .await
        .unwrap();
    assert_eq!(held, SettingChangeState::Held);

    f.host.resume(&f.chat.id, ResumeMode::Native).await.unwrap();

    let reopened = f.fake.opens()[1].clone();
    assert_eq!(reopened.settings.permission.as_deref(), Some("ask"));
    assert_eq!(
        f.core()
            .chat(&f.chat.id)
            .unwrap()
            .effective_settings
            .as_deref(),
        Some(r#"{"permission":"ask"}"#)
    );
}

/// A request refused while an earlier change is still on its way leaves that change
/// tracked: nothing is dispatched until the harness answers it.
#[tokio::test(start_paused = true)]
async fn a_refused_request_keeps_a_change_on_its_way_holding_dispatch() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(EventKind::SettingsState(settings("full"))).await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

    let answer = f.fake.hold_next_setting();
    let sent = f
        .host
        .change_setting(&f.chat.id, SettingKey::Permission, "ask")
        .await
        .unwrap();
    assert_eq!(sent, SettingChangeState::Sent);
    let refused = f
        .host
        .change_setting(&f.chat.id, SettingKey::Permission, "nope")
        .await
        .unwrap();
    assert!(matches!(
        refused,
        SettingChangeState::Done(SettingOutcome::Refused { .. })
    ));
    f.send("second").await;
    assert_eq!(
        written_kinds(&f),
        ["submit", "setting"],
        "the message waits"
    );

    answer.send(SettingOutcome::Applied).unwrap();
    settle().await;
    assert_eq!(written_kinds(&f), ["submit", "setting", "submit"]);
}

/// A record that could not be saved is not shown: the idle Chat keeps showing what its
/// next session will open with, the saved record.
#[tokio::test(start_paused = true)]
async fn an_unsaved_record_is_not_shown_on_the_idle_chat() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(recorded("full")).await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

    f.storage_up.store(false, Ordering::SeqCst);
    f.emit(recorded("ask")).await;
    tokio::time::sleep(Duration::from_secs(60)).await;
    f.storage_up.store(true, Ordering::SeqCst);

    let shown = f
        .live()
        .await
        .settings
        .expect("idle once the harness is stopped");
    assert_eq!(
        shown.reported.permission.and_then(|p| p.current).as_deref(),
        Some("full")
    );
}

/// How a turn ended is stored as a typed fact, one per reason ticketd has to stop a
/// Chat's harness (the Automation reasons are in the runner's tests).
#[tokio::test(start_paused = true)]
async fn a_turn_ticketd_stops_records_why_for_each_reason() {
    let stopped = |reason| Some(TurnEnding::StoppedByTicketd(reason));

    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.host.stop_all(StopReason::Quit).await;
    assert_eq!(f.first_ending(), stopped(StopReason::Quit));

    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.host.turn_off().await;
    assert_eq!(f.first_ending(), stopped(StopReason::TurnedOff));

    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.host.begin_restore().await;
    assert_eq!(f.first_ending(), stopped(StopReason::Restore));

    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.host.trash(&f.chat.id).await.unwrap();
    assert_eq!(f.first_ending(), stopped(StopReason::Trashed));

    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(EventKind::SessionIdentified {
        native_session: NativeSessionId::new("native-1"),
    })
    .await;
    f.host.resume(&f.chat.id, ResumeMode::Native).await.unwrap();
    assert_eq!(f.first_ending(), stopped(StopReason::ExplicitResume));
}

/// The other endings a supervisor records: what the harness reported, what the person
/// did, and contact that was lost.
#[tokio::test(start_paused = true)]
async fn a_turn_records_how_the_harness_or_the_person_ended_it() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    assert_eq!(f.first_ending(), Some(TurnEnding::Completed));

    f.send("second").await;
    f.emit(turn_ended(
        NativeTurnId::new("turn-2"),
        TurnOutcome::Failed(Problem {
            kind: ProblemKind::QuotaExhausted,
            message: "Usage limit reached".to_owned(),
            detail: None,
            resets_at: Some(1_800_000_000),
        }),
    ))
    .await;
    assert_eq!(
        TurnEnding::of(&f.turns()[1]),
        Some(TurnEnding::Failed {
            kind: ProblemKind::QuotaExhausted,
            message: Some("Usage limit reached".to_owned()),
            resets_at: Some(1_800_000_000),
        })
    );

    f.send("third").await;
    f.host.stop(&f.chat.id).await.unwrap();
    f.emit(turn_ended(
        NativeTurnId::new("turn-3"),
        TurnOutcome::Interrupted,
    ))
    .await;
    assert_eq!(
        TurnEnding::of(&f.turns()[2]),
        Some(TurnEnding::StoppedByPerson)
    );

    f.send("fourth").await;
    f.fake.lose_process().await;
    settle().await;
    assert!(matches!(
        TurnEnding::of(&f.turns()[3]),
        Some(TurnEnding::ContactLost(Some(reason))) if reason.starts_with("the harness process ended")
    ));
}

/// What the adapter reported about how a turn ended is read by the supervisor's rules
/// alone, so every harness's turns read the same way and are stored as before.
mod evidence {
    use super::*;
    use ticketd_chat_host::TurnEvidence;

    async fn ended_with(
        evidence: TurnEvidence,
        outcome: TurnOutcome,
    ) -> (Fixture, Option<TurnEnding>) {
        let f = Fixture::new(FakeAdapter::codex());
        f.send("first").await;
        f.emit(EventKind::TurnEvidence {
            turn: turn_1(),
            evidence,
        })
        .await;
        f.emit(turn_ended(turn_1(), outcome)).await;
        let ending = f.first_ending();
        (f, ending)
    }

    fn failed(kind: ProblemKind, message: &str) -> TurnOutcome {
        TurnOutcome::Failed(Problem {
            kind,
            message: message.to_owned(),
            detail: None,
            resets_at: None,
        })
    }

    #[tokio::test(start_paused = true)]
    async fn a_denial_fails_a_turn_the_harness_called_completed_and_names_it() {
        let evidence = TurnEvidence {
            denied: Some("Claude Code was denied: Write.".to_owned()),
            ..TurnEvidence::default()
        };

        let (f, ending) = ended_with(evidence, TurnOutcome::Completed).await;

        assert_eq!(
            ending,
            Some(TurnEnding::Failed {
                kind: ProblemKind::ToolDenied,
                message: Some("Claude Code was denied: Write.".to_owned()),
                resets_at: None,
            })
        );
        assert_eq!(f.turns()[0].state, ChatTurnState::Failed);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failure_after_an_interrupt_was_written_is_a_stop_not_a_failure() {
        let evidence = TurnEvidence {
            interrupt_written: true,
            ..TurnEvidence::default()
        };

        let (f, ending) = ended_with(evidence, failed(ProblemKind::Other, "aborted")).await;

        assert_eq!(ending, Some(TurnEnding::StoppedByPerson));
        assert_eq!(f.turns()[0].state, ChatTurnState::Interrupted);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failure_without_that_evidence_stays_a_failure() {
        let (_, ending) = ended_with(
            TurnEvidence::default(),
            failed(ProblemKind::Other, "it broke"),
        )
        .await;

        assert!(
            matches!(ending, Some(TurnEnding::Failed { .. })),
            "{ending:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn evidence_belongs_to_the_turn_it_names() {
        let f = Fixture::new(FakeAdapter::codex());
        f.send("first").await;
        f.emit(EventKind::TurnEvidence {
            turn: NativeTurnId::new("another-turn"),
            evidence: TurnEvidence {
                denied: Some("Write was denied.".to_owned()),
                ..TurnEvidence::default()
            },
        })
        .await;

        f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

        assert_eq!(f.first_ending(), Some(TurnEnding::Completed));
    }

    #[tokio::test(start_paused = true)]
    async fn a_tool_that_failed_after_an_interrupt_is_stored_unfinished() {
        let f = Fixture::new(FakeAdapter::codex());
        f.send("first").await;
        let tool = |item: &str, status| EventKind::ToolUpdated {
            turn: turn_1(),
            item: NativeItemId::new(item),
            title: "ticketd list".to_owned(),
            status,
            output: None,
            detail: None,
        };

        f.emit(tool("cut", ToolStatus::FailedAfterInterrupt)).await;
        f.emit(tool("broken", ToolStatus::Failed)).await;

        let states: Vec<ChatToolState> = f
            .items()
            .into_iter()
            .filter_map(|item| match item {
                ChatItem::Tool(tool) => Some(tool.state),
                _ => None,
            })
            .collect();
        assert_eq!(states, [ChatToolState::Running, ChatToolState::Failed]);
    }
}

#[tokio::test(start_paused = true)]
async fn a_permission_restart_resumes_the_same_session_before_releasing_the_queue() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    let native_session = NativeSessionId::new("native-1");
    f.emit(EventKind::SessionIdentified {
        native_session: native_session.clone(),
    })
    .await;
    f.emit(recorded("full")).await;
    let mut current = settings("full");
    current.model.as_mut().unwrap().current = Some("gpt-b".to_owned());
    current.effort.as_mut().unwrap().current = Some("high".to_owned());
    f.emit(EventKind::SettingsState(current)).await;

    f.host
        .change_setting(&f.chat.id, SettingKey::Permission, "ask")
        .await
        .unwrap();
    f.queue("second").await;
    let answer = f.fake.hold_next_setting();
    let replacement = f.fake.hold_next_open();
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;
    settle().await;
    answer.send(SettingOutcome::ReopenSession).unwrap();
    settle().await;

    assert_eq!(written_kinds(&f), ["submit", "setting"]);
    assert_eq!(f.queued(), ["second"]);

    replacement.send(()).unwrap();
    settle().await;
    let opens = f.fake.opens();
    assert_eq!(opens.len(), 2);
    assert_eq!(opens[1].session, SessionStart::Resume(native_session));
    assert_ne!(opens[1].generation, opens[0].generation);
    assert_eq!(opens[1].settings.permission.as_deref(), Some("ask"));
    assert_eq!(opens[1].settings.model.as_deref(), Some("gpt-b"));
    assert_eq!(opens[1].settings.effort.as_deref(), Some("high"));
    assert_eq!(written_kinds(&f), ["submit", "setting", "submit"]);
}

#[tokio::test(start_paused = true)]
async fn a_permission_restart_without_a_native_session_retires_the_old_runtime() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    f.emit(recorded("full")).await;
    f.emit(EventKind::SettingsState(settings("full"))).await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

    let answer = f.fake.hold_next_setting();
    f.host
        .change_setting(&f.chat.id, SettingKey::Permission, "ask")
        .await
        .unwrap();
    f.emit(EventKind::InteractionRequested(InteractionRequest {
        request: NativeRequestId::new("late-approval"),
        turn: Some(turn_1()),
        item: None,
        kind: InteractionKind::Approval {
            description: "Approve the old runtime's request".to_owned(),
            reason: None,
            decisions: vec![ApprovalDecision::Allow],
        },
        detail: None,
    }))
    .await;
    let interaction = f.live().await.interactions[0].interaction_id.clone();

    answer.send(SettingOutcome::ReopenSession).unwrap();
    settle().await;

    f.send("second").await;
    assert_eq!(f.submits().len(), 1);
    assert_eq!(f.queued(), ["second"]);
    assert!(f.core().chat(&f.chat.id).unwrap().queue_paused);
    assert!(!f.live().await.running);
    assert_eq!(f.fake.opens().len(), 1);
    let response = f
        .host
        .respond(
            &f.chat.id,
            &interaction,
            InteractionAnswer::Approval(ApprovalDecision::Allow),
        )
        .await;
    assert!(matches!(response, Err(HostError::InteractionExpired)));
    assert_eq!(f.fake.respond_calls(), 0);

    f.host
        .resume(
            &f.chat.id,
            ResumeMode::FreshSession {
                history: String::new(),
            },
        )
        .await
        .unwrap();
    let opens = f.fake.opens();
    assert_eq!(opens[1].session, SessionStart::New);
    assert_eq!(opens[1].settings.permission.as_deref(), Some("ask"));
    f.host.resume_queue(&f.chat.id).await.unwrap();
    settle().await;
    let submits = f.submits();
    assert_eq!(submits[1].text, "second");
    assert_eq!(submits[1].generation, opens[1].generation);
}

#[tokio::test(start_paused = true)]
async fn a_permission_restart_after_storage_loss_uses_the_selected_mode_on_retry() {
    let f = Fixture::new(FakeAdapter::codex());
    f.send("first").await;
    let native_session = NativeSessionId::new("native-1");
    f.emit(EventKind::SessionIdentified {
        native_session: native_session.clone(),
    })
    .await;
    f.emit(recorded("full")).await;
    f.emit(EventKind::SettingsState(settings("full"))).await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

    let answer = f.fake.hold_next_setting();
    f.host
        .change_setting(&f.chat.id, SettingKey::Permission, "ask")
        .await
        .unwrap();
    f.queue("next").await;
    f.storage_up.store(false, Ordering::SeqCst);
    answer.send(SettingOutcome::ReopenSession).unwrap();
    settle().await;

    let original = f.fake.opens()[0].generation;
    assert!(f.fake.written().contains(&Written::Close(original)));
    assert_eq!(f.submits().len(), 1);

    f.storage_up.store(true, Ordering::SeqCst);
    f.host.resume_queue(&f.chat.id).await.unwrap();
    settle().await;
    let opens = f.fake.opens();
    assert_eq!(opens[1].session, SessionStart::Resume(native_session));
    assert_eq!(opens[1].settings.permission.as_deref(), Some("ask"));
    let submits = f.submits();
    assert_eq!(submits[1].text, "next");
    assert_eq!(submits[1].generation, opens[1].generation);
    assert_eq!(
        f.core()
            .chat(&f.chat.id)
            .unwrap()
            .effective_settings
            .as_deref(),
        Some(r#"{"permission":"ask"}"#)
    );
}

#[tokio::test(start_paused = true)]
async fn a_permission_restart_retry_keeps_waiting_for_the_same_native_session() {
    let f = Fixture::new(FakeAdapter::new(
        &ticketd_core::harnesses::ANTIGRAVITY,
        Capabilities {
            steering: Capability::Unsupported {
                reason: String::new(),
            },
        },
    ));
    f.send("first").await;
    let native_session = NativeSessionId::new("native-1");
    f.emit(EventKind::SessionIdentified {
        native_session: native_session.clone(),
    })
    .await;
    f.emit(recorded("full")).await;
    f.emit(EventKind::SettingsState(settings("full"))).await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

    let answer = f.fake.hold_next_setting();
    f.host
        .change_setting(&f.chat.id, SettingKey::Permission, "ask")
        .await
        .unwrap();
    assert_eq!(
        f.host
            .change_setting(&f.chat.id, SettingKey::Model, "gpt-b")
            .await
            .unwrap(),
        SettingChangeState::Held
    );
    assert_eq!(
        f.host
            .change_setting(&f.chat.id, SettingKey::Effort, "high")
            .await
            .unwrap(),
        SettingChangeState::Held
    );
    f.queue("next").await;
    let missing_history = Problem {
        kind: ProblemKind::NativeHistoryUnavailable,
        message: "the session is missing".to_owned(),
        detail: None,
        resets_at: None,
    };
    f.fake.fail_next_open(missing_history.clone());
    answer.send(SettingOutcome::ReopenSession).unwrap();
    settle().await;
    assert!(f.core().chat(&f.chat.id).unwrap().queue_paused);

    f.fake.fail_next_open(missing_history.clone());
    f.host.resume_queue(&f.chat.id).await.unwrap();
    settle().await;
    assert_eq!(f.fake.opens().len(), 1);
    assert_eq!(f.submits().len(), 1);
    assert_eq!(f.queued(), ["next"]);
    assert!(f.core().chat(&f.chat.id).unwrap().queue_paused);

    f.fake.fail_next_open(missing_history.clone());
    let requested = f.host.resume(&f.chat.id, ResumeMode::Native).await;
    assert!(matches!(requested, Err(HostError::Harness(problem)) if problem == missing_history));

    f.host.resume_queue(&f.chat.id).await.unwrap();
    settle().await;
    let opens = f.fake.opens();
    assert_eq!(opens[1].session, SessionStart::Resume(native_session));
    assert_eq!(opens[1].settings.permission.as_deref(), Some("ask"));
    assert_eq!(opens[1].settings.model.as_deref(), Some("gpt-b"));
    assert_eq!(opens[1].settings.effort.as_deref(), Some("high"));
    let submits = f.submits();
    assert_eq!(submits[1].text, "next");
    assert_eq!(submits[1].generation, opens[1].generation);
}

#[tokio::test(start_paused = true)]
async fn native_only_recovery_opens_an_empty_session_when_native_history_is_missing() {
    let f = Fixture::new(FakeAdapter::new(
        &ticketd_core::harnesses::ANTIGRAVITY,
        Capabilities {
            steering: Capability::Unsupported {
                reason: String::new(),
            },
        },
    ));
    f.send("prior input").await;
    f.emit(EventKind::SessionIdentified {
        native_session: NativeSessionId::new("native-1"),
    })
    .await;
    f.emit(turn_ended(turn_1(), TurnOutcome::Completed)).await;

    let replay = f
        .host
        .resume(
            &f.chat.id,
            ResumeMode::FreshSession {
                history: "prior input".to_owned(),
            },
        )
        .await;
    assert!(matches!(replay, Err(HostError::Core(Error::Chat(_)))));
    f.fake.fail_next_open(Problem {
        kind: ProblemKind::NativeHistoryUnavailable,
        message: "the session is missing".to_owned(),
        detail: None,
        resets_at: None,
    });
    f.host.resume(&f.chat.id, ResumeMode::Native).await.unwrap();
    let opened = f.fake.opens();
    assert_eq!(opened.len(), 2);
    assert_eq!(opened[1].session, SessionStart::New);
    assert_eq!(f.submits().len(), 1);

    f.send("next input").await;
    let submits = f.submits();
    let texts = submits
        .iter()
        .map(|submission| submission.text.as_str())
        .collect::<Vec<_>>();
    assert_eq!(texts, ["prior input", "next input"]);
}
