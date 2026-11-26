//! What the fake adapter does beyond the properties every adapter shares (see the
//! conformance suite in `src/conformance.rs`), which the supervisor's tests rely on.
#![allow(clippy::unwrap_used, clippy::panic)] // test setup and assertions

use std::path::PathBuf;

use ticketd_chat_host::testing::{FakeAdapter, SubmitReply, Written};
use ticketd_chat_host::{
    DispatchOutcome, EventKind, HarnessAdapter, NativeTurnId, OpenRequest, OpenedRuntime, Refusal,
    RuntimeGeneration, SessionStart, StartSettings, Submission, SubmissionId, SubmissionKind,
    TurnOutcome,
};

const GENERATION: RuntimeGeneration = RuntimeGeneration(1);

async fn open(fake: &FakeAdapter, generation: RuntimeGeneration) -> OpenedRuntime {
    fake.open(OpenRequest {
        generation,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("chat-folder"),
        session: SessionStart::New,
        unattended: None,
        ticketd_cli: None,
        taken_over: false,
        recorded_settings: None,
        settings: StartSettings::default(),
    })
    .await
    .unwrap()
}

fn start(id: &str, generation: RuntimeGeneration) -> Submission {
    Submission {
        submission: SubmissionId::new(id),
        generation,
        kind: SubmissionKind::StartTurn,
        text: "hello".to_owned(),
        attachments: Vec::new(),
    }
}

fn steer(id: &str, expected_turn: &NativeTurnId) -> Submission {
    Submission {
        kind: SubmissionKind::Steer {
            expected_turn: expected_turn.clone(),
        },
        ..start(id, GENERATION)
    }
}

async fn acknowledged_turn(opened: &OpenedRuntime, id: &str) -> NativeTurnId {
    match opened.runtime.submit(start(id, GENERATION)).await {
        DispatchOutcome::Acknowledged { turn } => turn,
        other => panic!("expected acknowledgment, got {other:?}"),
    }
}

#[tokio::test]
async fn acknowledgment_names_the_turn_and_completion_arrives_separately() {
    let fake = FakeAdapter::codex();
    let mut opened = open(&fake, GENERATION).await;

    let turn = acknowledged_turn(&opened, "s1").await;
    assert!(
        opened.events.try_recv().is_err(),
        "no outcome before the harness reports one"
    );

    let ended = EventKind::TurnEnded {
        turn,
        outcome: TurnOutcome::Completed,
        submissions: vec![SubmissionId::new("s1")],
    };
    assert!(fake.emit(ended.clone()).await);
    let event = opened.events.recv().await.unwrap();
    assert_eq!((event.generation, event.kind), (GENERATION, ended));
}

#[tokio::test]
async fn an_explicit_rejection_is_distinct_from_a_local_refusal() {
    let fake = FakeAdapter::codex();
    let opened = open(&fake, GENERATION).await;
    fake.script_submit(SubmitReply::Reject("thread is archived".to_owned()));

    assert_eq!(
        opened.runtime.submit(start("s1", GENERATION)).await,
        DispatchOutcome::Rejected {
            reason: "thread is archived".to_owned()
        }
    );
    assert_eq!(
        fake.written(),
        vec![Written::Submit(start("s1", GENERATION))]
    );
}

#[tokio::test]
async fn a_reply_delayed_past_process_loss_does_not_become_an_acknowledgment() {
    let fake = FakeAdapter::codex();
    let opened = open(&fake, GENERATION).await;
    let reply = fake.hold_next_submit();
    let runtime = opened.runtime.clone();
    let pending = tokio::spawn(async move { runtime.submit(start("s1", GENERATION)).await });
    while fake.written().is_empty() {
        tokio::task::yield_now().await;
    }

    fake.lose_process().await;
    reply.send(SubmitReply::Acknowledge).unwrap();

    assert_eq!(pending.await.unwrap(), DispatchOutcome::UnknownAfterLoss);
}

#[tokio::test]
async fn steering_a_turn_that_already_ended_is_known_not_sent() {
    let fake = FakeAdapter::codex();
    let mut opened = open(&fake, GENERATION).await;
    let turn = acknowledged_turn(&opened, "s1").await;
    assert_eq!(
        opened.runtime.submit(steer("s2", &turn)).await,
        DispatchOutcome::Acknowledged { turn: turn.clone() }
    );

    fake.emit(EventKind::TurnEnded {
        turn: turn.clone(),
        outcome: TurnOutcome::Interrupted,
        submissions: vec![],
    })
    .await;
    opened.events.recv().await.unwrap();

    assert_eq!(
        opened.runtime.submit(steer("s3", &turn)).await,
        DispatchOutcome::NotSent(Refusal::TurnMismatch { active: None })
    );
}

#[tokio::test]
async fn steering_is_refused_when_the_harness_does_not_support_it() {
    let fake = FakeAdapter::without_steering();
    let opened = open(&fake, GENERATION).await;
    let turn = acknowledged_turn(&opened, "s1").await;

    assert_eq!(
        opened.runtime.submit(steer("s2", &turn)).await,
        DispatchOutcome::NotSent(Refusal::Unsupported)
    );
}

#[tokio::test]
async fn a_replaced_runtime_refuses_commands_for_its_own_generation() {
    let fake = FakeAdapter::codex();
    let old = open(&fake, GENERATION).await;
    let _replacement = open(&fake, RuntimeGeneration(2)).await;

    assert_eq!(
        old.runtime.submit(start("s1", GENERATION)).await,
        DispatchOutcome::NotSent(Refusal::RuntimeClosed)
    );
}
