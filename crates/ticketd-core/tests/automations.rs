use ticketd_core::{
    AutomationAgentSettings, AutomationDefinition, AutomationExample, AutomationProblem, Check,
    Condition, Error, NotifyTarget, Schedule, Status, Step, StepAction, StepChange, Trigger,
    Weekday, Workspace,
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
                            status: Some(Status::InReview),
                            is: true,
                        },
                        Check::Project {
                            project_id: Some(None),
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
        workspace.delete_automation(&deleted.id).map(drop),
        workspace.delete_automation("missing").map(drop),
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
                    no: vec![
                        run_agent("other", None, None),
                        // Checks as they are when first added: nothing chosen.
                        step(
                            "untouched",
                            StepAction::If {
                                checks: vec![Check::Status {
                                    status: None,
                                    is: true,
                                }],
                                yes: Vec::new(),
                                no: vec![step(
                                    "unplaced",
                                    StepAction::If {
                                        checks: vec![Check::Project {
                                            project_id: None,
                                            is: true,
                                        }],
                                        yes: Vec::new(),
                                        no: Vec::new(),
                                    },
                                )],
                            },
                        ),
                    ],
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
            ("untouched", "Needs a status"),
            ("unplaced", "Needs a project"),
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
fn an_edit_still_being_typed_never_switches_the_automation_off() {
    let (_dir, mut workspace) = workspace();
    let (finished, _agent) = triage(&mut workspace);
    let automation = workspace.create_automation(finished.clone()).unwrap();
    workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap();
    let cursor = workspace.automation_cursor(&automation.id).unwrap();
    let retagged = |tag: &str| AutomationDefinition {
        trigger: tag_added(tag),
        ..finished.clone()
    };

    // The tag is emptied on the way to another one: nothing is stored.
    let emptied = workspace
        .draft_automation(&automation.id, retagged(""))
        .unwrap();
    assert!(emptied.enabled);
    assert_eq!(emptied.definition, finished);
    assert_eq!(workspace.automation_cursor(&automation.id).unwrap(), cursor);

    // Typed again, it can run, so it is stored as it is typed.
    let typed = workspace
        .draft_automation(&automation.id, retagged("ready"))
        .unwrap();
    assert!(typed.enabled);
    assert_eq!(typed.definition.trigger, tag_added("ready"));

    // Left empty for good, it is stored and the Automation goes off.
    let left_empty = workspace
        .update_automation(&automation.id, retagged(""))
        .unwrap();
    assert!(!left_empty.enabled);
    assert_eq!(left_empty.definition.trigger, tag_added(""));
    // One that is off has nothing to protect: its drafts are stored.
    let off = workspace
        .draft_automation(&automation.id, retagged(" "))
        .unwrap();
    assert_eq!(off.definition.trigger, tag_added(""));
    assert_eq!(off.problems.len(), 1);
}

#[test]
fn conditions_are_kept_and_not_asked_when_nothing_starts_from_a_ticket() {
    let (_dir, mut workspace) = workspace();
    let (finished, _agent) = triage(&mut workspace);
    // One condition has no value yet: it holds up a ticket trigger only.
    let conditions = vec![
        Condition::Tag {
            tag: "bug".into(),
            has: true,
        },
        Condition::Project { any_of: Vec::new() },
    ];
    let from_a_ticket = workspace
        .create_automation(AutomationDefinition {
            conditions: conditions.clone(),
            ..finished.clone()
        })
        .unwrap();
    assert!(from_a_ticket.has_ticket);
    assert_eq!(from_a_ticket.problems.len(), 1);

    let by_hand = workspace
        .update_automation(
            &from_a_ticket.id,
            AutomationDefinition {
                trigger: Some(Trigger::ByHand),
                conditions: conditions.clone(),
                ..finished
            },
        )
        .unwrap();

    assert!(!by_hand.has_ticket);
    assert_eq!(by_hand.definition.conditions, conditions);
    assert_eq!(by_hand.problems, []);
    assert!(workspace.run_automation_now(&by_hand.id).is_ok());
}

#[test]
fn starting_without_a_ticket_switches_off_an_automation_that_branches_and_it_cannot_run() {
    let (_dir, mut workspace) = workspace();
    let (finished, agent) = triage(&mut workspace);
    let has = |tag: &str| {
        vec![Check::Tag {
            tag: tag.into(),
            has: true,
        }]
    };
    // An agent, then an If with a Change ticket on one path and an If on the other.
    let mut steps = finished.steps.clone();
    steps.push(step(
        "outer",
        StepAction::If {
            checks: has("verified"),
            yes: vec![step(
                "close",
                StepAction::ChangeTicket {
                    change: Some(StepChange::SetStatus {
                        status: Status::Done,
                    }),
                    on_failure: None,
                },
            )],
            no: vec![step(
                "inner",
                StepAction::If {
                    checks: has("needs-fix"),
                    yes: vec![run_agent("fix", Some(&agent), Some("C:\\code"))],
                    no: Vec::new(),
                },
            )],
        },
    ));
    let branching = AutomationDefinition { steps, ..finished };
    let automation = workspace.create_automation(branching.clone()).unwrap();
    let on = workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap();
    assert!(on.enabled && on.problems.is_empty());

    let by_hand = workspace
        .update_automation(
            &automation.id,
            AutomationDefinition {
                trigger: Some(Trigger::ByHand),
                ..branching
            },
        )
        .unwrap();

    assert!(!by_hand.enabled);
    let needs_ticket = "Needs a ticket, and this Automation does not start from one";
    // Each step that needs the ticket says so, at any depth; the agents do not.
    assert_eq!(
        by_hand
            .problems
            .iter()
            .map(|problem| (problem.step_id.as_deref(), problem.message.as_str()))
            .collect::<Vec<_>>(),
        [
            (Some("outer"), needs_ticket),
            (Some("close"), needs_ticket),
            (Some("inner"), needs_ticket)
        ]
    );
    // So no run without a ticket ever reaches an If.
    assert!(matches!(
        workspace.run_automation_now(&automation.id),
        Err(Error::AutomationUnfinished(_))
    ));
    assert!(matches!(
        workspace.set_automation_enabled(&automation.id, true),
        Err(Error::AutomationUnfinished(_))
    ));
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
        "DROP TABLE automation_device_state; DROP TABLE automations; PRAGMA user_version = 74;",
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

/// What each card of an example still needs, in the order the steps run.
#[allow(clippy::unwrap_used)]
fn example_needs(workspace: &mut Workspace, example: AutomationExample) -> Vec<String> {
    let automation = workspace.create_example_automation(example).unwrap();
    assert!(!automation.enabled);
    automation
        .problems
        .into_iter()
        .map(|problem| problem.message)
        .collect()
}

#[test]
fn an_example_is_created_off_and_a_step_whose_agent_does_not_exist_says_so() {
    let (_dir, mut workspace) = workspace();

    let example = workspace
        .create_example_automation(AutomationExample::TriageTaggedTickets)
        .unwrap();

    assert_eq!(example.definition.name, "Triage tagged tickets");
    assert_eq!(example.definition.trigger, tag_added("ready-for-triage"));
    assert!(!example.enabled);
    assert_eq!(workspace.automations().unwrap(), vec![example.clone()]);
    let [step] = &example.definition.steps[..] else {
        panic!("the example has one step");
    };
    assert!(matches!(
        step.action,
        StepAction::RunAgent { agent_id: None, .. }
    ));
    assert_eq!(
        example.problems,
        vec![AutomationProblem {
            step_id: Some(step.id.clone()),
            message: "Needs an agent and a folder".into(),
        }]
    );

    // With an agent of the name the example runs, only the folder is left.
    let agent = workspace
        .create_automation_agent(AutomationAgentSettings {
            name: "triage".into(),
            ..AutomationAgentSettings::default()
        })
        .unwrap();
    let example = workspace
        .create_example_automation(AutomationExample::TriageTaggedTickets)
        .unwrap();
    assert!(matches!(
        &example.definition.steps[0].action,
        StepAction::RunAgent { agent_id: Some(id), .. } if *id == agent.id
    ));
    assert_eq!(example.problems[0].message, "Needs a folder");
}

#[test]
fn each_example_holds_what_can_be_built_now_and_says_what_is_left() {
    let (_dir, mut workspace) = workspace();

    assert_eq!(
        example_needs(&mut workspace, AutomationExample::VerifyReadyForTesting),
        ["Needs an agent and a folder"]
    );
    // Verifying: the agent, then an If on the tag the agent adds when the work
    // passes. Yes marks the ticket Done; No tags it for a fix.
    let verify = workspace.automations().unwrap().remove(0);
    assert_eq!(verify.definition.trigger, tag_added("ready-for-testing"));
    let [agent, branch] = &verify.definition.steps[..] else {
        panic!("the example has an agent step and an If");
    };
    assert!(matches!(agent.action, StepAction::RunAgent { .. }));
    let StepAction::If { checks, yes, no } = &branch.action else {
        panic!("the second step is an If");
    };
    assert_eq!(
        checks,
        &[Check::Tag {
            tag: "verified".into(),
            has: true
        }]
    );
    let changes = |path: &[Step]| -> Vec<Option<StepChange>> {
        path.iter()
            .map(|step| match &step.action {
                StepAction::ChangeTicket { change, .. } => change.clone(),
                StepAction::RunAgent { .. } | StepAction::Notify { .. } | StepAction::If { .. } => {
                    None
                }
            })
            .collect()
    };
    assert_eq!(
        changes(yes),
        [Some(StepChange::SetStatus {
            status: Status::Done
        })]
    );
    assert_eq!(
        changes(no),
        [Some(StepChange::AddTag {
            tag: "needs-fix".into()
        })]
    );
    assert_eq!(
        example_needs(&mut workspace, AutomationExample::WeeklySummary),
        ["Needs an agent and a folder"]
    );
    let automations = workspace.automations().unwrap();
    // The weekly summary runs on Mondays at 9:00.
    assert_eq!(
        automations[0].definition.trigger,
        Some(Trigger::Schedule {
            schedule: Schedule::Weekly {
                time: "09:00".into(),
                weekdays: vec![Weekday::Mon],
            },
        })
    );
    let names: Vec<_> = automations
        .into_iter()
        .map(|automation| automation.definition.name)
        .collect();
    assert_eq!(
        names,
        ["Weekly summary", "Verify what is ready for testing"]
    );
}

#[test]
fn a_duplicate_is_its_own_automation_with_the_same_flow_and_starts_off() {
    let (_dir, mut workspace) = workspace();
    let (definition, _agent) = triage(&mut workspace);
    let original = workspace.create_automation(definition.clone()).unwrap();
    let original = workspace
        .set_automation_enabled(&original.id, true)
        .unwrap();

    let copy = workspace.duplicate_automation(&original.id).unwrap();

    assert_ne!(copy.id, original.id);
    assert_eq!(
        copy.definition,
        AutomationDefinition {
            name: "Triage new tickets copy".into(),
            ..definition
        }
    );
    // Ready to switch on, but only the person does that.
    assert!(!copy.enabled);
    assert_eq!(copy.problems, []);
    assert_eq!(
        workspace.automations().unwrap(),
        vec![copy.clone(), original.clone()]
    );

    // Changing the copy leaves what it was made from alone.
    workspace
        .update_automation(&copy.id, AutomationDefinition::default())
        .unwrap();
    assert_eq!(workspace.automation(&original.id).unwrap(), original);

    // An Automation with no name yet has none to add to.
    let unnamed = workspace
        .create_automation(AutomationDefinition::default())
        .unwrap();
    let copy = workspace.duplicate_automation(&unnamed.id).unwrap();
    assert_eq!(copy.definition.name, "");
    assert!(matches!(
        workspace.duplicate_automation("missing"),
        Err(Error::AutomationNotFound(_))
    ));
}

/// L38: copies of copies are numbered instead of piling up "copy copy copy".
#[test]
fn copies_are_numbered_from_the_original_name_and_fit_the_name_limit() {
    let (_dir, mut workspace) = workspace();
    let named = |name: &str| AutomationDefinition {
        name: name.into(),
        ..AutomationDefinition::default()
    };
    let original = workspace.create_automation(named("Quick mark")).unwrap();
    let name = |automation: ticketd_core::Automation| automation.definition.name;

    let first = workspace.duplicate_automation(&original.id).unwrap();
    assert_eq!(name(first.clone()), "Quick mark copy");
    let of_copy = workspace.duplicate_automation(&first.id).unwrap();
    assert_eq!(name(of_copy.clone()), "Quick mark copy 2");
    assert_eq!(
        name(workspace.duplicate_automation(&of_copy.id).unwrap()),
        "Quick mark copy 3"
    );
    // A deleted copy frees its number.
    workspace.delete_automation(&first.id).unwrap();
    assert_eq!(
        name(workspace.duplicate_automation(&original.id).unwrap()),
        "Quick mark copy"
    );
    // A name that only ends in a word like it is kept whole.
    let photocopy = workspace
        .create_automation(named("Sort photo copy room"))
        .unwrap();
    assert_eq!(
        name(workspace.duplicate_automation(&photocopy.id).unwrap()),
        "Sort photo copy room copy"
    );

    // L26: a name is at most 120 characters; a copy of a long one is shortened.
    let longest = "n".repeat(120);
    let long = workspace.create_automation(named(&longest)).unwrap();
    let copy = name(workspace.duplicate_automation(&long.id).unwrap());
    assert_eq!(copy.chars().count(), 120);
    assert!(copy.ends_with(" copy"));
    assert!(matches!(
        workspace.create_automation(named(&format!("{longest}n"))),
        Err(Error::InvalidAutomation(_))
    ));
    assert!(matches!(
        workspace.update_automation(&long.id, named(&format!("{longest}n"))),
        Err(Error::InvalidAutomation(_))
    ));
}
