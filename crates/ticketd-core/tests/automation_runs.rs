use ticketd_core::{
    Automation, AutomationAgentSettings, AutomationDefinition, AutomationRun, AutomationRunStatus,
    AutomationStepStatus, ChatLink, ChatLinkKind, ChatListFilter, Check, Condition, NewChat,
    NotifyTarget, RunAction, RunEnd, Step, StepAction, StepOutcome, Ticket, Trigger, Workspace,
};

const TAG: &str = "ready-for-triage";

#[allow(clippy::unwrap_used)] // A Workspace that cannot open fails the test during setup.
fn workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("runs.sqlite3")).unwrap();
    (dir, workspace)
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
            execution_folder: Some("/work/app".into()),
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

fn run_step(id: &str) -> RunAction {
    RunAction::RunStep { step_id: id.into() }
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
        workspace.advance_automation_run(&run.id, None).unwrap(),
        run_step("triage")
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
        workspace.advance_automation_run(&run.id, None).unwrap(),
        run_step("triage")
    );
    let running = workspace.automation_run(&run.id).unwrap();
    assert_eq!(running.steps.len(), 1);
    assert_eq!(running.steps[0].status, AutomationStepStatus::Running);

    assert_eq!(
        workspace
            .advance_automation_run(&run.id, Some(StepOutcome::Completed))
            .unwrap(),
        run_step("tell-me")
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
    // An ended run takes no more outcomes.
    assert!(
        workspace
            .advance_automation_run(&run.id, Some(StepOutcome::Completed))
            .is_err()
    );
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
        workspace
            .advance_automation_run(&run.id, failed("The agent's process ended."))
            .unwrap(),
        run_step("tell-me-it-failed")
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
    let checks = || {
        vec![Check::Tag {
            tag: "needs-fix".into(),
            has: true,
        }]
    };
    automation_on(&mut workspace, Vec::new(), |_| {
        vec![
            step(
                "outer",
                StepAction::If {
                    checks: checks(),
                    yes: vec![notify("yes")],
                    no: vec![
                        step(
                            "inner",
                            StepAction::If {
                                checks: checks(),
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
    let run = started(&mut workspace);
    let mut advance = |outcome| workspace.advance_automation_run(&run.id, outcome).unwrap();
    let branched = |yes| Some(StepOutcome::Branched { yes });

    assert_eq!(advance(None), run_step("outer"));
    assert_eq!(advance(branched(false)), run_step("inner"));
    assert_eq!(advance(branched(true)), run_step("inner-yes"));
    // Paths never rejoin: the end of the path taken is the end of the run.
    assert_eq!(
        advance(Some(StepOutcome::Completed)),
        RunAction::End(RunEnd::Completed)
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
    workspace.advance_automation_run(&run.id, None).unwrap();

    let stopped = workspace.stop_automation_run(&run.id).unwrap();

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
    assert!(
        workspace
            .advance_automation_run(&run.id, Some(StepOutcome::Completed))
            .is_err()
    );
    assert_eq!(workspace.automation_run(&run.id).unwrap(), stopped);
    // A run that has ended cannot be stopped again.
    assert!(workspace.stop_automation_run(&run.id).is_err());
}

#[test]
fn stopping_a_queued_run_ends_it_before_any_step_runs() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    tagged(&mut workspace, "Fix login");
    workspace.queue_automation_runs().unwrap();
    let queued = runs(&workspace, &automation).remove(0);

    let stopped = workspace.stop_automation_run(&queued.id).unwrap();

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
        workspace.advance_automation_run(&again.id, None).unwrap(),
        run_step("triage")
    );
}

#[test]
fn a_chat_owned_by_a_run_stays_out_of_the_chat_list() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let run = started(&mut workspace);
    workspace.advance_automation_run(&run.id, None).unwrap();
    let new_chat = || NewChat {
        title: Some("Triage".into()),
        harness: "codex".into(),
        execution_folder: "/work/app".into(),
        folder_managed: false,
        links: vec![ChatLink {
            kind: ChatLinkKind::Ticket,
            id: run.ticket.as_ref().unwrap().id.clone(),
        }],
    };
    let mine = workspace.create_chat(None, new_chat()).unwrap();

    let owned = workspace
        .create_automation_run_chat(&run.id, "triage", new_chat())
        .unwrap();

    let listed = workspace.list_chats(ChatListFilter::Active).unwrap();
    assert_eq!(
        listed.iter().map(|chat| &chat.id).collect::<Vec<_>>(),
        [&mine.id]
    );
    assert_eq!(
        workspace.automation_run(&run.id).unwrap().steps[0]
            .chat_id
            .as_deref(),
        Some(owned.id.as_str())
    );
    // The run reaches its Chat directly.
    assert_eq!(workspace.chat(&owned.id).unwrap().id, owned.id);
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
fn a_run_stopped_before_its_agents_chat_is_created_leaves_no_chat_behind() {
    let (_dir, mut workspace) = workspace();
    triage(&mut workspace);
    let run = started(&mut workspace);
    workspace.advance_automation_run(&run.id, None).unwrap();
    workspace.stop_automation_run(&run.id).unwrap();

    assert!(
        workspace
            .create_automation_run_chat(&run.id, "triage", chat_for(&run))
            .is_err()
    );

    assert_eq!(listed_chats(&workspace), [] as [String; 0]);
    assert_eq!(
        workspace.automation_run(&run.id).unwrap().steps[0].chat_id,
        None
    );
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
    // Nothing is left to start, and the agent's outcome is refused.
    assert_eq!(workspace.start_automation_runs(2).unwrap().len(), 0);
    assert!(
        workspace
            .advance_automation_run(&running.id, Some(StepOutcome::Completed))
            .is_err()
    );
}

#[test]
fn the_upkeep_removes_finished_runs_older_than_90_days_with_their_chats() {
    let (_dir, mut workspace) = workspace();
    let automation = triage(&mut workspace);
    let run = started(&mut workspace);
    workspace.advance_automation_run(&run.id, None).unwrap();
    let chat = workspace
        .create_automation_run_chat(
            &run.id,
            "triage",
            NewChat {
                title: None,
                harness: "codex".into(),
                execution_folder: "/work/app".into(),
                folder_managed: false,
                links: Vec::new(),
            },
        )
        .unwrap();
    workspace
        .save_chat_input(None, &chat.id, "Triage this")
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
    assert!(workspace.chat(&chat.id).is_err());
}

#[test]
fn the_previous_format_gains_run_storage_without_losing_records() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Kept").unwrap();
    let chat = workspace
        .create_chat(
            None,
            NewChat {
                title: Some("Mine".into()),
                harness: "codex".into(),
                execution_folder: "/work/app".into(),
                folder_managed: false,
                links: Vec::new(),
            },
        )
        .unwrap();
    drop(workspace);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "DROP TABLE automation_run_steps; DROP TABLE automation_runs;
         ALTER TABLE chats DROP COLUMN automation_run_id; PRAGMA user_version = 76;",
    )
    .unwrap();
    drop(db);

    let mut workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.show_ticket(&ticket.reference).unwrap(), ticket);
    assert_eq!(
        workspace.list_chats(ChatListFilter::Active).unwrap()[0].id,
        chat.id
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

fn chat_for(run: &AutomationRun) -> NewChat {
    NewChat {
        title: Some("Triage".into()),
        harness: "codex".into(),
        execution_folder: "/work/app".into(),
        folder_managed: false,
        links: run
            .ticket
            .iter()
            .map(|ticket| ChatLink {
                kind: ChatLinkKind::Ticket,
                id: ticket.id.clone(),
            })
            .collect(),
    }
}

/// A run on its agent step, with that step's Chat.
#[allow(clippy::unwrap_used)]
fn on_agent_step(workspace: &mut Workspace) -> (AutomationRun, String) {
    let run = started(workspace);
    workspace.advance_automation_run(&run.id, None).unwrap();
    let chat = workspace
        .create_automation_run_chat(&run.id, "triage", chat_for(&run))
        .unwrap();
    (run, chat.id)
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

    assert!(!workspace.automation_run(&run.id).unwrap().needs_you);
    assert!(!again.needs_you);
    assert_eq!(needing_you(&workspace), 0);
    assert_eq!(workspace.inbox_page(10, 0, true).unwrap(), []);
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
    // What the agent's turn reports afterwards is refused.
    assert!(
        workspace
            .advance_automation_run(&run.id, Some(StepOutcome::Completed))
            .is_err()
    );
    assert_eq!(
        workspace.automation_run(&run.id).unwrap().status,
        AutomationRunStatus::TakenOver
    );
    // The ticket is free for a new run of the Automation.
    workspace.run_automation_again(&run.id).unwrap();
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

    let after = workspace
        .take_over_automation_run(&chat, true)
        .unwrap()
        .unwrap();

    assert_eq!(after.status, AutomationRunStatus::Completed);
    assert_eq!(listed_chats(&workspace), [chat]);
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
    let mut workspace = Workspace::open(&path).unwrap();
    triage(&mut workspace);
    let (run, _chat) = needing_attention(&mut workspace);
    drop(workspace);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "ALTER TABLE automation_runs DROP COLUMN attention_cleared; PRAGMA user_version = 78;",
    )
    .unwrap();
    drop(db);

    let workspace = Workspace::open(&path).unwrap();

    assert!(workspace.automation_run(&run.id).unwrap().needs_you);
    assert_eq!(needing_you(&workspace), 1);
}
