//! A scriptable adapter for tests of the supervisor and of anything above it.
//!
//! The fake enforces the contract's local checks (generation, expected turn, live
//! request, capability) itself. Tests script what the "harness" then does: reply,
//! reject, stay silent, die, or reply late, and emit events at any point.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use tokio::sync::{mpsc, oneshot, watch};

use crate::runtime::RuntimeState;
use crate::{
    Capabilities, Capability, CloseOutcome, DispatchOutcome, EVENT_BUFFER, EventKind, Harness,
    HarnessAdapter, HarnessOptions, HarnessRuntime, Inspection, InteractionResponse,
    InterruptOutcome, InterruptRequest, LoginState, NativeTurnId, OpenRequest, OpenedRuntime,
    Problem, Refusal, RespondOutcome, RuntimeEvent, RuntimeGeneration, SettingChange,
    SettingOutcome, SteeringBehavior, Submission, SubmissionKind,
};

/// What the fake harness does with a submission after it was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmitReply {
    /// Acknowledge it. A new turn becomes active; steering names the steered turn. A
    /// [`FakeAdapter::claude`] does not acknowledge a new turn: `submit` returns
    /// `Written` and the turn is known only once the test emits its events.
    Acknowledge,
    Reject(String),
    /// Never reply: `submit` returns `Written`. Emit evidence later with
    /// [`FakeAdapter::emit`].
    Timeout,
    /// The process dies before replying.
    LoseProcess,
}

/// A command that passed the local checks and reached the fake harness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Written {
    Submit(Submission),
    Respond(InteractionResponse),
    Interrupt(InterruptRequest),
    Setting(SettingChange),
    Close(RuntimeGeneration),
}

#[derive(Debug, Clone)]
pub struct FakeAdapter {
    harness: Harness,
    state: Arc<Mutex<State>>,
    submissions: watch::Sender<usize>,
    open_attempts: watch::Sender<usize>,
    runtime_dropped: watch::Sender<()>,
}

#[derive(Debug)]
struct State {
    inspection: Inspection,
    capabilities: Capabilities,
    attachment_refusal: Option<Refusal>,
    image_input: Option<bool>,
    steer_image_input: Option<bool>,
    open_failures: VecDeque<Problem>,
    open_holds: VecDeque<oneshot::Receiver<()>>,
    respond_holds: VecDeque<oneshot::Receiver<()>>,
    setting_replies: VecDeque<oneshot::Receiver<SettingOutcome>>,
    submit_replies: VecDeque<ScriptedReply>,
    submit_write_holds: VecDeque<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
    prompt_refusal_holds: VecDeque<(oneshot::Sender<Refusal>, oneshot::Receiver<()>)>,
    interrupt_outcomes: VecDeque<InterruptOutcome>,
    close_outcome: CloseOutcome,
    close_holds: VecDeque<oneshot::Receiver<()>>,
    opens: Vec<OpenRequest>,
    written: Vec<Written>,
    respond_calls: usize,
    live: Option<Live>,
    turns_started: u64,
    options: Option<HarnessOptions>,
    options_asked: usize,
    options_holds: VecDeque<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
    /// Whether the harness answers a new turn with its identity. Claude Code does not:
    /// it takes the input and names the turn only when it starts processing it.
    acknowledges_new_turn: bool,
}

#[derive(Debug)]
enum ScriptedReply {
    Now(SubmitReply),
    Held(oneshot::Receiver<SubmitReply>),
}

#[derive(Debug)]
struct Live {
    generation: RuntimeGeneration,
    events: mpsc::Sender<RuntimeEvent>,
    runtime: RuntimeState<()>,
}

impl State {
    /// The local checks every adapter makes immediately before a write.
    fn live_for(
        &mut self,
        runtime: RuntimeGeneration,
        command: RuntimeGeneration,
    ) -> Result<&mut Live, Refusal> {
        if command != runtime {
            return Err(Refusal::StaleGeneration { current: runtime });
        }
        self.live
            .as_mut()
            .filter(|live| live.generation == runtime)
            .ok_or(Refusal::RuntimeClosed)
    }
}

impl FakeAdapter {
    pub fn new(harness: Harness, capabilities: Capabilities) -> Self {
        let inspection = Inspection::Installed {
            executable: PathBuf::from("fake-harness"),
            version: Some("0.0.0-fake".to_owned()),
            login: LoginState::SignedIn,
            capabilities: capabilities.clone(),
        };
        Self {
            harness,
            submissions: watch::channel(0).0,
            open_attempts: watch::channel(0).0,
            runtime_dropped: watch::channel(()).0,
            state: Arc::new(Mutex::new(State {
                inspection,
                capabilities,
                attachment_refusal: None,
                image_input: None,
                steer_image_input: None,
                open_failures: VecDeque::new(),
                open_holds: VecDeque::new(),
                respond_holds: VecDeque::new(),
                setting_replies: VecDeque::new(),
                submit_replies: VecDeque::new(),
                submit_write_holds: VecDeque::new(),
                prompt_refusal_holds: VecDeque::new(),
                interrupt_outcomes: VecDeque::new(),
                close_outcome: CloseOutcome::Confirmed { exit_code: Some(0) },
                close_holds: VecDeque::new(),
                opens: Vec::new(),
                written: Vec::new(),
                respond_calls: 0,
                live: None,
                turns_started: 0,
                options: None,
                options_asked: 0,
                options_holds: VecDeque::new(),
                acknowledges_new_turn: true,
            })),
        }
    }

    /// Steering supported without interrupting tools; native resume supported.
    pub fn codex() -> Self {
        Self::new(
            &ticketd_core::harnesses::CODEX,
            Capabilities {
                steering: Capability::Supported {
                    behavior: SteeringBehavior {
                        interrupts_tools: false,
                    },
                    evidence: "fake".to_owned(),
                },
            },
        )
    }

    /// Like Claude Code: no steering, and a new turn is never acknowledged. `submit`
    /// returns `Written`, and the test emits `TurnStarted` and the
    /// [`crate::DeliveryEvidence::Processing`] that shows the input arrived.
    pub fn claude() -> Self {
        let fake = Self::new(
            &ticketd_core::harnesses::CLAUDE_CODE,
            Capabilities {
                steering: Capability::Unknown {
                    reason: "fake harness that cannot steer".to_owned(),
                },
            },
        );
        fake.state().acknowledges_new_turn = false;
        fake
    }

    pub fn without_steering() -> Self {
        Self::new(
            &ticketd_core::harnesses::CODEX,
            Capabilities {
                steering: Capability::Unsupported {
                    reason: "fake harness without steering".to_owned(),
                },
            },
        )
    }

    pub fn set_inspection(&self, inspection: Inspection) {
        self.state().inspection = inspection;
    }

    pub fn set_attachment_refusal(&self, refusal: Refusal) {
        self.state().attachment_refusal = Some(refusal);
    }

    pub fn set_image_input(&self, supported: bool) {
        self.state().image_input = Some(supported);
    }

    pub fn set_steer_image_input(&self, supported: bool) {
        self.state().steer_image_input = Some(supported);
    }

    /// The next `open` waits for the returned sender before it opens or fails.
    pub fn hold_next_open(&self) -> oneshot::Sender<()> {
        let (sender, receiver) = oneshot::channel();
        self.state().open_holds.push_back(receiver);
        sender
    }

    /// Waits until the adapter has begun opening, even if the open is held.
    pub async fn wait_for_open_attempts(&self, count: usize) {
        let _ = self
            .open_attempts
            .subscribe()
            .wait_for(|seen| *seen >= count)
            .await;
    }

    /// The next `open` fails with this problem.
    pub fn fail_next_open(&self, problem: Problem) {
        self.state().open_failures.push_back(problem);
    }

    /// Scripts the reply to the next unscripted submission. Unscripted submissions
    /// are acknowledged.
    pub fn script_submit(&self, reply: SubmitReply) {
        self.state()
            .submit_replies
            .push_back(ScriptedReply::Now(reply));
    }

    /// The next answer is written, then waits for the returned sender before it
    /// reports `Sent`, as a harness may confirm the answer before the write returns.
    pub fn hold_next_respond(&self) -> oneshot::Sender<()> {
        let (sender, receiver) = oneshot::channel();
        self.state().respond_holds.push_back(receiver);
        sender
    }

    /// The next setting change is written, then waits for the outcome sent on the
    /// returned sender. Dropping the sender leaves it unconfirmed.
    pub fn hold_next_setting(&self) -> oneshot::Sender<SettingOutcome> {
        let (sender, receiver) = oneshot::channel();
        self.state().setting_replies.push_back(receiver);
        sender
    }

    /// The next submission is written, then waits for the returned sender. Dropping
    /// the sender behaves like [`SubmitReply::Timeout`].
    pub fn hold_next_submit(&self) -> oneshot::Sender<SubmitReply> {
        let (sender, receiver) = oneshot::channel();
        self.state()
            .submit_replies
            .push_back(ScriptedReply::Held(receiver));
        sender
    }

    /// Waits after a Prompt holds its run's fence, before checking ownership and
    /// recording the write. The receiver reports that the boundary was reached.
    pub fn hold_next_submit_write(&self) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (reached, boundary) = oneshot::channel();
        let (release, permit) = oneshot::channel();
        self.state().submit_write_holds.push_back((reached, permit));
        (boundary, release)
    }

    /// Holds the adapter result after the Prompt's admission check refused a write.
    pub fn hold_next_prompt_refusal(&self) -> (oneshot::Receiver<Refusal>, oneshot::Sender<()>) {
        let (reached, refused) = oneshot::channel();
        let (release, permit) = oneshot::channel();
        self.state()
            .prompt_refusal_holds
            .push_back((reached, permit));
        (refused, release)
    }

    /// Observes when the Host releases the last reference to a fake runtime.
    pub fn runtime_dropped(&self) -> watch::Receiver<()> {
        self.runtime_dropped.subscribe()
    }

    /// Scripts the outcome of the next interrupt that reaches the harness. Unscripted
    /// interrupts are acknowledged. No `TurnEnded` is emitted automatically.
    pub fn script_interrupt(&self, outcome: InterruptOutcome) {
        self.state().interrupt_outcomes.push_back(outcome);
    }

    pub fn set_close_outcome(&self, outcome: CloseOutcome) {
        self.state().close_outcome = outcome;
    }

    /// The next close is written, then waits for the returned sender before reporting its outcome.
    pub fn hold_next_close(&self) -> oneshot::Sender<()> {
        let (sender, receiver) = oneshot::channel();
        self.state().close_holds.push_back(receiver);
        sender
    }

    /// What `options` reports; without it the fake cannot tell.
    pub fn set_options(&self, options: HarnessOptions) {
        self.state().options = Some(options);
    }

    /// The next options probe signals that it started, then waits for release.
    pub fn hold_next_options(&self) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (started, starting) = oneshot::channel();
        let (release, released) = oneshot::channel();
        self.state().options_holds.push_back((started, released));
        (starting, release)
    }

    /// How many times the options were asked for.
    pub fn options_asked(&self) -> usize {
        self.state().options_asked
    }

    /// Every successful open, in order.
    pub fn opens(&self) -> Vec<OpenRequest> {
        self.state().opens.clone()
    }

    /// Commands that reached the fake harness, in order.
    pub fn written(&self) -> Vec<Written> {
        self.state().written.clone()
    }

    /// Waits for submitted input to reach the fake harness, even with its reply held.
    pub async fn wait_for_submissions(&self, count: usize) {
        let _ = self
            .submissions
            .subscribe()
            .wait_for(|seen| *seen >= count)
            .await;
    }

    /// How many answers were handed to a runtime, including ones it then refused. A
    /// real harness may not refuse a repeated answer, so the host must not send one.
    pub fn respond_calls(&self) -> usize {
        self.state().respond_calls
    }

    /// Emits an event from the live runtime and keeps the fake's active turn and live
    /// requests consistent with it. Returns false when no runtime is live or its
    /// stream was dropped.
    pub async fn emit(&self, kind: EventKind) -> bool {
        let (generation, events) = {
            let mut state = self.state();
            let Some(live) = state.live.as_mut() else {
                return false;
            };
            match &kind {
                EventKind::TurnStarted { turn, .. } => live.runtime.turn_started(turn),
                EventKind::TurnEnded { turn, outcome, .. } => {
                    // The script provides the actual events. Update only the
                    // lifecycle checked when the next command arrives.
                    live.runtime
                        .end_turn(turn.clone(), outcome.clone(), |_| Default::default());
                }
                EventKind::InteractionRequested(request) => {
                    live.runtime.register_request(
                        request.request.clone(),
                        request.turn.as_ref(),
                        (),
                    );
                }
                EventKind::InteractionResolved { request, .. } => {
                    live.runtime.resolve_request(request);
                }
                _ => {}
            }
            (live.generation, live.events.clone())
        };
        events.send(RuntimeEvent { generation, kind }).await.is_ok()
    }

    /// Kills the live process: emits `RuntimeLost`, ends the stream and makes later
    /// commands `RuntimeClosed`.
    pub async fn lose_process(&self) {
        let Some(live) = self.state().live.take() else {
            return;
        };
        let lost = RuntimeEvent {
            generation: live.generation,
            kind: EventKind::RuntimeLost {
                exit_code: None,
                diagnostics: "fake process lost".to_owned(),
            },
        };
        // A dropped receiver already knows the stream ended.
        let _ = live.events.send(lost).await;
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[async_trait]
impl HarnessAdapter for FakeAdapter {
    fn harness(&self) -> Harness {
        self.harness
    }

    fn attachment_refusal(
        &self,
        attachments: &[ticketd_core::ChatAttachmentContent],
    ) -> Option<Refusal> {
        if attachments.is_empty() {
            return None;
        }
        self.state().attachment_refusal.clone()
    }

    async fn inspect(&self) -> Inspection {
        self.state().inspection.clone()
    }

    async fn options(&self) -> Result<HarnessOptions, String> {
        let (options, hold) = {
            let mut state = self.state();
            state.options_asked += 1;
            (state.options.clone(), state.options_holds.pop_front())
        };
        if let Some((started, release)) = hold {
            let _ = started.send(());
            let _ = release.await;
        }
        options.ok_or_else(|| "the fake lists no options".to_owned())
    }

    /// The fake records its permission as `{"permission": id}`; it offers `ask` and
    /// `full`.
    fn permission_before_session(
        &self,
        recorded: Option<&str>,
        picked: Option<&str>,
    ) -> Option<crate::Setting> {
        let recorded = recorded
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            .and_then(|value| value["permission"].as_str().map(str::to_owned));
        let option = |id: &str, permission| crate::SettingOption {
            resolved: None,
            id: id.to_owned(),
            label: id.to_owned(),
            description: None,
            is_default: id == "ask",
            permission: Some(permission),
            allowed: true,
        };
        Some(crate::Setting {
            current: Some(picked.map(str::to_owned).or(recorded)?),
            options: vec![
                option("ask", crate::PermissionKind::Ask),
                option("full", crate::PermissionKind::FullAccess),
            ],
            unchangeable: None,
            applies_from: crate::AppliesFrom::NextTurn,
            answered_by: None,
        })
    }

    fn record_permission(&self, recorded: Option<&str>, value: &str) -> Option<String> {
        let mut recorded: serde_json::Value = serde_json::from_str(recorded?).ok()?;
        recorded
            .as_object_mut()?
            .insert("permission".to_owned(), serde_json::json!(value));
        Some(recorded.to_string())
    }

    /// Opening replaces any live runtime, whose stream then ends.
    async fn open(&self, request: OpenRequest) -> Result<OpenedRuntime, Problem> {
        let hold = self.state().open_holds.pop_front();
        self.open_attempts.send_modify(|seen| *seen += 1);
        if let Some(hold) = hold {
            let _ = hold.await;
        }
        let mut state = self.state();
        if let Some(problem) = state.open_failures.pop_front() {
            return Err(problem);
        }
        let (sender, events) = mpsc::channel(EVENT_BUFFER);
        state.live = Some(Live {
            generation: request.generation,
            events: sender,
            runtime: RuntimeState::default(),
        });
        let generation = request.generation;
        state.opens.push(request);
        Ok(OpenedRuntime {
            runtime: Arc::new(FakeRuntime {
                generation,
                fake: self.clone(),
            }),
            events,
            capabilities: state.capabilities.clone(),
        })
    }
}

#[derive(Debug)]
struct FakeRuntime {
    generation: RuntimeGeneration,
    fake: FakeAdapter,
}

impl Drop for FakeRuntime {
    fn drop(&mut self) {
        self.fake.runtime_dropped.send_replace(());
    }
}

#[async_trait]
impl HarnessRuntime for FakeRuntime {
    fn supports_image_input(&self) -> Option<bool> {
        self.fake.state().image_input
    }

    fn supports_steer_image_input(&self) -> Option<bool> {
        self.fake.state().steer_image_input
    }

    async fn submit(&self, submission: Submission) -> DispatchOutcome {
        self.submit_with_admission(submission, None).await
    }

    async fn submit_with_admission(
        &self,
        submission: Submission,
        admission: Option<crate::AutomationPromptAdmission>,
    ) -> DispatchOutcome {
        let prompt = match &admission {
            Some(admission) => Some(admission.lock().await),
            None => None,
        };
        let hold = self.fake.state().submit_write_holds.pop_front();
        if let Some((reached, permit)) = hold {
            let _ = reached.send(());
            let _ = permit.await;
        }
        if let Some(admission) = &admission
            && let Err(refusal) = admission.check()
        {
            drop(prompt);
            let hold = self.fake.state().prompt_refusal_holds.pop_front();
            if let Some((reached, permit)) = hold {
                let _ = reached.send(refusal.clone());
                let _ = permit.await;
            }
            return DispatchOutcome::NotSent(refusal);
        }
        let scripted = {
            let mut state = self.fake.state();
            let steering = state.capabilities.steering.behavior().is_some();
            let live = match state.live_for(self.generation, submission.generation) {
                Ok(live) => live,
                Err(refusal) => return DispatchOutcome::NotSent(refusal),
            };
            if let Err(refusal) = live.runtime.check_submission(&submission.kind, steering) {
                return DispatchOutcome::NotSent(refusal);
            }
            state.written.push(Written::Submit(submission.clone()));
            self.fake.submissions.send_modify(|seen| *seen += 1);
            state.submit_replies.pop_front()
        };
        drop(prompt);
        let reply = match scripted {
            None => SubmitReply::Acknowledge,
            Some(ScriptedReply::Now(reply)) => reply,
            Some(ScriptedReply::Held(reply)) => reply.await.unwrap_or(SubmitReply::Timeout),
        };
        if reply == SubmitReply::LoseProcess {
            self.fake.lose_process().await;
        }

        // The process may have gone while the reply was pending.
        let mut state = self.fake.state();
        if state.live_for(self.generation, self.generation).is_err() {
            return DispatchOutcome::UnknownAfterLoss;
        }
        match reply {
            SubmitReply::Acknowledge => match submission.kind {
                SubmissionKind::Steer { expected_turn } => DispatchOutcome::Acknowledged {
                    turn: expected_turn,
                },
                SubmissionKind::StartTurn if !state.acknowledges_new_turn => {
                    DispatchOutcome::Written
                }
                SubmissionKind::StartTurn => {
                    state.turns_started += 1;
                    let turn = NativeTurnId(format!("turn-{}", state.turns_started));
                    if let Some(live) = state.live.as_mut() {
                        live.runtime.turn_started(&turn);
                    }
                    DispatchOutcome::Acknowledged { turn }
                }
            },
            SubmitReply::Reject(reason) => DispatchOutcome::Rejected { reason },
            SubmitReply::Timeout => DispatchOutcome::Written,
            SubmitReply::LoseProcess => DispatchOutcome::UnknownAfterLoss,
        }
    }

    async fn respond(&self, response: InteractionResponse) -> RespondOutcome {
        let hold = {
            let mut state = self.fake.state();
            state.respond_calls += 1;
            let live = match state.live_for(self.generation, response.generation) {
                Ok(live) => live,
                Err(refusal) => return RespondOutcome::NotSent(refusal),
            };
            if let Err(refusal) = live.runtime.answer(&response.request, |()| Ok(())) {
                return RespondOutcome::NotSent(refusal);
            }
            state.written.push(Written::Respond(response));
            state.respond_holds.pop_front()
        };
        if let Some(hold) = hold {
            let _ = hold.await;
        }
        RespondOutcome::Sent
    }

    async fn interrupt(&self, request: InterruptRequest) -> InterruptOutcome {
        let mut state = self.fake.state();
        let live = match state.live_for(self.generation, request.generation) {
            Ok(live) => live,
            Err(refusal) => return InterruptOutcome::NotSent(refusal),
        };
        if let Err(refusal) = live.runtime.mark_interrupt(&request.expected_turn) {
            return InterruptOutcome::NotSent(refusal);
        }
        state.written.push(Written::Interrupt(request));
        state
            .interrupt_outcomes
            .pop_front()
            .unwrap_or(InterruptOutcome::Acknowledged)
    }

    /// The fake harness accepts every setting change that reaches it.
    async fn change_setting(&self, change: SettingChange) -> SettingOutcome {
        let reply = {
            let mut state = self.fake.state();
            if state.live_for(self.generation, change.generation).is_err() {
                return SettingOutcome::Refused {
                    reason: "the session has ended".to_owned(),
                };
            }
            state.written.push(Written::Setting(change));
            state.setting_replies.pop_front()
        };
        match reply {
            Some(reply) => reply.await.unwrap_or(SettingOutcome::Unconfirmed),
            None => SettingOutcome::Applied,
        }
    }

    /// Closing a runtime that is no longer live reports the scripted outcome too.
    async fn close(&self) -> CloseOutcome {
        let (outcome, hold) = {
            let mut state = self.fake.state();
            if state
                .live
                .as_ref()
                .is_some_and(|live| live.generation == self.generation)
            {
                state.live = None;
            }
            state.written.push(Written::Close(self.generation));
            (state.close_outcome.clone(), state.close_holds.pop_front())
        };
        // As with a real process: its event stream has ended before `close` returns.
        tokio::task::yield_now().await;
        if let Some(hold) = hold {
            let _ = hold.await;
        }
        outcome
    }
}
