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
    assert_eq!(run.event.current, Some(serde_json::json!({ "tag": TAG })));
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
            .end_running_automation_runs("ticketd was restarted")
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
         ALTER TABLE chats DROP COLUMN automation_run_id; PRAGMA user_version = 70;",
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
