//! One conformance suite for every harness adapter: the fake, the Claude bridge
//! transport, Codex and Antigravity run the same properties against the adapter
//! contract, each through its own scripted provider.
//!
//! A [`Provider`] is the provider's side of one open runtime: it knows how its
//! protocol shows a silent harness, a refusal that comes late, a dead process or a
//! live approval, and plays that traffic when a property asks. The properties are
//! written once, here, and assert only what the contract promises. What an adapter
//! legitimately does differently is declared by the provider, not tolerated by the
//! property: how a harness answers a new turn is [`NewTurn`].
//!
//! The adapters' own tests keep what is specific to their protocol.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use crate::testing::FakeAdapter;
use crate::{
    ApprovalDecision, DeliveryEvidence, DispatchOutcome, EventKind, EventStream, HarnessAdapter,
    HarnessRuntime, InteractionAnswer, InteractionResolution, InteractionResponse,
    InterruptOutcome, InterruptRequest, NativeRequestId, NativeTurnId, OpenRequest, Refusal,
    RespondOutcome, RuntimeGeneration, SessionStart, StartSettings, Submission, SubmissionId,
    SubmissionKind,
};

/// The generation every provider opens its runtime with.
pub(crate) const GENERATION: RuntimeGeneration = RuntimeGeneration(7);

/// How a harness answers a new turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NewTurn {
    /// The reply to the input names the turn it started (Codex).
    Acknowledged,
    /// The harness takes the input without naming a turn. The turn is known when the
    /// harness shows it processing the input (Claude Code).
    WrittenThenProcessing,
}

/// How a harness shows what a sub-agent does while no turn runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubAgentFrames {
    /// The adapter tells a sub-agent's activity apart from the turn's: a sub-agent that
    /// starts, works and ends while no turn runs opens no turn (Claude Code).
    Separate,
    /// The adapter does not model sub-agents yet (Codex until its sub-agent ticket,
    /// Antigravity until its own, and the fake): the property asserts nothing for it, and
    /// moves to `Separate` when the adapter does.
    NotModelled,
}

/// Whether the adapter tells a sub-agent's approval apart from the turn it arrives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubAgentApprovals {
    /// The request names the sub-agent that asked, belongs to no turn, and goes only when
    /// that sub-agent's run ends (Claude Code, Codex).
    Owned,
    /// The adapter does not model sub-agents' approvals yet (Antigravity until its own
    /// ticket, and the fake): the properties assert nothing for it.
    NotModelled,
}

/// The request every provider opens its runtime with.
pub(crate) fn open_request() -> OpenRequest {
    OpenRequest {
        generation: GENERATION,
        chat_id: "chat-1".into(),
        working_directory: PathBuf::from("/work/chat-1"),
        session: SessionStart::New,
        unattended: None,
        ticketd_cli: None,
        taken_over: false,
        recorded_settings: None,
        settings: StartSettings::default(),
    }
}

pub(crate) fn start_turn(id: &str) -> Submission {
    Submission {
        submission: SubmissionId::new(id),
        generation: GENERATION,
        kind: SubmissionKind::StartTurn,
        text: "hello".to_owned(),
        attachments: Vec::new(),
    }
}

pub(crate) fn allow(
    request: &NativeRequestId,
    generation: RuntimeGeneration,
) -> InteractionResponse {
    InteractionResponse {
        generation,
        request: request.clone(),
        answer: InteractionAnswer::Approval(ApprovalDecision::Allow),
    }
}

/// The provider's side of one open runtime.
#[async_trait]
pub(crate) trait Provider: Send {
    fn new_turn(&self) -> NewTurn;

    /// What a lost process reports: its exit code, and the end of its diagnostics.
    fn loss(&self) -> (Option<i32>, &'static str);

    fn loss_dispatch(&self) -> DispatchOutcome {
        DispatchOutcome::UnknownAfterLoss
    }

    fn approval_answer(
        &self,
        request: &NativeRequestId,
        generation: RuntimeGeneration,
    ) -> InteractionResponse {
        allow(request, generation)
    }

    fn runtime(&self) -> Arc<dyn HarnessRuntime>;

    fn events(&mut self) -> &mut EventStream;

    /// What the adapter does with a sub-agent's frames while no turn runs.
    fn sub_agent_frames(&self) -> SubAgentFrames {
        SubAgentFrames::NotModelled
    }

    /// Plays a sub-agent that starts, runs a tool and ends while no turn runs. Only called
    /// for a provider that declares [`SubAgentFrames::Separate`].
    async fn play_sub_agent_at_rest(&mut self) {
        unimplemented!("declared SubAgentFrames::Separate without playing a sub-agent")
    }

    /// Whether the adapter keeps a sub-agent's approval apart from the turn it arrived in.
    fn sub_agent_approvals(&self) -> SubAgentApprovals {
        SubAgentApprovals::NotModelled
    }

    /// While the turn the submission `id` started runs, a sub-agent starts and asks for
    /// approval of a command. Only called for a provider that declares
    /// [`SubAgentApprovals::Owned`]; returns the request.
    async fn play_sub_agent_approval(&mut self, _id: &str) -> NativeRequestId {
        unimplemented!("declared SubAgentApprovals::Owned without playing a request")
    }

    /// The main agent's turn (the one `play_sub_agent_approval` ran in) ends, and the
    /// sub-agent goes on.
    async fn end_parent_turn(&mut self, _id: &str) {
        unimplemented!("declared SubAgentApprovals::Owned without ending the turn")
    }

    /// The sub-agent's run ends without its request having been answered.
    async fn end_sub_agent(&mut self) {
        unimplemented!("declared SubAgentApprovals::Owned without ending the sub-agent")
    }

    /// Submits a new turn and plays the provider's usual reply to it.
    async fn start_turn(&mut self, id: &str) -> DispatchOutcome;

    /// After a [`NewTurn::WrittenThenProcessing`] start: the harness shows the input
    /// being processed. Returns the turn it names.
    async fn show_processing(&mut self, id: &str) -> NativeTurnId;

    /// Submits a new turn that the provider never answers in time.
    async fn submit_unanswered(&mut self, id: &str) -> DispatchOutcome;

    /// The provider refuses an input whose reply the adapter stopped waiting for.
    async fn refuse_late(&mut self, id: &str);

    /// Submits a new turn and kills the provider process once it is written.
    async fn submit_and_lose_process(&mut self, id: &str) -> DispatchOutcome;

    /// The provider asks for approval of a command.
    async fn request_approval(&mut self) -> NativeRequestId;

    /// Answers a request, with the provider reading the answer from the wire.
    async fn respond(&mut self, response: InteractionResponse) -> RespondOutcome;

    /// Proves the provider received nothing beyond what the property's steps wrote.
    async fn assert_nothing_else_written(&mut self);
}

/// Everything the runtime's stream holds once the provider has been idle.
pub(crate) async fn drain(events: &mut EventStream) -> Vec<EventKind> {
    tokio::time::sleep(Duration::from_millis(1)).await;
    let mut kinds = Vec::new();
    while let Ok(event) = events.try_recv() {
        assert_eq!(event.generation, GENERATION);
        kinds.push(event.kind);
    }
    kinds
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

async fn a_command_from_another_generation_is_refused_before_any_write(p: &mut dyn Provider) {
    let runtime = p.runtime();
    let old = RuntimeGeneration(6);
    let stale = Refusal::StaleGeneration {
        current: GENERATION,
    };

    let submitted = runtime
        .submit(Submission {
            generation: old,
            ..start_turn("s1")
        })
        .await;
    let responded = runtime
        .respond(allow(&NativeRequestId::new("any"), old))
        .await;
    let interrupted = runtime
        .interrupt(InterruptRequest {
            generation: old,
            expected_turn: NativeTurnId::new("any"),
        })
        .await;

    assert_eq!(submitted, DispatchOutcome::NotSent(stale.clone()));
    assert_eq!(responded, RespondOutcome::NotSent(stale.clone()));
    assert_eq!(interrupted, InterruptOutcome::NotSent(stale));
    p.assert_nothing_else_written().await;
}

async fn commands_naming_nothing_live_are_refused_before_any_write(p: &mut dyn Provider) {
    let runtime = p.runtime();

    let responded = runtime
        .respond(allow(&NativeRequestId::new("never-asked"), GENERATION))
        .await;
    let interrupted = runtime
        .interrupt(InterruptRequest {
            generation: GENERATION,
            expected_turn: NativeTurnId::new("no-turn"),
        })
        .await;

    assert_eq!(responded, RespondOutcome::NotSent(Refusal::UnknownRequest));
    assert_eq!(
        interrupted,
        InterruptOutcome::NotSent(Refusal::TurnMismatch { active: None })
    );
    p.assert_nothing_else_written().await;
}

async fn losing_the_process_after_the_write_leaves_the_submission_unknown(p: &mut dyn Provider) {
    let runtime = p.runtime();

    let outcome = p.submit_and_lose_process("s1").await;

    assert_eq!(outcome, p.loss_dispatch());
    let lost = drain(p.events()).await;
    let (expected_code, expected_tail) = p.loss();
    let [
        EventKind::RuntimeLost {
            exit_code,
            diagnostics,
        },
    ] = lost.as_slice()
    else {
        panic!("only the loss, got {lost:?}");
    };
    assert_eq!(*exit_code, expected_code);
    assert!(diagnostics.ends_with(expected_tail), "{diagnostics}");
    assert_eq!(p.events().recv().await, None, "nothing follows the loss");

    let closed = Refusal::RuntimeClosed;
    let submitted = runtime.submit(start_turn("s2")).await;
    let responded = runtime
        .respond(allow(&NativeRequestId::new("any"), GENERATION))
        .await;
    let interrupted = runtime
        .interrupt(InterruptRequest {
            generation: GENERATION,
            expected_turn: NativeTurnId::new("any"),
        })
        .await;
    assert_eq!(submitted, DispatchOutcome::NotSent(closed.clone()));
    assert_eq!(responded, RespondOutcome::NotSent(closed.clone()));
    assert_eq!(interrupted, InterruptOutcome::NotSent(closed));
}

async fn evidence_arriving_after_a_timeout_settles_the_written_submission(p: &mut dyn Provider) {
    let outcome = p.submit_unanswered("s1").await;
    assert_eq!(outcome, DispatchOutcome::Written);
    assert!(drain(p.events()).await.is_empty());

    p.refuse_late("s1").await;

    let late = drain(p.events()).await;
    assert!(
        matches!(
            late.as_slice(),
            [EventKind::SubmissionEvidence {
                submission,
                evidence: DeliveryEvidence::Rejected { .. },
            }] if *submission == SubmissionId::new("s1")
        ),
        "late evidence for the written submission, got {late:?}"
    );
    // Nothing was sent again because of it.
    p.assert_nothing_else_written().await;
}

async fn each_request_accepts_one_answer_from_its_own_generation(p: &mut dyn Provider) {
    let runtime = p.runtime();
    let request = p.request_approval().await;

    let stale = runtime
        .respond(p.approval_answer(&request, RuntimeGeneration(6)))
        .await;
    let answer = p.approval_answer(&request, GENERATION);
    let first = p.respond(answer.clone()).await;
    let repeated = p.respond(answer).await;

    assert_eq!(
        stale,
        RespondOutcome::NotSent(Refusal::StaleGeneration {
            current: GENERATION
        }),
        "a stale answer does not use up the request"
    );
    assert_eq!(first, RespondOutcome::Sent);
    assert_eq!(repeated, RespondOutcome::NotSent(Refusal::UnknownRequest));
    p.assert_nothing_else_written().await;
}

async fn a_new_turn_is_acknowledged_as_the_adapter_declares(p: &mut dyn Provider) {
    let runtime = p.runtime();

    let outcome = p.start_turn("s1").await;

    let turn = match (p.new_turn(), outcome) {
        (NewTurn::Acknowledged, DispatchOutcome::Acknowledged { turn }) => turn,
        (NewTurn::WrittenThenProcessing, DispatchOutcome::Written) => {
            assert!(
                drain(p.events()).await.is_empty(),
                "a written input names no turn"
            );
            p.show_processing("s1").await
        }
        (declared, outcome) => panic!("declared {declared:?}, got {outcome:?}"),
    };

    // Either way the turn is now known, and one turn runs at a time.
    assert_eq!(
        runtime.submit(start_turn("s2")).await,
        DispatchOutcome::NotSent(Refusal::TurnMismatch { active: Some(turn) })
    );
    p.assert_nothing_else_written().await;
}

/// A sub-agent's frames never open a turn, whichever harness it is: with no turn running,
/// a sub-agent that starts, works and ends shows as sub-agent events, and no turn starts
/// or ends and no text or request is made up for the main agent. Only the main agent's own
/// output can open a turn.
async fn a_sub_agents_frames_never_open_a_turn(p: &mut dyn Provider) {
    if p.sub_agent_frames() == SubAgentFrames::NotModelled {
        return;
    }
    p.play_sub_agent_at_rest().await;

    let shown = drain(p.events()).await;
    assert!(
        shown
            .iter()
            .any(|event| matches!(event, EventKind::SubAgentStarted(_))),
        "the sub-agent is shown: {shown:?}"
    );
    let opened = shown.iter().find(|event| {
        matches!(
            event,
            EventKind::TurnStarted { .. }
                | EventKind::TurnEnded { .. }
                | EventKind::TextDelta { .. }
                | EventKind::MessageCompleted { .. }
                | EventKind::ToolUpdated { .. }
                | EventKind::SubmissionEvidence { .. }
        )
    });
    assert!(
        opened.is_none(),
        "a sub-agent's frames opened or ended a turn: {opened:?} in {shown:?}"
    );
    p.assert_nothing_else_written().await;
}

/// Starts a turn and plays a sub-agent's approval in it; returns the request the adapter
/// reported, which is the sub-agent's and no turn's.
async fn a_sub_agent_asks_in_a_turn(p: &mut dyn Provider) -> NativeRequestId {
    let outcome = p.start_turn("s1").await;
    match (p.new_turn(), outcome) {
        (NewTurn::Acknowledged, DispatchOutcome::Acknowledged { .. }) => {}
        (NewTurn::WrittenThenProcessing, DispatchOutcome::Written) => {
            p.show_processing("s1").await;
        }
        (declared, outcome) => panic!("declared {declared:?}, got {outcome:?}"),
    }
    drain(p.events()).await;
    p.play_sub_agent_approval("s1").await
}

/// A sub-agent's approval is its own: it names the sub-agent, belongs to no turn, and is
/// still there, and still answerable, after the main agent's turn has ended.
async fn a_sub_agents_approval_outlives_the_parents_turn(p: &mut dyn Provider) {
    if p.sub_agent_approvals() == SubAgentApprovals::NotModelled {
        return;
    }
    let request = a_sub_agent_asks_in_a_turn(p).await;

    p.end_parent_turn("s1").await;
    let ended = drain(p.events()).await;
    assert!(
        ended
            .iter()
            .any(|event| matches!(event, EventKind::TurnEnded { .. })),
        "the turn ended: {ended:?}"
    );
    assert!(
        !ended
            .iter()
            .any(|event| matches!(event, EventKind::InteractionResolved { .. })),
        "the sub-agent's request went with the turn: {ended:?}"
    );

    // Still answerable, and the answer is the one the harness reads.
    let answered = p.respond(p.approval_answer(&request, GENERATION)).await;
    assert_eq!(answered, RespondOutcome::Sent);
    p.assert_nothing_else_written().await;
}

/// The request goes when its asker's run ends, and not before: nothing more can be
/// answered then.
async fn a_sub_agents_approval_goes_with_its_asker(p: &mut dyn Provider) {
    if p.sub_agent_approvals() == SubAgentApprovals::NotModelled {
        return;
    }
    let request = a_sub_agent_asks_in_a_turn(p).await;

    p.end_sub_agent().await;
    let ended = drain(p.events()).await;
    let withdrawn = ended.iter().position(|event| {
        matches!(
            event,
            EventKind::InteractionResolved {
                request: gone,
                resolution: InteractionResolution::Withdrawn,
            } if *gone == request
        )
    });
    let sub_agent_ended = ended
        .iter()
        .position(|event| matches!(event, EventKind::SubAgentEnded { .. }));
    assert!(
        withdrawn.is_some() && sub_agent_ended.is_some() && withdrawn < sub_agent_ended,
        "its end withdraws what it asked, first: {ended:?}"
    );
    assert!(
        !ended
            .iter()
            .any(|event| matches!(event, EventKind::TurnEnded { .. })),
        "the sub-agent's end is not the turn's: {ended:?}"
    );
    let answered = p.respond(p.approval_answer(&request, GENERATION)).await;
    assert_eq!(answered, RespondOutcome::NotSent(Refusal::UnknownRequest));
    p.assert_nothing_else_written().await;
}

// ---------------------------------------------------------------------------
// Providers and the suite's cases
// ---------------------------------------------------------------------------

/// The fake adapter, driven through the same contract.
struct FakeProvider {
    fake: FakeAdapter,
    runtime: Arc<dyn HarnessRuntime>,
    events: EventStream,
    new_turn: NewTurn,
    /// Commands the properties' steps meant to write.
    written: usize,
}

async fn fake_provider(fake: FakeAdapter, new_turn: NewTurn) -> Box<dyn Provider> {
    let opened = fake.open(open_request()).await.expect("the fake opens");
    Box::new(FakeProvider {
        fake,
        runtime: opened.runtime,
        events: opened.events,
        new_turn,
        written: 0,
    })
}

#[async_trait]
impl Provider for FakeProvider {
    fn new_turn(&self) -> NewTurn {
        self.new_turn
    }

    fn loss(&self) -> (Option<i32>, &'static str) {
        (None, "fake process lost")
    }

    fn runtime(&self) -> Arc<dyn HarnessRuntime> {
        Arc::clone(&self.runtime)
    }

    fn events(&mut self) -> &mut EventStream {
        &mut self.events
    }

    async fn start_turn(&mut self, id: &str) -> DispatchOutcome {
        self.written += 1;
        self.runtime.submit(start_turn(id)).await
    }

    async fn show_processing(&mut self, id: &str) -> NativeTurnId {
        let turn = NativeTurnId::new("turn-1");
        assert!(
            self.fake
                .emit(EventKind::TurnStarted {
                    turn: turn.clone(),
                    origin: None
                })
                .await
        );
        assert!(
            self.fake
                .emit(EventKind::SubmissionEvidence {
                    submission: SubmissionId::new(id),
                    evidence: DeliveryEvidence::Processing { turn: turn.clone() },
                })
                .await
        );
        drain(&mut self.events).await;
        turn
    }

    async fn submit_unanswered(&mut self, id: &str) -> DispatchOutcome {
        self.fake
            .script_submit(crate::testing::SubmitReply::Timeout);
        self.written += 1;
        self.runtime.submit(start_turn(id)).await
    }

    async fn refuse_late(&mut self, id: &str) {
        assert!(
            self.fake
                .emit(EventKind::SubmissionEvidence {
                    submission: SubmissionId::new(id),
                    evidence: DeliveryEvidence::Rejected {
                        reason: "refused".to_owned(),
                    },
                })
                .await
        );
    }

    async fn submit_and_lose_process(&mut self, id: &str) -> DispatchOutcome {
        self.fake
            .script_submit(crate::testing::SubmitReply::LoseProcess);
        self.runtime.submit(start_turn(id)).await
    }

    async fn request_approval(&mut self) -> NativeRequestId {
        let request = NativeRequestId::new("approval-1");
        assert!(
            self.fake
                .emit(EventKind::InteractionRequested(crate::InteractionRequest {
                    request: request.clone(),
                    turn: None,
                    owner: None,
                    item: None,
                    kind: crate::InteractionKind::Approval {
                        description: "Run cargo test".to_owned(),
                        reason: None,
                        decisions: vec![ApprovalDecision::Allow, ApprovalDecision::Deny],
                    },
                    detail: None,
                }))
                .await
        );
        drain(&mut self.events).await;
        request
    }

    async fn respond(&mut self, response: InteractionResponse) -> RespondOutcome {
        let outcome = self.runtime.respond(response).await;
        if outcome == RespondOutcome::Sent {
            self.written += 1;
        }
        outcome
    }

    async fn assert_nothing_else_written(&mut self) {
        assert_eq!(self.fake.written().len(), self.written);
    }
}

macro_rules! conformance {
    ($adapter:ident, $provider:expr) => {
        mod $adapter {
            #[tokio::test(start_paused = true)]
            async fn a_command_from_another_generation_is_refused_before_any_write() {
                let mut p = $provider.await;
                super::a_command_from_another_generation_is_refused_before_any_write(&mut *p).await;
            }

            #[tokio::test(start_paused = true)]
            async fn commands_naming_nothing_live_are_refused_before_any_write() {
                let mut p = $provider.await;
                super::commands_naming_nothing_live_are_refused_before_any_write(&mut *p).await;
            }

            #[tokio::test(start_paused = true)]
            async fn losing_the_process_after_the_write_leaves_the_submission_unknown() {
                let mut p = $provider.await;
                super::losing_the_process_after_the_write_leaves_the_submission_unknown(&mut *p)
                    .await;
            }

            #[tokio::test(start_paused = true)]
            async fn evidence_arriving_after_a_timeout_settles_the_written_submission() {
                let mut p = $provider.await;
                super::evidence_arriving_after_a_timeout_settles_the_written_submission(&mut *p)
                    .await;
            }

            #[tokio::test(start_paused = true)]
            async fn each_request_accepts_one_answer_from_its_own_generation() {
                let mut p = $provider.await;
                super::each_request_accepts_one_answer_from_its_own_generation(&mut *p).await;
            }

            #[tokio::test(start_paused = true)]
            async fn a_sub_agents_frames_never_open_a_turn() {
                let mut p = $provider.await;
                super::a_sub_agents_frames_never_open_a_turn(&mut *p).await;
            }

            #[tokio::test(start_paused = true)]
            async fn a_sub_agents_approval_outlives_the_parents_turn() {
                let mut p = $provider.await;
                super::a_sub_agents_approval_outlives_the_parents_turn(&mut *p).await;
            }

            #[tokio::test(start_paused = true)]
            async fn a_sub_agents_approval_goes_with_its_asker() {
                let mut p = $provider.await;
                super::a_sub_agents_approval_goes_with_its_asker(&mut *p).await;
            }

            #[tokio::test(start_paused = true)]
            async fn a_new_turn_is_acknowledged_as_the_adapter_declares() {
                let mut p = $provider.await;
                super::a_new_turn_is_acknowledged_as_the_adapter_declares(&mut *p).await;
            }
        }
    };
}

conformance!(
    fake_codex,
    super::fake_provider(super::FakeAdapter::codex(), super::NewTurn::Acknowledged)
);
conformance!(
    fake_claude,
    super::fake_provider(
        super::FakeAdapter::claude(),
        super::NewTurn::WrittenThenProcessing
    )
);
conformance!(claude, crate::claude::tests::provider());
conformance!(codex, crate::codex::tests::provider());
conformance!(antigravity, crate::antigravity::tests::provider());
