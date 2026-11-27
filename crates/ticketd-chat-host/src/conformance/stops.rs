//! "Stop leaves nothing running", the third cross-harness property of the sub-agent
//! conformance suite, written once for every harness.
//!
//! Which frames leave a harness cannot say whether anything still runs: the Chat's history
//! can. So this property is checked through the whole Chat host (the real adapter, the real
//! supervisor and the real core, as `host_script` plays them) and asserts what a person
//! sees after Stop: no sub-agent running, no approval waiting, no turn active, and the Chat
//! not working. A Step the history still holds as running belongs to a turn or a sub-agent
//! run that ended, which the Chat shows as "not finished", so it is the end of its owner
//! that is asserted; that the harness was told to end the commands themselves (Codex cleans
//! the terminals of a child it interrupts) is held by the fixtures, which fail if the adapter
//! does not write those frames.
//!
//! Each harness declares what its Stop is: the fixture that plays it, when the person
//! presses Stop, and where its protocol makes a case meaningless (Antigravity's sub-agents
//! exist only inside a prompt, and it cannot stop one alone). The declaration is data; the
//! assertions are the same for every harness, so a harness that leaves something running
//! fails here whatever its protocol looks like.

use ticketd_core::{
    ChatInteractionState, ChatItem, ChatSubAgentState, ChatSubAgentStopper, ChatToolState,
    ChatTurnState,
};

use crate::host_script::{Builder, Fixture, HostScript, fixture};
use crate::{HostError, InteractionAnswer};

/// What the person does, in order, to bring a Chat to the moment they press Stop.
#[derive(Clone, Copy)]
enum Until {
    /// Play the fixture to this mark.
    Mark(&'static str),
    /// Allow the approval that waits (Antigravity asks before it runs a command).
    Allow,
}

/// One moment at which the person can press Stop, as a harness's fixture plays it.
struct Moment {
    harness: fn() -> Builder,
    process: &'static [Fixture],
    /// What the person sends first.
    prompt: &'static str,
    /// The steps that bring the Chat to the moment.
    until: &'static [Until],
    /// How many sub-agents run at that moment.
    running: usize,
    /// How many Steps are under way at least (a sub-agent's command).
    steps: usize,
}

/// What Stop does when no turn runs but sub-agents do.
enum AtRest {
    /// The harness keeps sub-agents running with no turn (Claude Code, Codex): Stop stops
    /// them and ends the harness process.
    Moment(Moment),
    /// The harness's sub-agents exist only inside a prompt and end with it (Antigravity):
    /// there is nothing to stop with no turn.
    NothingRuns,
}

/// What Stop one sub-agent does.
enum StopOne {
    /// The harness stops one sub-agent and leaves the rest: the moment two run, the mark
    /// the fixture reaches once the first was stopped.
    Stops {
        moment: Moment,
        stopped_mark: &'static str,
    },
    /// The harness cannot (Antigravity: its sub-agents run in the foreground, with the
    /// prompt): the host refuses, and the sub-agent runs on until the person stops the
    /// whole Chat.
    Unsupported(Moment),
}

/// What a harness declares of its Stop.
struct Declared {
    /// Stop pressed while the turn that started the sub-agents runs.
    in_turn: Moment,
    at_rest: AtRest,
    one: StopOne,
}

const CLAUDE_PROMPT: &str = "Before I merge, review the rate limiter on this branch. In parallel: look for ways around it, check that the tests cover the edge cases, and proofread the API docs.";

fn claude() -> Declared {
    Declared {
        in_turn: Moment {
            harness: HostScript::claude,
            process: &[
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_stop_in_turn"),
            ],
            prompt: CLAUDE_PROMPT,
            until: &[
                Until::Mark("the SDK took the input"),
                Until::Mark("two sub-agents run in the turn"),
            ],
            running: 2,
            steps: 1,
        },
        at_rest: AtRest::Moment(Moment {
            harness: HostScript::claude,
            process: &[
                fixture!("claude", "handshake"),
                fixture!("claude", "sub_agent_background_at_rest"),
            ],
            prompt: CLAUDE_PROMPT,
            until: &[
                Until::Mark("the SDK took the input"),
                Until::Mark("the turn ended"),
                Until::Mark("a sub-agent works after the turn ended"),
                Until::Mark("both sub-agents work"),
            ],
            running: 2,
            steps: 1,
        }),
        one: StopOne::Stops {
            moment: Moment {
                harness: HostScript::claude,
                process: &[
                    fixture!("claude", "handshake"),
                    fixture!("claude", "sub_agent_stop_one"),
                ],
                prompt: CLAUDE_PROMPT,
                until: &[
                    Until::Mark("the SDK took the input"),
                    Until::Mark("the turn ended"),
                    Until::Mark("a sub-agent works after the turn ended"),
                    Until::Mark("both sub-agents work"),
                ],
                running: 2,
                steps: 1,
            },
            stopped_mark: "the person stopped the first sub-agent",
        },
    }
}

fn codex() -> Declared {
    Declared {
        in_turn: Moment {
            harness: HostScript::codex,
            process: &[
                fixture!("codex", "handshake"),
                fixture!("codex", "sub_agent_stop"),
            ],
            prompt: "Start one sub-agent on the slow check and wait for it",
            until: &[Until::Mark("the sub-agent runs its command")],
            running: 1,
            steps: 1,
        },
        at_rest: AtRest::Moment(Moment {
            harness: HostScript::codex,
            process: &[
                fixture!("codex", "handshake"),
                fixture!("codex", "sub_agent_stop_at_rest"),
            ],
            prompt: "Start one sub-agent on the slow check, do not wait for it, and end your turn",
            until: &[Until::Mark(
                "the parent's turn ended while the sub-agent runs",
            )],
            running: 1,
            // The capture's child has not started a command yet; Codex still cleans its terminals.
            steps: 0,
        }),
        one: StopOne::Stops {
            moment: Moment {
                harness: HostScript::codex,
                process: &[
                    fixture!("codex", "handshake"),
                    fixture!("codex", "sub_agent_stop_one"),
                ],
                prompt: "Start two sub-agents on the slow checks and wait for them",
                until: &[Until::Mark("two sub-agents run commands")],
                running: 2,
                steps: 1,
            },
            stopped_mark: "the first sub-agent was stopped",
        },
    }
}

fn antigravity() -> Declared {
    let moment = || Moment {
        harness: HostScript::antigravity,
        process: &[fixture!("antigravity", "sub_agent_stop")],
        prompt: "Run the slow check in a sub-agent",
        until: &[
            Until::Mark("the prompt was written"),
            Until::Mark("the sub-agent's command asks to run"),
            Until::Allow,
            Until::Mark("the sub-agent's command runs"),
        ],
        running: 1,
        steps: 1,
    };
    Declared {
        in_turn: moment(),
        at_rest: AtRest::NothingRuns,
        one: StopOne::Unsupported(moment()),
    }
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

/// Plays the moment's fixture until the person would press Stop, and checks that the
/// sub-agents it names run, so a Stop that finds nothing running proves nothing.
async fn reach(moment: &Moment) -> HostScript {
    let mut builder = (moment.harness)();
    builder = builder.process(moment.process.iter().copied());
    let mut h = builder.start();
    h.send(moment.prompt).await;
    for step in moment.until {
        match step {
            Until::Mark(mark) => h.play_to(mark).await,
            Until::Allow => {
                h.answer(InteractionAnswer::NativeApproval("allow".to_owned()))
                    .await;
            }
        }
    }
    assert_eq!(
        h.live().await.sub_agents,
        moment.running,
        "the sub-agents that run before Stop"
    );
    assert!(
        running_steps(&h) >= moment.steps,
        "the Steps under way before Stop"
    );
    h
}

fn running_steps(h: &HostScript) -> usize {
    h.items()
        .iter()
        .filter(|item| matches!(item, ChatItem::Tool(tool) if tool.state == ChatToolState::Running))
        .count()
}

/// What "nothing runs" means for the Chat's history, whatever the harness is: no
/// sub-agent run or turn in progress and no approval waiting, and the Chat does not say it
/// works.
async fn assert_nothing_runs(h: &HostScript) {
    assert_eq!(h.live().await.sub_agents, 0, "a sub-agent still runs");
    for item in h.items() {
        match item {
            ChatItem::SubAgentRun(run) => assert_ne!(
                run.state,
                ChatSubAgentState::Running,
                "a sub-agent's run is still going: {run:?}"
            ),
            ChatItem::Turn(turn) => assert_ne!(
                turn.state,
                ChatTurnState::Active,
                "a turn is still active: {turn:?}"
            ),
            ChatItem::Interaction(request) => assert_ne!(
                request.state,
                ChatInteractionState::Pending,
                "an approval still waits: {request:?}"
            ),
            _ => {}
        }
    }
    for record in h.sub_agents() {
        let run = record.latest().expect("a run");
        assert_ne!(
            run.state,
            ChatSubAgentState::Running,
            "{} still runs",
            record.native_id
        );
    }
    let status = h.attention().await;
    assert!(
        !status.word.starts_with("Working"),
        "the Chat still says it works: {status:?}"
    );
}

/// Every sub-agent that ran was stopped by the person, or had finished before.
fn assert_stopped_by_the_person(h: &HostScript) {
    for record in h.sub_agents() {
        let run = record.latest().expect("a run");
        match run.state {
            ChatSubAgentState::Completed => {}
            ChatSubAgentState::Stopped => assert_eq!(
                run.stopped_by,
                Some(ChatSubAgentStopper::Person),
                "{} was stopped by someone else",
                record.native_id
            ),
            other => panic!("{} ended as {other:?}", record.native_id),
        }
    }
}

/// Stop with the turn that started the sub-agents running ends the turn and with it
/// everything that ran.
async fn stop_in_a_turn_leaves_nothing_running(declared: Declared) {
    let mut h = reach(&declared.in_turn).await;
    let working = h.turns().last().map(|turn| turn.state);
    assert_eq!(working, Some(ChatTurnState::Active), "a turn runs");

    h.stop().await;
    h.play_all().await;
    h.finish().await;

    assert_nothing_runs(&h).await;
    assert_stopped_by_the_person(&h);
    assert_eq!(
        h.turns().last().map(|turn| turn.state),
        Some(ChatTurnState::Interrupted)
    );
}

/// Stop with no turn running but sub-agents running stops them, says how many, and ends
/// the harness process, which the next message opens again.
async fn stop_with_no_turn_leaves_nothing_running(declared: Declared) {
    let AtRest::Moment(moment) = declared.at_rest else {
        // Declared: with no prompt in flight no sub-agent of this harness exists.
        return;
    };
    let mut h = reach(&moment).await;
    let before = h.turns();
    assert!(
        before
            .iter()
            .all(|turn| turn.state != ChatTurnState::Active),
        "no turn runs: {before:?}"
    );

    h.stop().await;
    h.play_all().await;
    // The Chat ends the harness process too: nothing runs in it any more.
    h.lose_process(0).await;
    h.finish().await;

    assert_nothing_runs(&h).await;
    assert_stopped_by_the_person(&h);
    assert!(!h.live().await.running, "the harness process still runs");
    // What stopped is said once, with a plural that fits.
    let stopped = h
        .sub_agents()
        .iter()
        .filter(|record| {
            record
                .latest()
                .is_some_and(|run| run.state == ChatSubAgentState::Stopped)
        })
        .count();
    let noun = if stopped == 1 {
        "sub-agent"
    } else {
        "sub-agents"
    };
    assert_eq!(h.notices(), [format!("You stopped {stopped} {noun}.")]);
    // The turn that started them ended long before and is not touched.
    assert_eq!(h.turns(), before);
}

/// Stop one sub-agent, where the harness can, leaves the other and the main agent
/// running; where it cannot, the host says so and leaves everything as it was.
async fn stop_one_leaves_only_that_one_stopped(declared: Declared) {
    match declared.one {
        StopOne::Stops {
            moment,
            stopped_mark,
        } => {
            let mut h = reach(&moment).await;
            let mut ids: Vec<String> = h
                .sub_agents()
                .into_iter()
                .filter(|record| {
                    record
                        .latest()
                        .is_some_and(|run| run.state == ChatSubAgentState::Running)
                })
                .map(|record| record.native_id)
                .collect();
            ids.sort();
            assert_eq!(ids.len(), moment.running, "{ids:?}");
            let (first, others) = ids.split_first().expect("a sub-agent runs");

            h.stop_sub_agent(first).await;
            h.play_to(stopped_mark).await;

            let record = h
                .sub_agents()
                .into_iter()
                .find(|record| &record.native_id == first)
                .expect("the sub-agent");
            let run = record.latest().expect("a run");
            assert_eq!(
                (run.state, run.stopped_by),
                (
                    ChatSubAgentState::Stopped,
                    Some(ChatSubAgentStopper::Person)
                )
            );
            // The rest goes on, and the Chat is still working for it.
            assert_eq!(h.live().await.sub_agents, others.len());
            for other in others {
                let state = h
                    .sub_agents()
                    .into_iter()
                    .find(|record| &record.native_id == other)
                    .and_then(|record| record.latest().map(|run| run.state));
                assert_eq!(state, Some(ChatSubAgentState::Running), "{other}");
            }
            assert!(h.attention().await.word.starts_with("Working"));

            h.play_all().await;
            h.finish().await;
            assert_nothing_runs(&h).await;
        }
        StopOne::Unsupported(moment) => {
            let mut h = reach(&moment).await;
            let mut ids: Vec<String> = h
                .sub_agents()
                .into_iter()
                .map(|record| record.native_id)
                .collect();
            ids.sort();
            let first = ids.first().expect("a sub-agent runs").clone();

            let refused = h.stop_sub_agent_refused(&first).await;
            assert!(
                matches!(
                    refused,
                    HostError::SubAgentGone | HostError::SubAgentNotStopped(_)
                ),
                "{refused:?}"
            );
            // Nothing changed, and nothing was written to the harness: the fixture does not
            // expect it (the Chat's Stop, which it does, comes next).
            assert_eq!(h.live().await.sub_agents, moment.running);
            assert_eq!(running_steps(&h), 1);

            h.stop().await;
            h.play_all().await;
            h.finish().await;
            assert_nothing_runs(&h).await;
            assert_stopped_by_the_person(&h);
        }
    }
}

macro_rules! stops {
    ($harness:ident) => {
        mod $harness {
            #[tokio::test(start_paused = true)]
            async fn stop_in_a_turn_leaves_nothing_running() {
                super::stop_in_a_turn_leaves_nothing_running(super::$harness()).await;
            }

            #[tokio::test(start_paused = true)]
            async fn stop_with_no_turn_leaves_nothing_running() {
                super::stop_with_no_turn_leaves_nothing_running(super::$harness()).await;
            }

            #[tokio::test(start_paused = true)]
            async fn stop_one_leaves_only_that_one_stopped() {
                super::stop_one_leaves_only_that_one_stopped(super::$harness()).await;
            }
        }
    };
}

stops!(claude);
stops!(codex);
stops!(antigravity);
