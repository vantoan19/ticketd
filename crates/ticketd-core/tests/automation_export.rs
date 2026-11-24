use ticketd_core::{
    AutomationAgentSettings, AutomationDefinition, NotifyTarget, Step, StepAction, Trigger,
    Workspace,
};

#[test]
fn the_json_export_carries_automations_agents_and_runs_but_not_device_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let agent = workspace
        .create_automation_agent(AutomationAgentSettings {
            name: "Triager".into(),
            ..AutomationAgentSettings::default()
        })
        .unwrap();
    let automation = workspace
        .create_automation(AutomationDefinition {
            name: "Triage".into(),
            trigger: Some(Trigger::TagAdded {
                tag: "ready".into(),
            }),
            conditions: Vec::new(),
            steps: vec![
                Step {
                    id: "triage".into(),
                    action: StepAction::RunAgent {
                        agent_id: Some(agent.id.clone()),
                        execution_folder: Some("/work/app".into()),
                        on_failure: None,
                    },
                },
                Step {
                    id: "tell".into(),
                    action: StepAction::Notify {
                        text: "Done".into(),
                        opens: NotifyTarget::Ticket,
                        on_failure: None,
                    },
                },
            ],
        })
        .unwrap();
    workspace
        .set_automation_enabled(&automation.id, true)
        .unwrap();
    let ticket = workspace.create_ticket("Fix login").unwrap();
    workspace.add_tag(&ticket.reference, "ready").unwrap();
    workspace.queue_automation_runs().unwrap();
    let run = workspace.start_automation_runs(1).unwrap().remove(0);

    let export = workspace.export().unwrap();
    assert_eq!(export["format_version"], 3);
    assert_eq!(export["automations"][0]["id"], automation.id);
    assert_eq!(export["automations"][0]["name"], "Triage");
    assert_eq!(export["automation_agents"][0]["id"], agent.id);
    assert_eq!(export["automation_agents"][0]["name"], "Triager");
    assert_eq!(export["automation_runs"][0]["id"], run.id);
    assert_eq!(export["automation_runs"][0]["automation_id"], automation.id);
    assert_eq!(export["automation_runs"][0]["status"], "running");
    // A run that has only started has reached no step yet, but the array is there.
    assert_eq!(export["automation_run_steps"], serde_json::json!([]));
    // Whether an Automation is on belongs to the device, and the event log is only read.
    for omitted in [
        "automation_device_state",
        "automation_settings",
        "automation_arrivals",
        "workspace_events",
    ] {
        assert!(
            export.get(omitted).is_none(),
            "{omitted} must not be exported"
        );
    }
}
