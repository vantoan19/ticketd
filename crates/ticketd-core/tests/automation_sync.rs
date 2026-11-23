//! Automations and Automation agents through Workspace sync: two temporary
//! Workspaces against one fake storage account, through the shared-core interface.
#![allow(clippy::unwrap_used)] // Setup and sync runs that fail must fail the test.

use ticketd_core::{
    AgentHarness, Automation, AutomationAgentSettings, AutomationDefinition, AutomationRunStatus,
    Error, RunAction, RunEnd, Step, StepAction, StepOutcome, SyncKind, SyncRecord, SyncValue,
    Trigger, Workspace,
    sync::{AttachmentDownload, RecordKind, SyncChoice, SyncResolution, remote::RemoteKind},
};

#[path = "support/sync_desks.rs"]
mod sync_desks;
use sync_desks::{Devices, desks};

const NAMES: [&str; 2] = ["Desk A", "Desk B"];

/// Two desktops, as the app runs them.
fn devices() -> Devices {
    Devices::new(&NAMES)
}

impl Devices {
    /// Sync both ways until everything has travelled.
    fn settle(&mut self) {
        for device in [0, 1, 0, 1] {
            self.sync(device);
        }
    }

    /// A finished Automation and its agent, made on the first desktop and synced
    /// to the second. Returns the Automation's id and the agent's.
    fn shared_automation(&mut self) -> (String, String) {
        let a = &mut self.workspaces[0];
        let agent = a
            .create_automation_agent(AutomationAgentSettings {
                name: "Triage".into(),
                instructions: "Read the ticket.\n\nThen label it.".into(),
                ..Default::default()
            })
            .unwrap();
        let automation = a.create_automation(triage(&agent.id)).unwrap();
        self.settle();
        (automation.id, agent.id)
    }

    /// The same, with a step folder that exists on this computer, for a test that
    /// runs it: a step whose folder is missing fails before its agent starts.
    fn shared_runnable_automation(&mut self) -> (String, String) {
        let a = &mut self.workspaces[0];
        let agent = a
            .create_automation_agent(AutomationAgentSettings {
                name: "Triage".into(),
                ..Default::default()
            })
            .unwrap();
        let mut definition = triage(&agent.id);
        definition.steps = vec![Step {
            id: "triage".into(),
            action: StepAction::RunAgent {
                agent_id: Some(agent.id.clone()),
                execution_folder: Some(std::env::temp_dir().to_string_lossy().into_owned()),
                on_failure: None,
            },
        }];
        let automation = a.create_automation(definition).unwrap();
        self.settle();
        (automation.id, agent.id)
    }
}

fn run_agent(id: &str, agent: &str) -> Step {
    Step {
        id: id.into(),
        action: StepAction::RunAgent {
            agent_id: Some(agent.into()),
            execution_folder: Some("C:\\code\\web-app".into()),
            on_failure: None,
        },
    }
}

fn triage(agent: &str) -> AutomationDefinition {
    AutomationDefinition {
        name: "Triage new bugs".into(),
        trigger: Some(Trigger::TagAdded { tag: "bug".into() }),
        conditions: Vec::new(),
        steps: vec![run_agent("triage", agent)],
    }
}

/// Every sync file of a Workspace, as (path, text), in a stable order.
fn files(workspace: &Workspace) -> Vec<(String, String)> {
    let mut files = Vec::new();
    for kind in SyncKind::ALL {
        for id in workspace.sync_record_ids(kind).unwrap() {
            let record = workspace.export_sync_record(kind, &id).unwrap();
            files.push((record.path(), record.to_markdown()));
        }
    }
    files
}

fn only(workspace: &Workspace) -> Automation {
    let mut automations = workspace.automations().unwrap();
    assert_eq!(automations.len(), 1);
    automations.remove(0)
}

#[test]
fn an_automation_made_and_switched_on_on_one_desktop_arrives_off_on_another() {
    let mut devices = devices();
    let a = &mut devices.workspaces[0];
    let agent = a
        .create_automation_agent(AutomationAgentSettings {
            name: "Triage".into(),
            ..Default::default()
        })
        .unwrap();
    let made = a.create_automation(triage(&agent.id)).unwrap();
    a.set_automation_enabled(&made.id, true).unwrap();

    devices.settle();

    let [a, b] = &devices.workspaces[..] else {
        unreachable!()
    };
    let arrived = only(b);
    assert_eq!(
        (arrived.id.as_str(), &arrived.definition),
        (made.id.as_str(), &made.definition)
    );
    // Its agent came with it, so nothing is left to finish before it can be on.
    assert_eq!(b.automation_agents().unwrap(), vec![agent]);
    assert_eq!(arrived.problems, []);
    assert!(!arrived.enabled);
    assert!(arrived.arrived_off);
    assert_eq!(b.automation_cursor(&made.id).unwrap(), None);
    // Where it was made it is still on, and was never "arrived".
    let kept = only(a);
    assert!(kept.enabled && !kept.arrived_off);
    assert_eq!(files(a), files(b));
    // Applying it is not a ticket change: no Workspace event is logged.
    assert_eq!(b.workspace_event_head().unwrap(), 0);
}

#[test]
fn switching_on_or_off_never_travels() {
    let mut devices = devices();
    let (id, _) = devices.shared_automation();

    // On for the second desktop only: nothing is uploaded, and the first stays off.
    devices.workspaces[1]
        .set_automation_enabled(&id, true)
        .unwrap();
    assert_eq!(devices.workspaces[1].dirty_records().unwrap(), []);
    assert_eq!(devices.sync(1).uploaded, 0);
    devices.settle();
    assert!(!only(&devices.workspaces[0]).enabled);
    let here = only(&devices.workspaces[1]);
    assert!(here.enabled && !here.arrived_off);

    // Off again there while the first desktop switches it on: each keeps its own.
    devices.workspaces[0]
        .set_automation_enabled(&id, true)
        .unwrap();
    devices.workspaces[1]
        .set_automation_enabled(&id, false)
        .unwrap();
    devices.settle();
    assert!(only(&devices.workspaces[0]).enabled);
    let here = only(&devices.workspaces[1]);
    // Switched off by hand here: it is no longer "just arrived".
    assert!(!here.enabled && !here.arrived_off);
    // Neither the switch nor where it has read the event log to is in a file.
    for (path, text) in files(&devices.workspaces[0]) {
        assert!(
            !text.contains("enabled") && !text.contains("cursor"),
            "{path} carries device state:\n{text}"
        );
    }
}

#[test]
fn the_steps_changed_on_two_desktops_keep_local_and_wait_for_review() {
    let mut devices = devices();
    let (id, agent) = devices.shared_automation();
    let mut from_a = triage(&agent);
    from_a.steps.push(run_agent("review", &agent));
    let mut from_b = triage(&agent);
    from_b.trigger = Some(Trigger::TagAdded {
        tag: "defect".into(),
    });
    devices.workspaces[0]
        .update_automation(&id, from_a.clone())
        .unwrap();
    devices.workspaces[1]
        .update_automation(&id, from_b.clone())
        .unwrap();

    devices.sync(0);
    let report = devices.sync(1);

    assert_eq!(report.conflicts, 1);
    let b = &mut devices.workspaces[1];
    assert_eq!(only(b).definition, from_b);
    let conflict = b.sync_conflict(SyncKind::Automation, &id).unwrap();
    assert_eq!(conflict.title, "Triage new bugs");
    let fields: Vec<&str> = conflict
        .fields
        .iter()
        .map(|field| field.field.as_str())
        .collect();
    // The trigger, conditions and steps are one field: they are reviewed whole.
    assert_eq!(fields, ["body"]);

    // Taking the other desktop's steps is an ordinary change that converges.
    let detected_at = conflict.fields[0].detected_at.clone();
    b.resolve_sync_conflict(
        SyncKind::Automation,
        &id,
        &[SyncResolution {
            field: "body".into(),
            choice: SyncChoice::Remote,
            detected_at,
        }],
    )
    .unwrap();
    devices.settle();
    for workspace in &devices.workspaces {
        assert_eq!(only(workspace).definition, from_a);
        assert_eq!(workspace.sync_conflicts().unwrap(), []);
    }
}

#[test]
fn different_fields_changed_on_two_desktops_merge_without_review() {
    let mut devices = devices();
    let (id, agent) = devices.shared_automation();
    let mut renamed = triage(&agent);
    renamed.name = "Triage".into();
    let mut longer = triage(&agent);
    longer.steps.push(run_agent("review", &agent));
    devices.workspaces[0]
        .update_automation(&id, renamed)
        .unwrap();
    devices.workspaces[1]
        .update_automation(&id, longer.clone())
        .unwrap();
    // And an agent: its limit on one desktop, a command it may run on the other.
    let settings = devices.workspaces[0]
        .automation_agent(&agent)
        .unwrap()
        .settings;
    devices.workspaces[0]
        .update_automation_agent(
            &agent,
            AutomationAgentSettings {
                turn_limit: 12,
                ..settings.clone()
            },
        )
        .unwrap();
    let mut tools = settings.tools.clone();
    tools.run_commands = true;
    tools.allowed_commands = vec!["npm test".into()];
    devices.workspaces[1]
        .update_automation_agent(
            &agent,
            AutomationAgentSettings {
                tools: tools.clone(),
                ..settings.clone()
            },
        )
        .unwrap();

    devices.settle();

    for workspace in &devices.workspaces {
        assert_eq!(workspace.sync_conflicts().unwrap(), []);
        let merged = only(workspace).definition;
        assert_eq!(
            (merged.name.as_str(), &merged.steps),
            ("Triage", &longer.steps)
        );
        let agent = workspace.automation_agent(&agent).unwrap().settings;
        assert_eq!((agent.turn_limit, &agent.tools), (12, &tools));
        assert_eq!(agent.instructions, settings.instructions);
    }
}

/// Each desktop narrows the list by a different command. The merge leaves none,
/// and none must mean none: nobody asked for "any command".
#[test]
fn two_desktops_each_removing_a_command_never_add_up_to_any_command() {
    let mut devices = devices();
    let (_, agent) = devices.shared_automation();
    let settings = devices.workspaces[0]
        .automation_agent(&agent)
        .unwrap()
        .settings;
    let allowing = |commands: &[&str]| {
        let mut tools = settings.tools.clone();
        tools.run_commands = true;
        tools.allowed_commands = commands.iter().map(|command| (*command).into()).collect();
        AutomationAgentSettings {
            tools,
            ..settings.clone()
        }
    };
    devices.workspaces[0]
        .update_automation_agent(&agent, allowing(&["cargo test", "npm test"]))
        .unwrap();
    devices.settle();

    devices.workspaces[0]
        .update_automation_agent(&agent, allowing(&["cargo test"]))
        .unwrap();
    devices.workspaces[1]
        .update_automation_agent(&agent, allowing(&["npm test"]))
        .unwrap();
    devices.settle();

    for workspace in &devices.workspaces {
        let tools = workspace.automation_agent(&agent).unwrap().settings.tools;
        assert!(tools.run_commands);
        assert_eq!(tools.allowed_commands, [] as [String; 0]);
        assert!(!tools.any_command);
    }

    // "Any command" travels only when a desktop says it.
    let mut any = allowing(&[]);
    any.tools.any_command = true;
    devices.workspaces[0]
        .update_automation_agent(&agent, any)
        .unwrap();
    devices.settle();
    let arrived = devices.workspaces[1].automation_agent(&agent).unwrap();
    assert!(arrived.settings.tools.any_command);
}

#[test]
fn a_schedule_changed_on_another_desktop_counts_again_from_when_it_arrives() {
    use ticketd_core::Schedule;

    let mut devices = devices();
    let (id, agent) = devices.shared_automation();
    let every = |hours: u32| AutomationDefinition {
        trigger: Some(Trigger::Schedule {
            schedule: Schedule::EveryHours { hours },
        }),
        ..triage(&agent)
    };
    devices.workspaces[0]
        .update_automation(&id, every(5))
        .unwrap();
    devices.settle();
    let b = &mut devices.workspaces[1];
    b.set_automation_enabled(&id, true).unwrap();
    // First seen on at 09:00: every five hours counts from then.
    assert_eq!(
        b.queue_scheduled_automation_runs(Some("2026-11-16T09:00:00"))
            .unwrap(),
        0
    );

    devices.workspaces[0]
        .update_automation(&id, every(1))
        .unwrap();
    devices.settle();

    // An hour has passed since 09:00, but the hourly schedule is new at 10:30.
    let b = &mut devices.workspaces[1];
    assert!(only(b).enabled);
    assert_eq!(
        b.queue_scheduled_automation_runs(Some("2026-11-16T10:30:00"))
            .unwrap(),
        0
    );
    assert_eq!(
        b.queue_scheduled_automation_runs(Some("2026-11-16T11:30:00"))
            .unwrap(),
        1
    );
}

#[test]
fn an_automation_deleted_on_one_desktop_is_gone_and_off_on_the_other() {
    let mut devices = devices();
    let (id, _) = devices.shared_automation();
    devices.workspaces[1]
        .set_automation_enabled(&id, true)
        .unwrap();

    devices.workspaces[0].delete_automation(&id).unwrap();
    devices.settle();

    let b = &devices.workspaces[1];
    assert_eq!(b.automations().unwrap(), []);
    assert_eq!(b.automation_cursor(&id).unwrap(), None);
    // Sync deletes no file: the record stays in the storage, marked as deleted.
    let file = b.export_sync_record(SyncKind::Automation, &id).unwrap();
    assert!(file.to_markdown().contains("trashed: true"));
}

#[test]
fn an_edit_from_another_desktop_that_leaves_a_step_unfinished_switches_it_off_here() {
    let mut devices = devices();
    let (id, agent) = devices.shared_automation();
    devices.workspaces[1]
        .set_automation_enabled(&id, true)
        .unwrap();
    let mut unfinished = triage(&agent);
    unfinished.steps.push(Step {
        id: "later".into(),
        action: StepAction::RunAgent {
            agent_id: None,
            execution_folder: None,
            on_failure: None,
        },
    });

    devices.workspaces[0]
        .update_automation(&id, unfinished)
        .unwrap();
    devices.settle();

    let here = only(&devices.workspaces[1]);
    assert!(!here.enabled);
    assert_eq!(here.problems.len(), 1);
}

#[test]
fn an_agent_deleted_on_one_desktop_while_another_starts_using_it_leaves_the_step_unfinished() {
    let mut devices = devices();
    let (id, agent) = devices.shared_automation();
    let spare = devices.workspaces[0]
        .create_automation_agent(AutomationAgentSettings::default())
        .unwrap()
        .id;
    devices.settle();

    // No Automation uses the spare agent on the first desktop, so it may go there.
    devices.workspaces[0]
        .delete_automation_agent(&spare)
        .unwrap();
    let b = &mut devices.workspaces[1];
    let mut uses_spare = triage(&agent);
    uses_spare.steps.push(run_agent("review", &spare));
    b.update_automation(&id, uses_spare).unwrap();
    b.set_automation_enabled(&id, true).unwrap();
    devices.settle();

    for workspace in &devices.workspaces {
        let automation = only(workspace);
        assert!(!automation.enabled);
        let problems: Vec<_> = automation
            .problems
            .iter()
            .map(|problem| (problem.step_id.as_deref(), problem.message.as_str()))
            .collect();
        assert_eq!(problems, [(Some("review"), "Needs an agent")]);
        assert_eq!(workspace.automation_agents().unwrap().len(), 1);
    }
}

#[test]
fn syncing_an_automation_logs_no_workspace_event_and_moves_the_change_token() {
    let mut devices = devices();
    let before = devices.workspaces[1].change_token().unwrap();

    devices.shared_automation();

    let b = &devices.workspaces[1];
    assert_eq!(b.workspace_events_after(0, 10).unwrap(), []);
    // A view open on the second desktop learns that something arrived.
    assert!(b.change_token().unwrap() > before);
}

const AGENT_FILE: &str = r#"---
kind: automation_agent
format: 1
id: "AGENT"
name: "Triage"
harness: "claude-code"
turn_limit: 40
time_limit_minutes: 20
read_files: true
edit_files: false
run_commands: true
any_command: false
allowed_commands:
  - "cargo test"
  - "npm test"
use_web: false
trashed: false
---
Read the ticket.

Then label it.
"#;

const AUTOMATION_FILE: &str = r#"---
kind: automation
format: 1
id: "AUTOMATION"
name: "Triage new bugs"
trashed: false
---
```json
{
  "schema_version": 1,
  "trigger": {
    "kind": "tag_added",
    "tag": "bug"
  },
  "conditions": [],
  "steps": [
    {
      "id": "triage",
      "kind": "run_agent",
      "agent_id": "AGENT",
      "execution_folder": "C:\\code\\web-app",
      "on_failure": null
    }
  ]
}
```
"#;

/// A Workspace holding the agent and the Automation of the two files above.
/// Returns the Automation's id and the agent's.
fn workspace_with_files(directory: &tempfile::TempDir) -> (Workspace, String, String) {
    let mut workspace = Workspace::open(directory.path().join("source")).unwrap();
    let mut settings = AutomationAgentSettings {
        name: "Triage".into(),
        instructions: "Read the ticket.\n\nThen label it.".into(),
        ..Default::default()
    };
    settings.tools.run_commands = true;
    // In the order a file lists them: sync keeps which commands, not their order.
    settings.tools.allowed_commands = vec!["cargo test".into(), "npm test".into()];
    let agent = workspace.create_automation_agent(settings).unwrap().id;
    let automation = workspace.create_automation(triage(&agent)).unwrap().id;
    (workspace, automation, agent)
}

#[test]
fn an_agent_and_an_automation_are_each_one_readable_markdown_file() {
    let directory = tempfile::tempdir().unwrap();
    let (workspace, automation, agent) = workspace_with_files(&directory);

    let agent_file = workspace
        .export_sync_record(SyncKind::AutomationAgent, &agent)
        .unwrap();
    let automation_file = workspace
        .export_sync_record(SyncKind::Automation, &automation)
        .unwrap();

    assert_eq!(agent_file.path(), format!("automation_agents/{agent}.md"));
    assert_eq!(agent_file.display_name(), "Triage.md");
    assert_eq!(
        agent_file.to_markdown(),
        AGENT_FILE.replace("AGENT", &agent)
    );
    assert_eq!(
        automation_file.path(),
        format!("automations/{automation}.md")
    );
    assert_eq!(automation_file.display_name(), "Triage new bugs.md");
    assert_eq!(
        automation_file.to_markdown(),
        AUTOMATION_FILE
            .replace("AUTOMATION", &automation)
            .replace("AGENT", &agent)
    );
}

#[test]
fn the_files_make_the_same_records_in_an_empty_workspace_with_the_automation_off() {
    let directory = tempfile::tempdir().unwrap();
    let (mut source, automation, agent) = workspace_with_files(&directory);
    source.set_automation_enabled(&automation, true).unwrap();
    let mut target = Workspace::open(directory.path().join("target")).unwrap();

    // The Automation first: its agent has not arrived when it is applied.
    for file in files(&source).iter().rev() {
        let record = SyncRecord::parse(&file.1).unwrap();
        assert_eq!(target.apply_sync_record(&record).unwrap(), []);
    }

    assert_eq!(files(&target), files(&source));
    assert_eq!(
        target.automation_agent(&agent).unwrap(),
        source.automation_agent(&agent).unwrap()
    );
    let arrived = only(&target);
    assert_eq!(arrived.definition, only(&source).definition);
    assert_eq!(
        (arrived.enabled, arrived.arrived_off, arrived.problems.len()),
        (false, true, 0)
    );
}

#[test]
fn an_agent_file_edited_by_hand_in_ordinary_yaml_is_accepted() {
    let directory = tempfile::tempdir().unwrap();
    let (mut workspace, _, agent) = workspace_with_files(&directory);
    let edited = format!(
        "---\nkind: automation_agent\nid: {agent}\nname: Triage\nharness: codex\nmodel: gpt-5\nturn_limit: \"12\"\ntime_limit_minutes: 5\nrun_commands: true\nany_command: true\nallowed_commands: [npm test]\n---\nLabel it.\n"
    );

    workspace
        .apply_sync_record(&SyncRecord::parse(&edited).unwrap())
        .unwrap();

    let settings = workspace.automation_agent(&agent).unwrap().settings;
    assert_eq!(settings.harness, AgentHarness::Codex);
    assert_eq!(settings.model.as_deref(), Some("gpt-5"));
    assert_eq!((settings.turn_limit, settings.time_limit_minutes), (12, 5));
    assert_eq!(settings.tools.allowed_commands, ["npm test"]);
    assert!(settings.tools.any_command);
    // A true-or-false field that is left out is false.
    assert!(!settings.tools.read_files && settings.tools.run_commands);
    assert_eq!(settings.instructions, "Label it.");
}

#[test]
fn a_synced_harness_change_cannot_implicitly_widen_a_command_list() {
    let directory = tempfile::tempdir().unwrap();
    let (mut workspace, _, agent) = workspace_with_files(&directory);
    let content = format!(
        "---\nkind: automation_agent\nid: {agent}\nname: Triage\nharness: claude-code\nturn_limit: 12\ntime_limit_minutes: 5\nrun_commands: true\nallowed_commands: [npm test]\n---\nLabel it.\n"
    );
    workspace
        .apply_sync_record(&SyncRecord::parse(&content).unwrap())
        .unwrap();
    let before = workspace.automation_agent(&agent).unwrap();
    let widened = SyncRecord::parse(&content.replace("claude-code", "codex")).unwrap();
    assert!(workspace.apply_sync_record(&widened).is_err());
    assert_eq!(workspace.automation_agent(&agent).unwrap(), before);
}

#[test]
fn a_file_that_would_make_a_broken_agent_or_automation_is_rejected_and_changes_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let (mut workspace, automation, agent) = workspace_with_files(&directory);
    let before = files(&workspace);
    let agent_file = AGENT_FILE.replace("AGENT", &agent);
    let automation_file = AUTOMATION_FILE
        .replace("AUTOMATION", &automation)
        .replace("AGENT", &agent);
    let cases = [
        (
            agent_file.replace("\"claude-code\"", "\"gemini\""),
            "field 'harness' must be one of claude-code, codex",
        ),
        (
            agent_file.replace("turn_limit: 40", "turn_limit: 0"),
            "field 'turn_limit' must be a whole number of at least 1",
        ),
        (
            agent_file.replace("turn_limit: 40\n", ""),
            "a automation_agent is missing its required field 'turn_limit'",
        ),
        (
            automation_file.replace("```json", "```"),
            "the steps of an automation: they must be one ```json block",
        ),
        (
            automation_file.replace("\"run_agent\"", "\"run_robot\""),
            "the steps of an automation: unknown variant `run_robot`",
        ),
        (
            automation_file.replace("\"id\": \"triage\"", "\"id\": \"\""),
            "the steps of an automation: every step needs an id",
        ),
        (
            automation_file.replace("\"schema_version\": 1", "\"schema_version\": 2"),
            "the steps of an automation: a newer ticketd wrote them",
        ),
    ];

    for (file, reason) in cases {
        match SyncRecord::parse(&file) {
            Err(Error::SyncFile(found)) => {
                assert!(found.starts_with(reason), "{found}\n{file}");
            }
            other => panic!("expected {reason}, got {other:?}\n{file}"),
        }
    }
    assert_eq!(files(&workspace), before);
    // The checks also apply to records built in code, such as review choices.
    let mut record = workspace
        .export_sync_record(SyncKind::AutomationAgent, &agent)
        .unwrap();
    record
        .fields
        .insert("harness".into(), SyncValue::Text("unknown-harness".into()));
    assert!(matches!(
        workspace.apply_sync_record(&record),
        Err(Error::SyncFile(message)) if message.contains("field 'harness'")
    ));

    let mut record = workspace
        .export_sync_record(SyncKind::Automation, &automation)
        .unwrap();
    record
        .fields
        .insert("body".into(), SyncValue::Text("not steps".into()));
    assert!(matches!(
        workspace.apply_sync_record(&record),
        Err(Error::SyncFile(_))
    ));
    assert_eq!(files(&workspace), before);
}

/// Clear every mark and return which records were waiting to upload.
fn take(workspace: &mut Workspace) -> Vec<(RecordKind, String)> {
    let records = workspace.dirty_records().unwrap();
    for record in &records {
        assert!(workspace.clear_dirty(record).unwrap());
    }
    records
        .into_iter()
        .map(|record| (record.kind, record.id))
        .collect()
}

#[test]
fn a_change_to_an_agent_or_an_automation_waits_to_upload_and_the_switch_does_not() {
    let directory = tempfile::tempdir().unwrap();
    let (mut workspace, automation, agent) = workspace_with_files(&directory);
    let agent_mark = (RecordKind::AutomationAgent, agent.clone());
    let automation_mark = (RecordKind::Automation, automation.clone());
    assert_eq!(
        take(&mut workspace),
        [agent_mark.clone(), automation_mark.clone()]
    );

    workspace.set_automation_enabled(&automation, true).unwrap();
    workspace
        .set_automation_enabled(&automation, false)
        .unwrap();
    assert_eq!(take(&mut workspace), []);

    let settings = workspace.automation_agent(&agent).unwrap().settings;
    workspace
        .update_automation_agent(
            &agent,
            AutomationAgentSettings {
                turn_limit: 5,
                ..settings
            },
        )
        .unwrap();
    assert_eq!(take(&mut workspace), [agent_mark]);
    workspace.delete_automation(&automation).unwrap();
    assert_eq!(take(&mut workspace), [automation_mark]);
}

#[test]
fn a_workspace_in_the_previous_format_starts_syncing_the_automations_it_has() {
    let desks = desks();
    // Version 75 had Automations and agents but no sync capture: made here, they have
    // never been marked to upload.
    let source = desks.directory.path().join("source");
    ticketd_core::create_workspace_at_format_version(&source, 75).unwrap();
    let (automation, agent) = (
        "00000000-0000-4000-8000-0000000000a1".to_owned(),
        "00000000-0000-4000-8000-0000000000a2".to_owned(),
    );
    let db = rusqlite::Connection::open(&source).unwrap();
    db.execute(
        "INSERT INTO automation_agents (id, name, harness, model, instructions, read_files, edit_files, run_commands, allowed_commands, use_web, turn_limit, time_limit_minutes) \
         VALUES (?1, 'Triage', 'claude-code', NULL, ?2, 1, 0, 1, '[\"cargo test\",\"npm test\"]', 0, 40, 20)",
        rusqlite::params![agent, "Read the ticket.\n\nThen label it."],
    )
    .unwrap();
    // The definition as version 75 stored it: schema 1 of the trigger, conditions and steps.
    let flow = triage(&agent);
    let stored = serde_json::json!({
        "schema_version": 1,
        "trigger": flow.trigger,
        "conditions": flow.conditions,
        "steps": flow.steps,
    });
    db.execute(
        "INSERT INTO automations (id, name, definition) VALUES (?1, 'Triage new bugs', ?2)",
        rusqlite::params![automation, stored.to_string()],
    )
    .unwrap();
    let token: i64 = db
        .query_row(
            "SELECT token FROM workspace_changes WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    drop(db);

    let mut workspace = Workspace::open(desks.directory.path().join("source")).unwrap();

    assert_eq!(workspace.change_token().unwrap(), token);
    // Made on this desktop before Automations synced: not "arrived".
    let kept = only(&workspace);
    assert_eq!(
        (kept.id.as_str(), kept.arrived_off),
        (automation.as_str(), false)
    );
    // A later change waits to upload, and the first sync run uploads both.
    workspace.delete_automation(&automation).unwrap();
    assert_eq!(
        take(&mut workspace),
        [(RecordKind::Automation, automation.clone())]
    );
    workspace
        .sync_connect("connection-1", "person@example.com")
        .unwrap();
    workspace
        .sync_upload_workspace(&desks.remote, "Test")
        .unwrap();
    workspace.sync_now(&desks.remote).unwrap();
    let uploaded = desks
        .remote
        .stored_versions(&desks.folder())
        .keys()
        .filter(|key| key.kind != RemoteKind::Devices)
        .count();
    assert_eq!(uploaded, 2);
    let mut other = desks.joined("other", AttachmentDownload::Automatic);
    other.sync_now(&desks.remote).unwrap();
    assert_eq!(other.automation_agents().unwrap().len(), 1);
    assert_eq!(other.automation_agent(&agent).unwrap().id, agent);
    // Deleted before it ever synced: it arrives as deleted.
    assert_eq!(other.automations().unwrap(), []);
}

#[test]
fn an_arrived_automation_starts_no_run_until_it_is_switched_on_here() {
    let mut devices = devices();
    let (automation, _agent) = devices.shared_automation();
    let b = &mut devices.workspaces[1];
    let tag = |workspace: &mut Workspace, title: &str| {
        let ticket = workspace.create_ticket(title).unwrap();
        workspace.add_tag(&ticket.reference, "bug").unwrap();
    };

    tag(b, "Crash on save");
    assert_eq!(b.queue_automation_runs().unwrap(), 0);

    // On from here: what was tagged while it was off stays without a run.
    b.set_automation_enabled(&automation, true).unwrap();
    assert_eq!(b.queue_automation_runs().unwrap(), 0);
    tag(b, "Crash on open");
    assert_eq!(b.queue_automation_runs().unwrap(), 1);
    assert_eq!(b.automation_runs(&automation).unwrap().len(), 1);
}

#[test]
fn a_run_and_its_chat_stay_on_the_desktop_that_made_them() {
    let mut devices = devices();
    let (automation, _agent) = devices.shared_runnable_automation();
    let b = &mut devices.workspaces[1];
    b.set_automation_enabled(&automation, true).unwrap();
    let ticket = b.create_ticket("Crash on save").unwrap();
    b.add_tag(&ticket.reference, "bug").unwrap();
    devices.settle();
    let before = files(&devices.workspaces[0]);

    // A whole run on the second desktop: queued, started, its Chat, ended.
    let b = &mut devices.workspaces[1];
    assert_eq!(b.queue_automation_runs().unwrap(), 1);
    let run = b.start_automation_runs(2).unwrap().remove(0);
    assert!(matches!(
        b.advance_automation_run(&run.id, None).unwrap(),
        RunAction::RunAgent(_)
    ));
    b.advance_automation_run(&run.id, Some(StepOutcome::Completed))
        .unwrap();

    // None of it waits to upload, and nothing of it reaches the first desktop.
    assert_eq!(b.dirty_records().unwrap().len(), 0);
    devices.settle();
    let [a, b] = &devices.workspaces[..] else {
        unreachable!()
    };
    assert_eq!(files(a), before);
    assert_eq!(files(b), before);
    assert_eq!(a.automation_runs(&automation).unwrap(), []);
    assert_eq!(a.automation_cursor(&automation).unwrap(), None);
    assert_eq!(b.automation_runs(&automation).unwrap().len(), 1);
}

#[test]
fn a_run_in_progress_finishes_on_its_own_steps_when_an_edit_from_elsewhere_switches_it_off() {
    let mut devices = devices();
    let (automation, _agent) = devices.shared_runnable_automation();
    let b = &mut devices.workspaces[1];
    b.set_automation_enabled(&automation, true).unwrap();
    let ticket = b.create_ticket("Crash on save").unwrap();
    b.add_tag(&ticket.reference, "bug").unwrap();
    b.queue_automation_runs().unwrap();
    let run = b.start_automation_runs(2).unwrap().remove(0);
    let started = b.advance_automation_run(&run.id, None).unwrap();

    // The first desktop takes the agent off the step, which leaves it unfinished.
    let a = &mut devices.workspaces[0];
    let mut edited = only(a).definition;
    edited.steps = vec![Step {
        id: "triage".into(),
        action: StepAction::RunAgent {
            agent_id: None,
            execution_folder: Some("C:\\code\\web-app".into()),
            on_failure: None,
        },
    }];
    a.update_automation(&automation, edited).unwrap();
    devices.settle();

    let b = &mut devices.workspaces[1];
    assert!(!only(b).enabled);
    assert!(matches!(&started, RunAction::RunAgent(start) if start.step_id == "triage"));
    // The run still has the step as it was, and ends as any other run.
    let kept = b.automation_run(&run.id).unwrap();
    assert_eq!(kept.definition, run.definition);
    assert_eq!(kept.status, AutomationRunStatus::Running);
    assert_eq!(
        b.advance_automation_run(&run.id, Some(StepOutcome::Completed))
            .unwrap(),
        RunAction::End(RunEnd::Completed)
    );
    // Off here, so a new tag starts nothing.
    let next = b.create_ticket("Crash on open").unwrap();
    b.add_tag(&next.reference, "bug").unwrap();
    assert_eq!(b.queue_automation_runs().unwrap(), 0);
}
