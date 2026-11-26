use ticketd_core::{
    Automation, AutomationAgentSettings, AutomationDefinition, AutomationRun, AutomationRunScope,
    AutomationRunStatus, AutomationRunSummary, AutomationStepStatus, ChatInputChange, ChatLink,
    ChatLinkKind, ChatListFilter, ChatSubmissionIntent, Check, Condition, Error, NewChat,
    NotifyTarget, RunAction, RunAnswer, RunEnd, RunningAutomationRuns, Step, StepAction,
    StepOutcome, Ticket, Trigger, Workspace,
};

const TAG: &str = "ready-for-triage";

#[allow(clippy::unwrap_used)] // A Workspace that cannot open fails the test during setup.
fn workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("runs.sqlite3")).unwrap();
    (dir, workspace)
}

/// A folder that exists, as a step's folder must.
fn folder() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

fn step(id: &str, action: StepAction) -> Step {
    Step {
        id: id.into(),
        action,
    }
}

fn run_agent(id: &str, agent: &str, on_failure: Option<Vec<Step>>) -> Step {
    step(
        id,
        StepAction::RunAgent {
            agent_id: Some(agent.into()),
            execution_folder: Some(folder()),
            on_failure,
        },
    )
}

fn notify(id: &str) -> Step {
    step(
        id,
        StepAction::Notify {
            text: "Done".into(),
            opens: NotifyTarget::Ticket,
            on_failure: None,
        },
    )
}

/// An Automation that is on and starts when `TAG` is added, with the steps `steps`
/// builds from an agent's id.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
fn automation_on(
    workspace: &mut Workspace,
    conditions: Vec<Condition>,
    steps: impl FnOnce(&str) -> Vec<Step>,
) -> Automation {
    let agent = workspace
        .create_automation_agent(AutomationAgentSettings::default())
        .unwrap();
    let automation = workspace
        .create_automation(AutomationDefinition {
            name: "Triage".into(),
            trigger: Some(Trigger::TagAdded { tag: TAG.into() }),
            conditions,
            steps: steps(&agent.id),
        })
        .unwrap();
    workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap()
}

fn triage(workspace: &mut Workspace) -> Automation {
    automation_on(workspace, Vec::new(), |agent| {
        vec![run_agent("triage", agent, None)]
    })
}

/// Another Automation started by the same tag, under its own name.
#[allow(clippy::unwrap_used)]
fn triage_named(workspace: &mut Workspace, name: &str) -> Automation {
    let automation = triage(workspace);
    workspace
        .update_automation(
            &automation.id,
            AutomationDefinition {
                name: name.into(),
                ..automation.definition
            },
        )
        .unwrap()
}

#[allow(clippy::unwrap_used)]
fn tagged(workspace: &mut Workspace, title: &str) -> Ticket {
    let ticket = workspace.create_ticket(title).unwrap();
    workspace.add_tag(&ticket.reference, TAG).unwrap()
}

#[allow(clippy::unwrap_used)]
fn runs(workspace: &Workspace, automation: &Automation) -> Vec<AutomationRun> {
    workspace.automation_runs(&automation.id).unwrap()
}

/// Queues and starts the run of one tagged ticket.
#[allow(clippy::unwrap_used)]
fn started(workspace: &mut Workspace) -> AutomationRun {
    tagged(workspace, "Fix login");
    workspace.queue_automation_runs().unwrap();
    workspace.start_automation_runs(2).unwrap().remove(0)
}

/// The step an executor is handed to run.
#[allow(clippy::panic)] // A step that is not handed over fails the test.
fn handed(action: RunAction) -> String {
    match action {
        RunAction::RunAgent(start) => start.step_id,
        RunAction::Notify { step_id, .. } => step_id,
        other => panic!("expected a step to run, got {other:?}"),
    }
}

fn failed(reason: &str) -> Option<StepOutcome> {
    Some(StepOutcome::Failed {
        reason: reason.into(),
    })
}

#[test]
fn adding_the_trigger_tag_queues_one_run_for_the_ticket_and_the_event_is_read_once() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let other = workspace.create_ticket("Untouched").unwrap();
    workspace.add_tag(&other.reference, "other-tag").unwrap();
    let ticket = tagged(&mut workspace, "Fix login");

    assert_eq!(workspace.queue_automation_runs().unwrap(), 1);

    let queued = runs(&workspace, &automation);
    assert_eq!(queued.len(), 1);
    let run = &queued[0];
    assert_eq!(run.status, AutomationRunStatus::Queued);
    assert_eq!(run.automation_id, automation.id);
    let run_ticket = run.ticket.as_ref().unwrap();
    assert_eq!(
        (run_ticket.reference.as_str(), run_ticket.title.as_str()),
        (ticket.reference.as_str(), "Fix login")
    );
    assert_eq!(
        run.event.as_ref().unwrap().current,
        Some(serde_json::json!({ "tag": TAG }))
    );
    assert_eq!(run.steps, []);
    assert_eq!(
        workspace.automation_cursor(&automation.id).unwrap(),
        Some(workspace.workspace_event_head().unwrap())
    );
    assert_eq!(workspace.queue_automation_runs().unwrap(), 0);
    assert_eq!(runs(&workspace, &automation).len(), 1);
}

#[test]
fn a_tag_added_while_nothing_was_matching_starts_a_run_at_the_next_match_once() {
    let (dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let ticket = workspace.create_ticket("Fix login").unwrap();
    drop(workspace);
    // The desktop is closed; the CLI, a process of its own, tags the ticket.
    let path = dir.path().join("runs.sqlite3");
    let mut cli = Workspace::open(&path).unwrap();
    cli.add_tag(&ticket.reference, TAG).unwrap();
    drop(cli);

    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.queue_automation_runs().unwrap(), 1);
    assert_eq!(workspace.queue_automation_runs().unwrap(), 0);
    assert_eq!(runs(&workspace, &automation).len(), 1);
}

#[test]
fn a_tag_added_before_the_automation_was_switched_on_starts_nothing() {
    let (_dir, mut workspace) = workspace();
    tagged(&mut workspace, "Tagged earlier");
    let automation = triage(&mut workspace);

    assert_eq!(workspace.queue_automation_runs().unwrap(), 0);
    assert_eq!(runs(&workspace, &automation), []);
}

#[test]
fn a_change_made_by_an_automation_starts_no_run() {
    let (dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let ticket = workspace.create_ticket("Fix login").unwrap();
    // An agent inside a run tags the ticket through the CLI.
    let mut agent = Workspace::open(dir.path().join("runs.sqlite3")).unwrap();
    agent.act_for_automation().unwrap();
    agent.add_tag(&ticket.reference, TAG).unwrap();

    assert_eq!(workspace.queue_automation_runs().unwrap(), 0);
    assert_eq!(runs(&workspace, &automation), []);
    // The event was read all the same: it does not come back later.
    assert_eq!(
        workspace.automation_cursor(&automation.id).unwrap(),
        Some(workspace.workspace_event_head().unwrap())
    );
}

#[test]
fn every_condition_must_hold_for_the_ticket() {
    let (_dir, mut workspace) = workspace();
    let automation = automation_on(
        &mut workspace,
        vec![Condition::Tag {
            tag: "wontfix".into(),
            has: false,
        }],
        |agent| vec![run_agent("triage", agent, None)],
    );
    let excluded = workspace.create_ticket("Excluded").unwrap();
    workspace.add_tag(&excluded.reference, "wontfix").unwrap();
    workspace.add_tag(&excluded.reference, TAG).unwrap();
    let included = tagged(&mut workspace, "Included");

    assert_eq!(workspace.queue_automation_runs().unwrap(), 1);
    let queued = runs(&workspace, &automation);
    assert_eq!(queued[0].ticket.as_ref().unwrap().id, included.id);
}

#[test]
fn a_ticket_has_one_active_run_per_automation() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let ticket = tagged(&mut workspace, "Fix login");
    workspace.queue_automation_runs().unwrap();
    let retag = |workspace: &mut Workspace| {
        workspace.remove_tag(&ticket.reference, TAG).unwrap();
        workspace.add_tag(&ticket.reference, TAG).unwrap();
        workspace.queue_automation_runs().unwrap()
    };

    // Queued, then Running: the matching event is skipped both times.
    assert_eq!(retag(&mut workspace), 0);
    let run = workspace.start_automation_runs(2).unwrap().remove(0);
    assert_eq!(retag(&mut workspace), 0);
    assert_eq!(runs(&workspace, &automation).len(), 1);

    // Another Automation on the same tag has its own run for the ticket.
    let second = triage(&mut workspace);
    assert_eq!(retag(&mut workspace), 1);
    assert_eq!(runs(&workspace, &second).len(), 1);

    // Once the run has ended, the tag starts a new one.
    workspace.advance_automation_run(&run.id, None).unwrap();
    workspace
        .advance_automation_run(&run.id, Some(StepOutcome::Completed))
        .unwrap();
    assert_eq!(retag(&mut workspace), 1);
    assert_eq!(runs(&workspace, &automation).len(), 2);
}

#[test]
fn queued_runs_start_in_event_order_up_to_the_limit() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let tickets = ["First", "Second", "Third"].map(|title| tagged(&mut workspace, title));
    workspace.queue_automation_runs().unwrap();
    let ids = |runs: &[AutomationRun]| -> Vec<String> {
        runs.iter()
            .map(|run| run.ticket.as_ref().unwrap().id.clone())
            .collect()
    };

    let first = workspace.start_automation_runs(2).unwrap();
    assert_eq!(ids(&first), [tickets[0].id.clone(), tickets[1].id.clone()]);
    assert!(
        first
            .iter()
            .all(|run| run.status == AutomationRunStatus::Running && run.started_at.is_some())
    );
    // Two are running, so the third waits.
    assert_eq!(workspace.start_automation_runs(2).unwrap(), []);

    workspace
        .advance_automation_run(&first[0].id, None)
        .unwrap();
    workspace
        .advance_automation_run(&first[0].id, Some(StepOutcome::Completed))
        .unwrap();
    let next = workspace.start_automation_runs(2).unwrap();
    assert_eq!(ids(&next), [tickets[2].id.clone()]);
}

#[test]
fn a_run_executes_the_definition_it_was_created_with() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let run = started(&mut workspace);

    let mut edited = automation.definition.clone();
    edited.name = "Renamed".into();
    edited.steps.insert(0, notify("added-later"));
    workspace.update_automation(&automation.id, edited).unwrap();

    assert_eq!(
        workspace.automation_run(&run.id).unwrap().definition,
        automation.definition
    );
    assert_eq!(
        handed(workspace.advance_automation_run(&run.id, None).unwrap()),
        "triage"
    );
}

#[test]
fn a_straight_flow_runs_each_step_in_turn_and_ends_completed() {
    let (_dir, mut workspace) = workspace();
    automation_on(&mut workspace, Vec::new(), |agent| {
        vec![run_agent("triage", agent, None), notify("tell-me")]
    });
    let run = started(&mut workspace);

    assert_eq!(
        handed(workspace.advance_automation_run(&run.id, None).unwrap()),
        "triage"
    );
    let running = workspace.automation_run(&run.id).unwrap();
    assert_eq!(running.steps.len(), 1);
    assert_eq!(running.steps[0].status, AutomationStepStatus::Running);

    assert_eq!(
        handed(
            workspace
                .advance_automation_run(&run.id, Some(StepOutcome::Completed))
                .unwrap()
        ),
        "tell-me"
    );
    assert_eq!(
        workspace
            .advance_automation_run(&run.id, Some(StepOutcome::Completed))
            .unwrap(),
        RunAction::End(RunEnd::Completed)
    );

    let ended = workspace.automation_run(&run.id).unwrap();
    assert_eq!(ended.status, AutomationRunStatus::Completed);
    assert_eq!(ended.reason, None);
    assert!(ended.ended_at.is_some());
    assert_eq!(
        ended
            .steps
            .iter()
            .map(|step| (step.step_id.as_str(), step.status, step.ended_at.is_some()))
            .collect::<Vec<_>>(),
        [
            ("triage", AutomationStepStatus::Completed, true),
            ("tell-me", AutomationStepStatus::Completed, true)
        ]
    );
    // An ended run takes no more outcomes, and keeps what it recorded.
    assert_eq!(
        workspace
            .advance_automation_run(&run.id, Some(StepOutcome::Completed))
            .unwrap(),
        RunAction::Ended
    );
    assert_eq!(workspace.automation_run(&run.id).unwrap(), ended);
}

#[test]
fn a_failed_step_without_a_failure_path_ends_the_run_needing_attention_with_the_reason() {
    let (_dir, mut workspace) = workspace();
    automation_on(&mut workspace, Vec::new(), |agent| {
        vec![run_agent("triage", agent, None), notify("never-reached")]
    });
    let run = started(&mut workspace);
    workspace.advance_automation_run(&run.id, None).unwrap();

    let reason = "The agent reached its turn limit.";
    assert_eq!(
        workspace
            .advance_automation_run(&run.id, failed(reason))
            .unwrap(),
        RunAction::End(RunEnd::NeedsAttention {
            reason: reason.into()
        })
    );

    let ended = workspace.automation_run(&run.id).unwrap();
    assert_eq!(ended.status, AutomationRunStatus::NeedsAttention);
    assert_eq!(ended.reason.as_deref(), Some(reason));
    assert_eq!(ended.steps.len(), 1);
    assert_eq!(ended.steps[0].status, AutomationStepStatus::Failed);
    assert_eq!(ended.steps[0].reason.as_deref(), Some(reason));
}

#[test]
fn a_failed_step_with_a_failure_path_follows_it_and_the_run_ends_completed() {
    let (_dir, mut workspace) = workspace();
    automation_on(&mut workspace, Vec::new(), |agent| {
        vec![
            run_agent("triage", agent, Some(vec![notify("tell-me-it-failed")])),
            notify("never-reached"),
        ]
    });
    let run = started(&mut workspace);
    workspace.advance_automation_run(&run.id, None).unwrap();

    assert_eq!(
        handed(
            workspace
                .advance_automation_run(&run.id, failed("The agent's process ended."))
                .unwrap()
        ),
        "tell-me-it-failed"
    );
    assert_eq!(
        workspace
            .advance_automation_run(&run.id, Some(StepOutcome::Completed))
            .unwrap(),
        RunAction::End(RunEnd::Completed)
    );

    let ended = workspace.automation_run(&run.id).unwrap();
    assert_eq!(ended.status, AutomationRunStatus::Completed);
    assert_eq!(ended.steps[0].status, AutomationStepStatus::Failed);
}

#[test]
fn an_if_continues_down_the_path_it_chose_and_nested_paths_end_the_run() {
    let (_dir, mut workspace) = workspace();
    let has = |tag: &str| {
        vec![Check::Tag {
            tag: tag.into(),
            has: true,
        }]
    };
    automation_on(&mut workspace, Vec::new(), |_| {
        vec![
            step(
                "outer",
                StepAction::If {
                    checks: has("outer-tag"),
                    yes: vec![notify("yes")],
                    no: vec![
                        step(
                            "inner",
                            StepAction::If {
                                checks: has("inner-tag"),
                                yes: vec![notify("inner-yes")],
                                no: Vec::new(),
                            },
                        ),
                        notify("after-inner"),
                    ],
                },
            ),
            notify("after-outer"),
        ]
    });
    let ticket = tagged(&mut workspace, "Fix login");
    workspace.add_tag(&ticket.reference, "inner-tag").unwrap();
    workspace.queue_automation_runs().unwrap();
    let run = workspace.start_automation_runs(2).unwrap().remove(0);

    // The core answers both Ifs from the ticket and hands over the step they reach.
    assert_eq!(
        handed(workspace.advance_automation_run(&run.id, None).unwrap()),
        "inner-yes"
    );
    // Paths never rejoin: the end of the path taken is the end of the run.
    assert_eq!(
        workspace
            .advance_automation_run(&run.id, Some(StepOutcome::Completed))
            .unwrap(),
        RunAction::End(RunEnd::Completed)
    );
    let ended = workspace.automation_run(&run.id).unwrap();
    assert_eq!(
        ended
            .steps
            .iter()
            .map(|step| (step.step_id.as_str(), step.status))
            .collect::<Vec<_>>(),
        [
            ("outer", AutomationStepStatus::Completed),
            ("inner", AutomationStepStatus::Completed),
            ("inner-yes", AutomationStepStatus::Completed)
        ]
    );
}

#[test]
fn stopping_a_running_run_ends_it_needing_attention_without_its_failure_path() {
    let (_dir, mut workspace) = workspace();
    automation_on(&mut workspace, Vec::new(), |agent| {
        vec![
            run_agent("triage", agent, Some(vec![notify("tell-me-it-failed")])),
            notify("never-reached"),
        ]
    });
    let run = started(&mut workspace);
    let RunAction::RunAgent(start) = workspace.advance_automation_run(&run.id, None).unwrap()
    else {
        panic!("the first step runs an agent");
    };

    let (stopped, working) = workspace.stop_automation_run(&run.id).unwrap();

    // The Chat of the agent that was working comes back from the same transaction
    // that ended the run, for the host to interrupt.
    assert_eq!(working, [start.chat_id]);
    assert_eq!(stopped.status, AutomationRunStatus::NeedsAttention);
    assert_eq!(stopped.reason.as_deref(), Some("You stopped this run."));
    assert!(stopped.ended_at.is_some());
    // The step it was on did not finish, and nothing after it runs: not even the
    // step's failure path.
    assert_eq!(
        stopped
            .steps
            .iter()
            .map(|step| (step.step_id.as_str(), step.status, step.reason.as_deref()))
            .collect::<Vec<_>>(),
        [(
            "triage",
            AutomationStepStatus::Failed,
            Some("You stopped this run.")
        )]
    );
    // The agent's turn ends a moment later; its outcome no longer moves the run.
    assert_eq!(
        workspace
            .advance_automation_run(&run.id, Some(StepOutcome::Completed))
            .unwrap(),
        RunAction::Ended
    );
    assert_eq!(workspace.automation_run(&run.id).unwrap(), stopped);
    // Stopping it again is not an error: it is returned as it ended, with no agent
    // left to close.
    let (again, working) = workspace.stop_automation_run(&run.id).unwrap();
    assert_eq!((again, working), (stopped, Vec::new()));
}

#[test]
fn stopping_a_queued_run_ends_it_before_any_step_runs() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    tagged(&mut workspace, "Fix login");
    workspace.queue_automation_runs().unwrap();
    let queued = runs(&workspace, &automation).remove(0);

    let (stopped, working) = workspace.stop_automation_run(&queued.id).unwrap();

    assert_eq!(working, [] as [String; 0]);
    assert_eq!(stopped.status, AutomationRunStatus::NeedsAttention);
    assert_eq!(stopped.steps, []);
    assert_eq!(workspace.start_automation_runs(2).unwrap(), []);
}

#[test]
fn running_again_queues_a_new_run_from_the_first_step_with_the_same_event() {
    let (_dir, mut workspace) = workspace();
    let automation = automation_on(&mut workspace, Vec::new(), |agent| {
        vec![run_agent("triage", agent, None), notify("tell-me")]
    });
    let first = started(&mut workspace);
    workspace.advance_automation_run(&first.id, None).unwrap();
    // A run still going cannot be run again.
    assert!(workspace.run_automation_again(&first.id).is_err());
    workspace
        .advance_automation_run(&first.id, failed("The agent's process ended."))
        .unwrap();
    // Nothing retries by itself.
    assert_eq!(workspace.queue_automation_runs().unwrap(), 0);
    assert_eq!(workspace.start_automation_runs(2).unwrap(), []);
    // The person fixes the cause: the Automation is edited before the retry.
    let mut fixed = automation.definition.clone();
    fixed.steps.truncate(1);
    workspace.update_automation(&automation.id, fixed).unwrap();

    let again = workspace.run_automation_again(&first.id).unwrap();

    assert_ne!(again.id, first.id);
    assert_eq!(again.status, AutomationRunStatus::Queued);
    assert_eq!(again.event, first.event);
    assert_eq!(again.ticket, first.ticket);
    assert_eq!(again.steps, []);
    // It runs the Automation as it is now.
    assert_eq!(again.definition.steps.len(), 1);
    // The first run is history and stays as it ended.
    let earlier = workspace.automation_run(&first.id).unwrap();
    assert_eq!(earlier.status, AutomationRunStatus::NeedsAttention);
    assert_eq!(earlier.definition.steps.len(), 2);
    assert_eq!(runs(&workspace, &automation).len(), 2);
    // The ticket has an active run now, so a second retry waits for it.
    assert!(workspace.run_automation_again(&first.id).is_err());

    let started = workspace.start_automation_runs(2).unwrap();
    assert_eq!(started.len(), 1);
    assert_eq!(
        handed(workspace.advance_automation_run(&again.id, None).unwrap()),
        "triage"
    );
}

#[test]
fn a_chat_owned_by_a_run_stays_out_of_the_chat_list() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let run = started(&mut workspace);
    let mine = workspace
        .create_chat(
            None,
            NewChat {
                title: Some("Triage".into()),
                harness: "codex".into(),
                execution_folder: folder(),
                folder_managed: false,
                links: Vec::new(),
            },
        )
        .unwrap();

    let RunAction::RunAgent(start) = workspace.advance_automation_run(&run.id, None).unwrap()
    else {
        panic!("the run begins with its agent");
    };

    let listed = workspace.list_chats(ChatListFilter::Active).unwrap();
    assert_eq!(
        listed.iter().map(|chat| &chat.id).collect::<Vec<_>>(),
        [&mine.id]
    );
    assert_eq!(
        workspace.automation_run(&run.id).unwrap().steps[0]
            .chat_id
            .as_deref(),
        Some(start.chat_id.as_str())
    );
    // The run reaches its Chat directly. It works in the step's folder, with the
    // agent's harness, linked to the ticket and named for the Automation and ticket.
    let chat = workspace.chat(&start.chat_id).unwrap();
    let ticket = run.ticket.as_ref().unwrap();
    assert_eq!(chat.execution_folder, folder());
    assert_eq!(chat.harness, start.agent.settings.harness.as_str());
    assert_eq!(
        chat.title.as_deref(),
        Some(format!("Triage: {} {}", ticket.reference, ticket.title).as_str())
    );
    assert_eq!(
        chat.links,
        [ChatLink {
            kind: ChatLinkKind::Ticket,
            id: ticket.id.clone()
        }]
    );
}

#[test]
fn runs_left_running_by_a_process_that_is_gone_end_needing_attention() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let run = started(&mut workspace);
    workspace.advance_automation_run(&run.id, None).unwrap();
    tagged(&mut workspace, "Still queued");
    workspace.queue_automation_runs().unwrap();

    assert_eq!(
        workspace
            .end_running_automation_runs(&[], "ticketd was restarted")
            .unwrap(),
        1
    );

    let ended = workspace.automation_run(&run.id).unwrap();
    assert_eq!(ended.status, AutomationRunStatus::NeedsAttention);
    assert_eq!(ended.reason.as_deref(), Some("ticketd was restarted"));
    assert_eq!(ended.steps[0].status, AutomationStepStatus::Failed);
    // The queued run was never started, so it still runs.
    assert_eq!(workspace.start_automation_runs(2).unwrap().len(), 1);
}

#[test]
fn only_running_runs_nobody_is_executing_are_ended_as_left_behind() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let going = started(&mut workspace);
    let left = started(&mut workspace);

    assert_eq!(
        workspace
            .end_running_automation_runs(std::slice::from_ref(&going.id), "left behind")
            .unwrap(),
        1
    );

    let status = |id: &str| workspace.automation_run(id).unwrap().status;
    assert_eq!(status(&going.id), AutomationRunStatus::Running);
    assert_eq!(status(&left.id), AutomationRunStatus::NeedsAttention);
}

#[test]
fn a_run_its_executor_cannot_go_on_with_ends_needing_attention_with_the_reason() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let (run, _chat) = on_agent_step(&mut workspace);

    assert!(workspace.fail_automation_run(&run.id, "lost").unwrap());

    let failed = workspace.automation_run(&run.id).unwrap();
    assert_eq!(failed.status, AutomationRunStatus::NeedsAttention);
    assert_eq!(failed.reason.as_deref(), Some("lost"));
    assert_eq!(failed.steps[0].status, AutomationStepStatus::Failed);
    assert!(failed.needs_you);
    // The slot is free again, and a run that has ended stays as it ended.
    assert_eq!(workspace.start_automation_runs(1).unwrap().len(), 0);
    assert!(!workspace.fail_automation_run(&run.id, "again").unwrap());
    assert_eq!(workspace.automation_run(&run.id).unwrap(), failed);
}

#[test]
fn a_run_stopped_before_its_agent_starts_leaves_no_chat_behind() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let run = started(&mut workspace);
    workspace.stop_automation_run(&run.id).unwrap();

    assert_eq!(
        workspace.advance_automation_run(&run.id, None).unwrap(),
        RunAction::Ended
    );

    assert_eq!(listed_chats(&workspace), [] as [String; 0]);
    assert_eq!(workspace.automation_run(&run.id).unwrap().steps, []);
}

#[test]
fn running_again_is_refused_while_the_automation_is_unfinished() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let (run, _chat) = needing_attention(&mut workspace);
    // The step loses its folder: the Automation can no longer run as it is.
    let mut definition = automation.definition.clone();
    definition.steps = vec![step(
        "triage",
        StepAction::RunAgent {
            agent_id: None,
            execution_folder: None,
            on_failure: None,
        },
    )];
    workspace
        .update_automation(&automation.id, definition)
        .unwrap();

    let refused = workspace.run_automation_again(&run.id);

    assert!(
        matches!(&refused, Err(ticketd_core::Error::AutomationUnfinished(reason)) if reason == "Run agent: needs an agent and a folder"),
        "{refused:?}"
    );
    assert_eq!(runs(&workspace, &automation).len(), 1);
    assert!(workspace.automation_run(&run.id).unwrap().needs_you);
}

#[test]
fn deleting_an_automation_ends_its_active_runs_and_asks_nothing_of_the_person() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let (running, chat) = on_agent_step(&mut workspace);
    tagged(&mut workspace, "Still queued");
    workspace.queue_automation_runs().unwrap();

    // The agent that was working is handed back for the host to interrupt.
    assert_eq!(workspace.delete_automation(&automation.id).unwrap(), [chat]);

    let ended = workspace.all_automation_runs().unwrap();
    assert_eq!(ended.len(), 2);
    for run in &ended {
        assert_eq!(run.status, AutomationRunStatus::NeedsAttention);
        assert_eq!(run.reason.as_deref(), Some("You deleted this Automation."));
        assert!(!run.needs_you);
    }
    assert_eq!(needing_you(&workspace), 0);
    assert_eq!(workspace.inbox(10, 0).unwrap(), []);
    // Nothing is left to start, and the agent's outcome is not recorded.
    assert_eq!(workspace.start_automation_runs(2).unwrap().len(), 0);
    assert_eq!(
        workspace
            .advance_automation_run(&running.id, Some(StepOutcome::Completed))
            .unwrap(),
        RunAction::Ended
    );
}

#[test]
fn the_upkeep_removes_finished_runs_older_than_90_days_with_their_chats() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let run = started(&mut workspace);
    let RunAction::RunAgent(start) = workspace.advance_automation_run(&run.id, None).unwrap()
    else {
        panic!("the run begins with its agent");
    };
    let chat = start.chat_id;
    workspace
        .save_chat_input(None, &chat, "Triage this")
        .unwrap();
    workspace
        .advance_automation_run(&run.id, Some(StepOutcome::Completed))
        .unwrap();
    let active = started(&mut workspace);
    let created = chrono::DateTime::parse_from_rfc3339(&run.created_at).unwrap();
    let after = |duration: chrono::Duration| Some((created + duration).to_rfc3339());

    workspace
        .upkeep(after(chrono::Duration::days(89)).as_deref())
        .unwrap();
    assert_eq!(runs(&workspace, &automation).len(), 2);

    workspace
        .upkeep(after(chrono::Duration::days(91)).as_deref())
        .unwrap();
    // A run that has not ended is never removed, however old.
    let kept = runs(&workspace, &automation);
    assert_eq!(
        kept.iter().map(|run| &run.id).collect::<Vec<_>>(),
        [&active.id]
    );
    assert!(workspace.chat(&chat).is_err());
}

#[test]
fn the_previous_format_gains_run_storage_without_losing_records() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    // Format 76 had Automations but no runs, and Chats that no run owned.
    ticketd_core::create_workspace_at_format_version(&path, 76).unwrap();
    let chat = "22222222-2222-4222-8222-222222222222";
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(&format!(
        "INSERT INTO tickets (id, title, status, reference) VALUES ('11111111-1111-4111-8111-111111111111', 'Kept', 'Todo', 'T-1');
         INSERT INTO chats (id, title, harness, execution_folder) VALUES ('{chat}', 'Mine', 'codex', '/work/app');"
    ))
    .unwrap();
    drop(db);

    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.show_ticket("T-1").unwrap().title, "Kept");
    assert_eq!(
        workspace.list_chats(ChatListFilter::Active).unwrap()[0].id,
        chat
    );
    triage(&mut workspace);
    assert_eq!(started(&mut workspace).status, AutomationRunStatus::Running);
}

#[test]
fn an_automation_this_build_cannot_read_does_not_stop_the_others() {
    let (dir, mut workspace) = workspace();
    let unreadable = triage(&mut workspace);
    let readable = triage(&mut workspace);
    // As a newer ticketd on another device would leave it.
    let db = rusqlite::Connection::open(dir.path().join("runs.sqlite3")).unwrap();
    db.execute(
        "UPDATE automations SET definition = json_set(definition, '$.schema_version', 99) WHERE id = ?1",
        [&unreadable.id],
    )
    .unwrap();
    drop(db);
    let cursor = workspace.automation_cursor(&unreadable.id).unwrap();
    tagged(&mut workspace, "Fix login");

    assert_eq!(workspace.queue_automation_runs().unwrap(), 1);
    assert_eq!(runs(&workspace, &readable).len(), 1);
    // Its events wait for a build that can read it.
    assert_eq!(workspace.automation_cursor(&unreadable.id).unwrap(), cursor);
}

#[test]
fn every_run_is_listed_across_automations_newest_first_naming_its_automation() {
    let (_dir, mut workspace) = workspace();
    let triage = triage(&mut workspace);
    let verify = triage_named(&mut workspace, "Verify on staging");
    tagged(&mut workspace, "Fix login");
    workspace.queue_automation_runs().unwrap();
    tagged(&mut workspace, "Reset email");
    workspace.queue_automation_runs().unwrap();

    let runs = workspace.all_automation_runs().unwrap();

    let title = |run: &AutomationRun| run.ticket.as_ref().unwrap().title.clone();
    assert_eq!(
        runs.iter().map(title).collect::<Vec<_>>(),
        ["Reset email", "Reset email", "Fix login", "Fix login"]
    );
    let mut named: Vec<_> = runs[..2]
        .iter()
        .map(|run| (run.automation_name.as_str(), run.automation_id.as_str()))
        .collect();
    named.sort_unstable();
    assert_eq!(
        named,
        [
            ("Triage", triage.id.as_str()),
            ("Verify on staging", verify.id.as_str())
        ]
    );

    // A run names its Automation as it is called now, and outlives it.
    workspace
        .update_automation(
            &triage.id,
            AutomationDefinition {
                name: "Triage new tickets".into(),
                ..triage.definition.clone()
            },
        )
        .unwrap();
    workspace.delete_automation(&verify.id).unwrap();
    let mut names: Vec<_> = workspace
        .all_automation_runs()
        .unwrap()
        .into_iter()
        .map(|run| run.automation_name)
        .collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names, ["Triage new tickets", "Verify on staging"]);
}

const LIMIT: &str = "The agent reached its limit of 40 turns before finishing.";

/// A run on its agent step, with that step's Chat.
#[allow(clippy::unwrap_used, clippy::panic)]
fn on_agent_step(workspace: &mut Workspace) -> (AutomationRun, String) {
    let run = started(workspace);
    let RunAction::RunAgent(start) = workspace.advance_automation_run(&run.id, None).unwrap()
    else {
        panic!("the run begins with its agent");
    };
    (run, start.chat_id)
}

/// A run whose agent step failed with no failure path, with that step's Chat.
#[allow(clippy::unwrap_used)]
fn needing_attention(workspace: &mut Workspace) -> (AutomationRun, String) {
    let (run, chat) = on_agent_step(workspace);
    workspace
        .advance_automation_run(&run.id, failed(LIMIT))
        .unwrap();
    (workspace.automation_run(&run.id).unwrap(), chat)
}

#[allow(clippy::unwrap_used)]
fn needing_you(workspace: &Workspace) -> u32 {
    workspace.sidebar_counts().unwrap().runs_needing_you
}

#[allow(clippy::unwrap_used)]
fn listed_chats(workspace: &Workspace) -> Vec<String> {
    workspace
        .list_chats(ChatListFilter::Active)
        .unwrap()
        .into_iter()
        .map(|chat| chat.id)
        .collect()
}

#[test]
fn a_run_that_needs_attention_is_counted_and_enters_the_inbox_for_its_ticket() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    assert_eq!(needing_you(&workspace), 0);

    let (run, _chat) = needing_attention(&mut workspace);

    assert!(run.needs_you);
    assert_eq!(needing_you(&workspace), 1);
    let inbox = workspace.inbox(10, 0).unwrap();
    assert_eq!(inbox.len(), 1);
    let entry = &inbox[0];
    assert_eq!(entry.reference, run.ticket.as_ref().unwrap().reference);
    assert_eq!(
        (
            entry.kind.as_str(),
            entry.from_value.as_str(),
            entry.to_value.as_str(),
            entry.editing_agent.as_deref(),
            entry.read
        ),
        (
            "automation_run",
            run.id.as_str(),
            LIMIT,
            Some("Triage"),
            false
        )
    );

    // Looking at the run, or at the inbox entry, is not acting on it.
    workspace.set_inbox_read(&[entry.id], true).unwrap();
    assert!(workspace.automation_run(&run.id).unwrap().needs_you);
    assert_eq!(needing_you(&workspace), 1);
}

#[test]
fn a_run_that_completed_or_is_still_going_does_not_need_you() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let (run, _chat) = on_agent_step(&mut workspace);
    assert!(!workspace.automation_run(&run.id).unwrap().needs_you);

    workspace
        .advance_automation_run(&run.id, Some(StepOutcome::Completed))
        .unwrap();

    assert!(!workspace.automation_run(&run.id).unwrap().needs_you);
    assert_eq!(needing_you(&workspace), 0);
    assert_eq!(workspace.inbox(10, 0).unwrap(), []);
}

#[test]
fn a_run_the_person_stopped_or_ticketd_left_behind_needs_them_too() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let (stopped, _chat) = on_agent_step(&mut workspace);
    workspace.stop_automation_run(&stopped.id).unwrap();
    let (left, _chat) = on_agent_step(&mut workspace);
    workspace
        .end_running_automation_runs(&[], "closed")
        .unwrap();
    let (turned_off, _chat) = on_agent_step(&mut workspace);
    workspace
        .stop_and_turn_off_automation(&automation.id)
        .unwrap();

    assert_eq!(needing_you(&workspace), 3);
    let inbox = workspace.inbox(10, 0).unwrap();
    assert_eq!(
        inbox
            .iter()
            .map(|entry| &entry.from_value)
            .collect::<Vec<_>>(),
        [&turned_off.id, &left.id, &stopped.id]
    );
}

#[test]
fn dismissing_a_run_clears_needs_attention_and_leaves_the_run_as_it_ended() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let (run, _chat) = needing_attention(&mut workspace);

    let dismissed = workspace.dismiss_automation_run(&run.id).unwrap();

    assert!(!dismissed.needs_you);
    assert_eq!(dismissed.answer, Some(RunAnswer::Dismissed));
    assert_eq!(dismissed.status, AutomationRunStatus::NeedsAttention);
    assert_eq!(dismissed.reason.as_deref(), Some(LIMIT));
    assert_eq!(needing_you(&workspace), 0);
    // The inbox entry stays, answered.
    assert!(workspace.inbox(10, 0).unwrap()[0].read);
    assert_eq!(workspace.inbox_page(10, 0, true).unwrap(), []);
}

#[test]
fn running_again_clears_needs_attention_on_the_run_it_repeats() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let (run, _chat) = needing_attention(&mut workspace);

    let again = workspace.run_automation_again(&run.id).unwrap();

    let answered = workspace.automation_run(&run.id).unwrap();
    assert!(!answered.needs_you);
    assert_eq!(answered.answer, Some(RunAnswer::RanAgain));
    assert!(!again.needs_you);
    assert_eq!(again.answer, None);
    assert_eq!(needing_you(&workspace), 0);
    assert_eq!(workspace.inbox_page(10, 0, true).unwrap(), []);
}

#[test]
fn a_run_of_a_deleted_automation_says_so_and_running_it_again_is_refused_in_words() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let (run, _chat) = needing_attention(&mut workspace);
    assert!(!run.automation_deleted);

    workspace.delete_automation(&automation.id).unwrap();

    assert!(
        workspace
            .automation_run(&run.id)
            .unwrap()
            .automation_deleted
    );
    let refused = workspace.run_automation_again(&run.id).unwrap_err();
    assert_eq!(
        refused.to_string(),
        "Its Automation was deleted, so it cannot be run again."
    );
}

#[test]
fn replying_in_the_chat_of_a_run_that_needs_attention_takes_it_over() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let (run, chat) = needing_attention(&mut workspace);
    assert_eq!(listed_chats(&workspace), [] as [String; 0]);
    assert_eq!(workspace.automation_run_taken_over_in(&chat).unwrap(), None);

    let taken = workspace
        .take_over_automation_run(&chat, true)
        .unwrap()
        .unwrap();

    assert_eq!(taken.id, run.id);
    // The Chat can say which run it was taken over from.
    assert_eq!(
        workspace.automation_run_taken_over_in(&chat).unwrap(),
        Some(taken.clone())
    );
    assert_eq!(taken.status, AutomationRunStatus::TakenOver);
    assert!(!taken.needs_you);
    assert_eq!(needing_you(&workspace), 0);
    assert_eq!(workspace.inbox_page(10, 0, true).unwrap(), []);
    // The step keeps why it failed, and its Chat is the person's now.
    assert_eq!(taken.steps[0].reason.as_deref(), Some(LIMIT));
    assert_eq!(taken.steps[0].chat_id.as_deref(), Some(chat.as_str()));
    assert_eq!(listed_chats(&workspace), std::slice::from_ref(&chat));
    // A second message in what is now an ordinary Chat changes nothing.
    assert_eq!(
        workspace.take_over_automation_run(&chat, true).unwrap(),
        None
    );
}

#[test]
fn replying_in_the_chat_of_a_running_run_ends_it_taken_over_with_the_rest_not_run() {
    let (_dir, mut workspace) = workspace();
    automation_on(&mut workspace, Vec::new(), |agent| {
        vec![
            run_agent("triage", agent, Some(vec![notify("tell")])),
            notify("after"),
        ]
    });
    let (run, chat) = on_agent_step(&mut workspace);

    let taken = workspace
        .take_over_automation_run(&chat, true)
        .unwrap()
        .unwrap();

    assert_eq!(taken.status, AutomationRunStatus::TakenOver);
    assert!(taken.ended_at.is_some());
    // The step it was on ended there; nothing after it, its failure path included,
    // was reached.
    assert_eq!(
        taken
            .steps
            .iter()
            .map(|step| (step.step_id.as_str(), step.status))
            .collect::<Vec<_>>(),
        [("triage", AutomationStepStatus::Failed)]
    );
    assert_eq!(
        taken.steps[0].reason.as_deref(),
        Some("You took this run over.")
    );
    assert!(taken.steps[0].ended_at.is_some());
    assert_eq!(listed_chats(&workspace), [chat]);
    assert_eq!(needing_you(&workspace), 0);
    assert_eq!(workspace.inbox(10, 0).unwrap(), []);
    // What the agent's turn reports afterwards is not recorded.
    assert_eq!(
        workspace
            .advance_automation_run(&run.id, Some(StepOutcome::Completed))
            .unwrap(),
        RunAction::Ended
    );
    assert_eq!(
        workspace.automation_run(&run.id).unwrap().status,
        AutomationRunStatus::TakenOver
    );
    // The ticket is free for a new run of the Automation.
    workspace.run_automation_again(&run.id).unwrap();
}

#[test]
fn a_takeover_reply_has_its_own_receipt_and_can_be_retried_after_takeover() {
    let (dir, mut workspace) = workspace();
    triage(&mut workspace);
    let (run, chat) = on_agent_step(&mut workspace);
    let ordinary = workspace
        .save_chat_input(Some("ordinary"), &chat, "Same text")
        .unwrap();
    let takeover = |workspace: &mut Workspace, command_id| {
        workspace.save_automation_chat_reply_with_change(
            Some(command_id),
            &chat,
            "Same text",
            &[],
            None,
        )
    };
    assert!(matches!(
        takeover(&mut workspace, "ordinary"),
        Err(Error::RequestConflict(id)) if id == "ordinary"
    ));
    assert_eq!(
        workspace.automation_run(&run.id).unwrap().status,
        AutomationRunStatus::Running
    );
    // A legacy receipt matches its fields but cannot stand in for a new takeover.
    let receipts = rusqlite::Connection::open(dir.path().join("runs.sqlite3")).unwrap();
    let remove_source = |command_id| {
        receipts
            .execute(
                "UPDATE request_outcomes SET request = json_remove(request, '$.input_source') WHERE id = ?1",
                [command_id],
            )
            .unwrap();
    };
    remove_source("ordinary");
    assert_eq!(
        workspace
            .save_chat_input(Some("ordinary"), &chat, "Same text")
            .unwrap(),
        ordinary
    );
    assert!(matches!(
        takeover(&mut workspace, "ordinary"),
        Err(Error::RequestConflict(id)) if id == "ordinary"
    ));

    let (reply, ended) = takeover(&mut workspace, "takeover").unwrap();
    assert_eq!(ended.unwrap().status, AutomationRunStatus::TakenOver);
    assert_eq!(
        takeover(&mut workspace, "takeover").unwrap(),
        (reply.clone(), None)
    );
    assert_eq!(
        workspace
            .replay_chat_input("takeover", &chat, "Same text", &[])
            .unwrap(),
        reply.message
    );
    assert_eq!(
        workspace
            .save_chat_input(Some("takeover"), &chat, "Same text")
            .unwrap()
            .id,
        reply.id
    );

    remove_source("takeover");
    assert_eq!(
        takeover(&mut workspace, "takeover").unwrap(),
        (reply.clone(), None)
    );
    assert_eq!(
        workspace.chat_queue(&chat).unwrap(),
        [ordinary, reply.into_message().unwrap()]
    );
}

#[test]
fn a_linked_takeover_reply_keeps_its_context_requirement_through_backup_and_restore() {
    let (dir, mut workspace) = workspace();
    triage(&mut workspace);
    let (run, chat) = on_agent_step(&mut workspace);
    let ticket = workspace.create_ticket("Linked context").unwrap();
    let change = ChatInputChange::Link(vec![ChatLink {
        kind: ChatLinkKind::Ticket,
        id: ticket.id,
    }]);
    let (receipt, ended) = workspace
        .save_automation_chat_reply_with_change(None, &chat, "Take over", &[], Some(&change))
        .unwrap();
    let ended = ended.unwrap();
    assert_eq!(ended.id, run.id);
    assert_eq!(ended.status, AutomationRunStatus::TakenOver);
    let saved = receipt.into_message().unwrap();
    assert!(saved.queued && saved.requires_link_context);

    let backup = dir.path().join("backup.sqlite3");
    assert!(workspace.backup(&backup).unwrap());
    let target = dir.path().join("restored.sqlite3");
    Workspace::restore(&target, &backup).unwrap();
    let mut restored = Workspace::open(&target).unwrap();
    assert_eq!(
        restored.chat_queue(&chat).unwrap().as_slice(),
        std::slice::from_ref(&saved)
    );

    restored
        .record_chat_queue_submission(&chat, &saved.id, "attempt", ChatSubmissionIntent::NewTurn)
        .unwrap();
    assert!(restored.chat_queue(&chat).unwrap().is_empty());
    assert!(
        restored
            .chat_input_requires_link_context(&chat, &saved.id)
            .unwrap()
    );
    assert!(
        restored
            .chat_input_requires_link_context("other-chat", &saved.id)
            .is_err()
    );
}

#[test]
fn an_automation_can_record_only_its_saved_prompt() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let (run, chat) = on_agent_step(&mut workspace);
    let queued = workspace
        .save_chat_input(None, &chat, "Ordinary input")
        .unwrap();
    let otherwise = workspace
        .create_chat(
            None,
            NewChat {
                title: None,
                harness: "codex".to_owned(),
                execution_folder: folder(),
                folder_managed: false,
                links: Vec::new(),
            },
        )
        .unwrap();
    let reserved = format!("{chat}:first");
    for target in [&chat, &otherwise.id] {
        assert!(matches!(
            workspace.save_chat_input(Some(&reserved), target, "Pretend Prompt"),
            Err(ticketd_core::Error::RequestConflict(id)) if id == reserved
        ));
    }
    let regular = format!("{}:first", otherwise.id);
    let ordinary = workspace
        .save_chat_input(Some(&regular), &otherwise.id, "Ordinary use")
        .unwrap();
    assert_eq!(
        workspace
            .save_chat_input(Some(&regular), &otherwise.id, "Ordinary use")
            .unwrap()
            .id,
        ordinary.id
    );

    let prompt = workspace
        .save_automation_chat_prompt(&chat, &run.id, "Run Prompt")
        .unwrap();
    assert_eq!(
        workspace
            .save_automation_chat_prompt(&chat, &run.id, "Run Prompt")
            .unwrap()
            .id,
        prompt.id
    );
    assert!(
        workspace
            .record_automation_chat_submission(&chat, &run.id, &queued.id, "attempt")
            .is_err()
    );
    assert!(
        workspace
            .chat_queue(&chat)
            .unwrap()
            .iter()
            .any(|message| message.id == queued.id)
    );

    let submitted = workspace
        .record_automation_chat_submission(&chat, &run.id, &prompt.id, "attempt")
        .unwrap()
        .unwrap();
    assert_eq!(
        workspace
            .record_automation_chat_submission(&chat, &run.id, &prompt.id, "attempt")
            .unwrap()
            .unwrap(),
        submitted
    );
    assert_eq!(submitted.attempts.len(), 1);
    let queue = workspace.chat_queue(&chat).unwrap();
    assert_eq!(queue, [queued]);
}

#[test]
fn reserving_an_automation_prompt_does_not_break_an_older_ordinary_replay() {
    let (dir, mut workspace) = workspace();
    triage(&mut workspace);
    let (run, active) = on_agent_step(&mut workspace);
    let ordinary = workspace
        .create_chat(
            None,
            NewChat {
                title: None,
                harness: "codex".to_owned(),
                execution_folder: folder(),
                folder_managed: false,
                links: Vec::new(),
            },
        )
        .unwrap();
    let saved = workspace
        .save_chat_input(Some("legacy"), &ordinary.id, "Earlier request")
        .unwrap();
    let reserved = format!("{active}:first");
    rusqlite::Connection::open(dir.path().join("runs.sqlite3"))
        .unwrap()
        .execute(
            "UPDATE request_outcomes SET id = ?1 WHERE id = 'legacy'",
            [&reserved],
        )
        .unwrap();

    assert_eq!(
        workspace
            .save_chat_input(Some(&reserved), &ordinary.id, "Earlier request")
            .unwrap()
            .id,
        saved.id
    );
    assert_eq!(workspace.chat_queue(&ordinary.id).unwrap(), [saved]);
    assert_eq!(
        workspace.automation_run(&run.id).unwrap().status,
        AutomationRunStatus::Running
    );
}

#[test]
fn stopping_the_chat_takes_over_a_running_run_and_no_other() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let (_ended, ended_chat) = needing_attention(&mut workspace);
    let (running, chat) = on_agent_step(&mut workspace);

    // Nothing is going in the Chat of a run that has ended, so there is nothing to
    // take over by stopping it.
    assert_eq!(
        workspace
            .take_over_automation_run(&ended_chat, false)
            .unwrap(),
        None
    );
    assert_eq!(needing_you(&workspace), 1);
    let taken = workspace
        .take_over_automation_run(&chat, false)
        .unwrap()
        .unwrap();

    assert_eq!(taken.id, running.id);
    assert_eq!(taken.status, AutomationRunStatus::TakenOver);
    assert_eq!(listed_chats(&workspace), [chat]);
}

#[test]
fn replying_in_the_chat_of_a_completed_run_makes_it_an_ordinary_chat_of_a_completed_run() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let (run, chat) = on_agent_step(&mut workspace);
    workspace
        .advance_automation_run(&run.id, Some(StepOutcome::Completed))
        .unwrap();
    let token = workspace.change_token().unwrap();

    let after = workspace
        .take_over_automation_run(&chat, true)
        .unwrap()
        .unwrap();

    assert_eq!(after.status, AutomationRunStatus::Completed);
    assert!(!after.steps[0].chat_owned);
    assert_eq!(listed_chats(&workspace), [chat]);
    // #387 3B2: the run itself is unchanged, yet a view of it must hear that its
    // Chat is no longer the run's.
    assert_ne!(workspace.change_token().unwrap(), token);
}

#[test]
fn a_chat_that_was_taken_over_is_kept_when_its_run_is_removed_after_90_days() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let (run, chat) = needing_attention(&mut workspace);
    workspace.take_over_automation_run(&chat, true).unwrap();
    let (dismissed, owned) = needing_attention(&mut workspace);
    let created = chrono::DateTime::parse_from_rfc3339(&dismissed.created_at).unwrap();

    workspace
        .upkeep(Some(&(created + chrono::Duration::days(91)).to_rfc3339()))
        .unwrap();

    assert_eq!(runs(&workspace, &automation), []);
    assert!(workspace.automation_run(&run.id).is_err());
    assert_eq!(workspace.chat(&chat).unwrap().id, chat);
    assert_eq!(listed_chats(&workspace), [chat]);
    assert!(workspace.chat(&owned).is_err());
    // Nothing is left pointing at a run that is gone.
    assert_eq!(workspace.inbox(10, 0).unwrap(), []);
    assert_eq!(needing_you(&workspace), 0);
}

#[test]
fn a_ticket_lists_the_runs_that_acted_on_it_newest_first() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let (first, _chat) = needing_attention(&mut workspace);
    let ticket = first.ticket.clone().unwrap();
    let again = workspace.run_automation_again(&first.id).unwrap();
    let other = tagged(&mut workspace, "Another ticket");
    workspace.queue_automation_runs().unwrap();
    let untouched = workspace.create_ticket("No runs").unwrap();

    let listed = workspace.ticket_automation_runs(&ticket.reference).unwrap();

    assert_eq!(
        listed.iter().map(|run| &run.id).collect::<Vec<_>>(),
        [&again.id, &first.id]
    );
    assert_eq!(listed[0].automation_id, automation.id);
    assert_eq!(
        workspace
            .ticket_automation_runs(&other.reference)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        workspace
            .ticket_automation_runs(&untouched.reference)
            .unwrap(),
        []
    );
}

#[test]
fn the_previous_format_keeps_its_runs_and_the_ones_needing_attention_still_need_you() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    // Format 78 had runs but did not record whether the person answered one.
    ticketd_core::create_workspace_at_format_version(&path, 78).unwrap();
    let (ticket, agent, automation, run) = (
        "11111111-1111-4111-8111-111111111111",
        "00000000-0000-4000-8000-0000000000a1",
        "00000000-0000-4000-8000-0000000000a2",
        "00000000-0000-4000-8000-0000000000a3",
    );
    let definition = AutomationDefinition {
        name: "Triage".into(),
        trigger: Some(Trigger::TagAdded { tag: TAG.into() }),
        conditions: Vec::new(),
        steps: vec![run_agent("triage", agent, None)],
    };
    let stored = serde_json::json!({
        "schema_version": 1,
        "trigger": definition.trigger,
        "conditions": definition.conditions,
        "steps": definition.steps,
    });
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute(
        "INSERT INTO tickets (id, title, status, reference) VALUES (?1, 'Fix login', 'Todo', 'T-1')",
        [ticket],
    )
    .unwrap();
    db.execute(
        "INSERT INTO automation_agents (id, name, harness, model, instructions, read_files, edit_files, run_commands, allowed_commands, use_web, turn_limit, time_limit_minutes) \
         VALUES (?1, 'Agent', 'claude-code', NULL, '', 1, 0, 0, '[]', 0, 40, 20)",
        [agent],
    )
    .unwrap();
    db.execute(
        "INSERT INTO automations (id, name, definition) VALUES (?1, 'Triage', ?2)",
        rusqlite::params![automation, stored.to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO automation_device_state (automation_id, cursor) VALUES (?1, 0)",
        [automation],
    )
    .unwrap();
    // A run whose agent step failed with no failure path.
    db.execute(
        "INSERT INTO automation_runs (id, automation_id, event_id, event, ticket_id, definition, status, reason, started_at, ended_at) \
         VALUES (?1, ?2, 0, 'null', ?3, ?4, 'needs_attention', ?5, '2026-11-01T10:00:00.000Z', '2026-11-01T10:05:00.000Z')",
        rusqlite::params![run, automation, ticket, serde_json::to_string(&definition).unwrap(), LIMIT],
    )
    .unwrap();
    db.execute(
        "INSERT INTO automation_run_steps (run_id, position, step_id, status, reason, ended_at) \
         VALUES (?1, 0, 'triage', 'failed', ?2, '2026-11-01T10:05:00.000Z')",
        rusqlite::params![run, LIMIT],
    )
    .unwrap();
    drop(db);

    let workspace = Workspace::open(&path).unwrap();

    assert!(workspace.automation_run(run).unwrap().needs_you);
    assert_eq!(needing_you(&workspace), 1);
}

fn summary(run: AutomationRun) -> AutomationRunSummary {
    AutomationRunSummary {
        id: run.id,
        automation_id: run.automation_id,
        automation_name: run.automation_name,
        status: run.status,
        reason: run.reason,
        needs_you: run.needs_you,
        answer: run.answer,
        automation_deleted: run.automation_deleted,
        ticket: run.ticket,
        created_at: run.created_at,
    }
}

#[test]
fn run_summaries_and_running_runs_say_what_the_full_runs_say() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let other = triage(&mut workspace);
    let first = tagged(&mut workspace, "First");
    for title in ["Second", "Third"] {
        tagged(&mut workspace, title);
    }
    workspace.queue_automation_runs().unwrap();
    let started = workspace.start_automation_runs(3).unwrap();
    // One agent step under way, with its Chat; one run ended as Needs attention.
    workspace
        .advance_automation_run(&started[0].id, None)
        .unwrap();
    workspace
        .advance_automation_run(&started[1].id, None)
        .unwrap();
    workspace
        .advance_automation_run(&started[1].id, failed("No answer"))
        .unwrap();
    workspace.delete_automation(&other.id).unwrap();

    let scopes = [
        AutomationRunScope::All,
        AutomationRunScope::Automation(automation.id.clone()),
        AutomationRunScope::Ticket(first.reference.clone()),
    ];
    for scope in &scopes {
        let full = match scope {
            AutomationRunScope::All => workspace.all_automation_runs(),
            AutomationRunScope::Automation(id) => workspace.automation_runs(id),
            AutomationRunScope::Ticket(reference) => workspace.ticket_automation_runs(reference),
        }
        .unwrap();
        let expected: Vec<_> = full.into_iter().map(summary).collect();
        assert_eq!(
            workspace.automation_run_summaries(scope, 100, 0).unwrap(),
            expected,
            "{scope:?}"
        );
        assert_eq!(
            workspace.automation_run_summaries(scope, 2, 1).unwrap(),
            expected.into_iter().skip(1).take(2).collect::<Vec<_>>(),
            "{scope:?}, second page"
        );
    }

    let running: Vec<AutomationRun> = workspace
        .all_automation_runs()
        .unwrap()
        .into_iter()
        .filter(|run| run.status == AutomationRunStatus::Running)
        .collect();
    let chat_ids: Vec<String> = running
        .iter()
        .flat_map(|run| &run.steps)
        .filter_map(|step| step.chat_id.clone())
        .collect();
    assert!(!chat_ids.is_empty());
    assert_eq!(
        workspace.running_automation_runs().unwrap(),
        RunningAutomationRuns {
            runs: running.len(),
            chat_ids,
        }
    );
}
