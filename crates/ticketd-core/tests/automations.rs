use ticketd_core::{
    AutomationAgentSettings, AutomationDefinition, Check, Condition, Error, NotifyTarget, Schedule,
    Status, Step, StepAction, StepChange, Trigger, Weekday, Workspace,
};

#[allow(clippy::unwrap_used)] // A Workspace that cannot open fails the test during setup.
fn workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("automations.sqlite3")).unwrap();
    (dir, workspace)
}

fn step(id: &str, action: StepAction) -> Step {
    Step {
        id: id.into(),
        action,
    }
}

fn run_agent(id: &str, agent: Option<&str>, folder: Option<&str>) -> Step {
    step(
        id,
        StepAction::RunAgent {
            agent_id: agent.map(str::to_owned),
            execution_folder: folder.map(str::to_owned),
            on_failure: None,
        },
    )
}

fn tag_added(tag: &str) -> Option<Trigger> {
    Some(Trigger::TagAdded { tag: tag.into() })
}

/// Every step kind, nested paths and a failure path: the whole tree the spec describes.
fn verify_on_staging() -> AutomationDefinition {
    AutomationDefinition {
        name: "Verify on staging".into(),
        trigger: Some(Trigger::StatusChanged {
            to: Some(Status::InReview),
            from: Some(Status::InProgress),
        }),
        conditions: vec![
            Condition::Project {
                any_of: vec!["project-1".into()],
            },
            Condition::Source {
                any_of: vec!["github".into()],
            },
            Condition::Tag {
                tag: "ready-for-testing".into(),
                has: true,
            },
        ],
        steps: vec![
            step(
                "verify",
                StepAction::RunAgent {
                    agent_id: Some("agent-1".into()),
                    execution_folder: Some("C:\\code\\web-app".into()),
                    on_failure: Some(vec![step(
                        "tell-me",
                        StepAction::Notify {
                            text: "{{ticket.reference}} could not be verified".into(),
                            opens: NotifyTarget::Run,
                            on_failure: None,
                        },
                    )]),
                },
            ),
            step(
                "passed",
                StepAction::If {
                    checks: vec![
                        Check::Tag {
                            tag: "verified".into(),
                            has: true,
                        },
                        Check::Status {
                            status: Status::InReview,
                            is: true,
                        },
                        Check::Project {
                            project_id: None,
                            is: false,
                        },
                    ],
                    yes: vec![step(
                        "done",
                        StepAction::ChangeTicket {
                            change: Some(StepChange::SetStatus {
                                status: Status::Done,
                            }),
                            on_failure: None,
                        },
                    )],
                    no: vec![
                        step(
                            "needs-fix",
                            StepAction::ChangeTicket {
                                change: Some(StepChange::AddTag {
                                    tag: "needs-fix".into(),
                                }),
                                on_failure: None,
                            },
                        ),
                        step(
                            "say-why",
                            StepAction::ChangeTicket {
                                change: Some(StepChange::PostUpdate {
                                    text: "Verification failed for {{ticket.title}}".into(),
                                }),
                                on_failure: None,
                            },
                        ),
                    ],
                },
            ),
        ],
    }
}

#[test]
fn an_automation_keeps_the_whole_step_tree_it_was_given() {
    let (dir, mut workspace) = workspace();

    let created = workspace.create_automation(verify_on_staging()).unwrap();
    drop(workspace);

    let workspace = Workspace::open(dir.path().join("automations.sqlite3")).unwrap();
    let stored = workspace.automation(&created.id).unwrap();
    assert_eq!(stored, created);
    assert_eq!(stored.definition, verify_on_staging());
    assert!(!stored.enabled);
}

#[test]
fn schedule_and_by_hand_triggers_are_stored() {
    let (_dir, mut workspace) = workspace();
    for trigger in [
        Trigger::Schedule {
            schedule: Schedule::EveryHours { hours: 6 },
        },
        Trigger::Schedule {
            schedule: Schedule::Weekly {
                time: "09:00".into(),
                weekdays: vec![Weekday::Mon, Weekday::Fri],
            },
        },
        Trigger::ByHand,
        Trigger::TicketCreated,
        Trigger::TicketUpdated,
        Trigger::TagRemoved { tag: "wip".into() },
        Trigger::ActivityCreated,
    ] {
        let definition = AutomationDefinition {
            trigger: Some(trigger),
            ..AutomationDefinition::default()
        };
        let created = workspace.create_automation(definition.clone()).unwrap();
        assert_eq!(
            workspace.automation(&created.id).unwrap().definition,
            definition
        );
    }
}

#[test]
fn a_new_automation_is_empty_off_and_listed_newest_first() {
    let (_dir, mut workspace) = workspace();
    assert!(workspace.automations().unwrap().is_empty());

    let first = workspace
        .create_automation(AutomationDefinition::default())
        .unwrap();
    let second = workspace.create_automation(verify_on_staging()).unwrap();

    assert_eq!(first.definition, AutomationDefinition::default());
    assert!(!first.enabled);
    assert_eq!(workspace.automations().unwrap(), vec![second, first]);
}

#[test]
fn an_automation_is_renamed_and_reshaped_by_replacing_its_definition() {
    let (_dir, mut workspace) = workspace();
    let created = workspace
        .create_automation(AutomationDefinition::default())
        .unwrap();

    let renamed = workspace
        .update_automation(
            &created.id,
            AutomationDefinition {
                name: "  Triage new tickets ".into(),
                trigger: tag_added(" Ready-For-Triage "),
                steps: vec![run_agent("", None, None)],
                ..AutomationDefinition::default()
            },
        )
        .unwrap();

    assert_eq!(renamed.definition.name, "Triage new tickets");
    // A tag is named the way tickets store it.
    assert_eq!(renamed.definition.trigger, tag_added("ready-for-triage"));
    // A step sent without an id is given one.
    assert!(!renamed.definition.steps[0].id.is_empty());
    assert_eq!(workspace.automation(&created.id).unwrap(), renamed);
}

#[test]
fn two_steps_cannot_share_an_id() {
    let (_dir, mut workspace) = workspace();
    let result = workspace.create_automation(AutomationDefinition {
        steps: vec![
            run_agent("same", None, None),
            step(
                "branch",
                StepAction::If {
                    checks: Vec::new(),
                    yes: vec![run_agent("same", None, None)],
                    no: Vec::new(),
                },
            ),
        ],
        ..AutomationDefinition::default()
    });
    assert!(matches!(result, Err(Error::InvalidAutomation(_))));
}

#[test]
fn a_deleted_automation_is_gone_from_the_list_and_cannot_be_read_or_changed() {
    let (_dir, mut workspace) = workspace();
    let kept = workspace.create_automation(verify_on_staging()).unwrap();
    let deleted = workspace
        .create_automation(AutomationDefinition::default())
        .unwrap();

    workspace.delete_automation(&deleted.id).unwrap();

    assert_eq!(workspace.automations().unwrap(), vec![kept]);
    for result in [
        workspace.automation(&deleted.id).map(drop),
        workspace
            .update_automation(&deleted.id, verify_on_staging())
            .map(drop),
        workspace
            .set_automation_enabled(&deleted.id, true)
            .map(drop),
        workspace.delete_automation(&deleted.id),
        workspace.delete_automation("missing"),
    ] {
        assert!(matches!(result, Err(Error::AutomationNotFound(_))));
    }
}

/// A finished "Tag added, then run an agent" Automation, and the agent it runs.
#[allow(clippy::unwrap_used)] // An agent that cannot be made fails the test during setup.
fn triage(workspace: &mut Workspace) -> (AutomationDefinition, String) {
    let agent = workspace
        .create_automation_agent(AutomationAgentSettings {
            name: "Triage".into(),
            ..AutomationAgentSettings::default()
        })
        .unwrap();
    (
        AutomationDefinition {
            name: "Triage new tickets".into(),
            trigger: tag_added("ready-for-triage"),
            conditions: Vec::new(),
            steps: vec![run_agent("triage", Some(&agent.id), Some("C:\\code"))],
        },
        agent.id,
    )
}

#[allow(clippy::unwrap_used)] // Storage that fails here fails the test.
fn problems(workspace: &mut Workspace, definition: AutomationDefinition) -> Vec<(String, String)> {
    let automation = workspace.create_automation(definition).unwrap();
    assert!(matches!(
        workspace.set_automation_enabled(&automation.id, true),
        Err(Error::AutomationUnfinished(_))
    ));
    assert!(!workspace.automation(&automation.id).unwrap().enabled);
    automation
        .problems
        .into_iter()
        .map(|problem| (problem.step_id.unwrap_or_default(), problem.message))
        .collect()
}

fn found(problems: &[(&str, &str)]) -> Vec<(String, String)> {
    problems
        .iter()
        .map(|(step, message)| ((*step).to_owned(), (*message).to_owned()))
        .collect()
}

#[test]
fn an_unfinished_automation_says_what_it_needs_and_cannot_be_switched_on() {
    let (_dir, mut workspace) = workspace();
    let (finished, agent) = triage(&mut workspace);

    assert_eq!(
        problems(&mut workspace, AutomationDefinition::default()),
        found(&[("trigger", "Choose what starts it"), ("", "Add a step")])
    );
    assert_eq!(
        problems(
            &mut workspace,
            AutomationDefinition {
                trigger: tag_added("  "),
                steps: vec![
                    run_agent("none", None, None),
                    run_agent("no-folder", Some(&agent), Some(" ")),
                    run_agent("no-agent", None, Some("C:\\code")),
                    run_agent("unknown-agent", Some("gone"), Some("C:\\code")),
                ],
                ..finished.clone()
            }
        ),
        found(&[
            ("trigger", "Needs a tag"),
            ("none", "Needs an agent and a folder"),
            ("no-folder", "Needs a folder"),
            ("no-agent", "Needs an agent"),
            ("unknown-agent", "Needs an agent"),
        ])
    );
}

#[test]
fn a_condition_without_a_value_is_one_thing_the_trigger_still_needs() {
    use ticketd_core::Condition;

    let (_dir, mut workspace) = workspace();
    let (finished, _agent) = triage(&mut workspace);
    let mut needs = |conditions: Vec<Condition>| {
        problems(
            &mut workspace,
            AutomationDefinition {
                conditions,
                ..finished.clone()
            },
        )
    };
    let tag = |tag: &str| Condition::Tag {
        tag: tag.into(),
        has: true,
    };
    let (projects, sources) = (
        Condition::Project { any_of: Vec::new() },
        Condition::Source { any_of: Vec::new() },
    );

    assert_eq!(
        needs(vec![tag("bug"), projects.clone(), tag(" ")]),
        found(&[("trigger", "A condition needs a project")])
    );
    assert_eq!(
        needs(vec![tag(" "), projects]),
        found(&[("trigger", "A condition needs a tag")])
    );
    assert_eq!(
        needs(vec![sources]),
        found(&[("trigger", "A condition needs a source")])
    );
}

#[test]
fn the_reason_an_automation_cannot_be_switched_on_names_the_step() {
    let (_dir, mut workspace) = workspace();
    let (finished, _agent) = triage(&mut workspace);
    let automation = workspace
        .create_automation(AutomationDefinition {
            steps: vec![run_agent("unfinished", None, None)],
            ..finished
        })
        .unwrap();

    let error = workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("Run agent: needs an agent and a folder"),
        "{error}"
    );
}

#[test]
fn problems_are_found_on_every_path_in_the_order_the_steps_run() {
    let (_dir, mut workspace) = workspace();
    let (finished, agent) = triage(&mut workspace);
    let unfinished = AutomationDefinition {
        steps: vec![
            step(
                "agent",
                StepAction::RunAgent {
                    agent_id: Some(agent),
                    execution_folder: Some("C:\\code".into()),
                    on_failure: Some(vec![step(
                        "notify",
                        StepAction::Notify {
                            text: " ".into(),
                            opens: NotifyTarget::Ticket,
                            on_failure: None,
                        },
                    )]),
                },
            ),
            step(
                "branch",
                StepAction::If {
                    checks: Vec::new(),
                    yes: vec![step(
                        "change",
                        StepAction::ChangeTicket {
                            change: None,
                            on_failure: None,
                        },
                    )],
                    no: vec![run_agent("other", None, None)],
                },
            ),
        ],
        ..finished
    };

    assert_eq!(
        problems(&mut workspace, unfinished),
        found(&[
            ("notify", "Needs a message"),
            ("branch", "Needs a check"),
            ("change", "Needs a change"),
            ("other", "Needs an agent and a folder"),
        ])
    );
}

#[test]
fn steps_that_need_a_ticket_are_refused_when_nothing_starts_from_one() {
    let (_dir, mut workspace) = workspace();
    let (finished, _agent) = triage(&mut workspace);
    let ticket_steps = vec![
        step(
            "change",
            StepAction::ChangeTicket {
                change: Some(StepChange::RemoveTag { tag: "wip".into() }),
                on_failure: None,
            },
        ),
        step(
            "branch",
            StepAction::If {
                checks: vec![Check::Tag {
                    tag: "wip".into(),
                    has: false,
                }],
                yes: Vec::new(),
                no: Vec::new(),
            },
        ),
    ];
    let needs_ticket = "Needs a ticket, and this Automation does not start from one";

    for trigger in [
        Trigger::ByHand,
        Trigger::Schedule {
            schedule: Schedule::EveryHours { hours: 1 },
        },
    ] {
        assert_eq!(
            problems(
                &mut workspace,
                AutomationDefinition {
                    trigger: Some(trigger),
                    steps: ticket_steps.clone(),
                    ..finished.clone()
                }
            ),
            found(&[("change", needs_ticket), ("branch", needs_ticket)])
        );
    }
    let from_a_ticket = workspace
        .create_automation(AutomationDefinition {
            steps: ticket_steps,
            ..finished
        })
        .unwrap();
    assert!(from_a_ticket.problems.is_empty());
}

#[test]
fn switching_on_starts_from_the_events_logged_so_far() {
    let (_dir, mut workspace) = workspace();
    let (finished, _agent) = triage(&mut workspace);
    let automation = workspace.create_automation(finished).unwrap();
    assert!(automation.problems.is_empty());
    assert_eq!(workspace.automation_cursor(&automation.id).unwrap(), None);
    let ticket = workspace.create_ticket("Before it was on").unwrap();
    workspace
        .add_tag(&ticket.reference, "ready-for-triage")
        .unwrap();
    let head = workspace.workspace_event_head().unwrap();
    assert!(head > 0);

    let on = workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap();

    assert!(on.enabled);
    assert_eq!(workspace.automations().unwrap(), vec![on]);
    assert_eq!(
        workspace.automation_cursor(&automation.id).unwrap(),
        Some(head)
    );

    // Off, then on again later: what happened in between is not replayed.
    let off = workspace
        .set_automation_enabled(&automation.id, false)
        .unwrap();
    assert!(!off.enabled);
    workspace.create_ticket("While it was off").unwrap();
    let later = workspace.workspace_event_head().unwrap();
    assert!(later > head);
    workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap();
    assert_eq!(
        workspace.automation_cursor(&automation.id).unwrap(),
        Some(later)
    );
}

#[test]
fn an_edit_that_leaves_a_step_unfinished_switches_the_automation_off() {
    let (_dir, mut workspace) = workspace();
    let (finished, agent) = triage(&mut workspace);
    let automation = workspace.create_automation(finished.clone()).unwrap();
    workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap();

    let renamed = workspace
        .update_automation(
            &automation.id,
            AutomationDefinition {
                name: "Triage".into(),
                ..finished.clone()
            },
        )
        .unwrap();
    assert!(renamed.enabled, "a finished edit leaves it on");

    let mut steps = finished.steps.clone();
    steps.push(run_agent("new", Some(&agent), None));
    let edited = workspace
        .update_automation(&automation.id, AutomationDefinition { steps, ..finished })
        .unwrap();

    assert!(!edited.enabled);
    assert_eq!(edited.problems.len(), 1);
    assert!(!workspace.automation(&automation.id).unwrap().enabled);
}

#[test]
fn an_agent_used_by_a_step_cannot_be_deleted_and_names_the_automation() {
    let (_dir, mut workspace) = workspace();
    let (finished, agent) = triage(&mut workspace);
    let nested = AutomationDefinition {
        name: "Verify".into(),
        steps: vec![step(
            "branch",
            StepAction::If {
                checks: Vec::new(),
                yes: Vec::new(),
                no: vec![step(
                    "notify",
                    StepAction::Notify {
                        text: "Failed".into(),
                        opens: NotifyTarget::Ticket,
                        on_failure: Some(vec![run_agent("deep", Some(&agent), None)]),
                    },
                )],
            },
        )],
        ..finished.clone()
    };
    let first = workspace.create_automation(finished).unwrap();
    let second = workspace.create_automation(nested).unwrap();
    assert_eq!(
        workspace.automations_using_agent(&agent).unwrap(),
        vec!["Verify".to_owned(), "Triage new tickets".to_owned()]
    );

    let error = workspace.delete_automation_agent(&agent).unwrap_err();

    assert!(matches!(error, Error::AutomationAgentInUse(_)));
    assert!(error.to_string().contains("Verify"), "{error}");
    assert!(workspace.automation_agent(&agent).is_ok());

    // Once no step uses it, by an edit or by deleting the Automation, it can go.
    workspace.delete_automation(&second.id).unwrap();
    workspace
        .update_automation(
            &first.id,
            AutomationDefinition {
                steps: Vec::new(),
                ..first.definition.clone()
            },
        )
        .unwrap();
    assert!(
        workspace
            .automations_using_agent(&agent)
            .unwrap()
            .is_empty()
    );
    workspace.delete_automation_agent(&agent).unwrap();
}

#[test]
fn a_workspace_in_the_previous_format_gains_automation_storage_quietly() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("automations.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Kept").unwrap();
    let agent = workspace
        .create_automation_agent(AutomationAgentSettings::default())
        .unwrap();
    let token = workspace.change_token().unwrap();
    let events = workspace.workspace_event_head().unwrap();
    drop(workspace);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "DROP TABLE automation_device_state; DROP TABLE automations; PRAGMA user_version = 68;",
    )
    .unwrap();
    drop(db);

    let mut workspace = Workspace::open(&path).unwrap();

    assert_eq!(workspace.show_ticket(&ticket.reference).unwrap(), ticket);
    assert_eq!(workspace.automation_agents().unwrap(), vec![agent]);
    // Migrating changes nothing a view shows and is not a Workspace event.
    assert_eq!(workspace.change_token().unwrap(), token);
    assert_eq!(workspace.workspace_event_head().unwrap(), events);
    // Automations are not tickets: changing one logs no Workspace event, and a
    // view learns of it from the change token.
    let automation = workspace.create_automation(verify_on_staging()).unwrap();
    workspace.delete_automation(&automation.id).unwrap();
    assert_eq!(workspace.workspace_event_head().unwrap(), events);
    assert!(workspace.change_token().unwrap() > token);
}
