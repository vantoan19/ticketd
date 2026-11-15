use ticketd_core::{AgentHarness, AutomationAgentSettings, AutomationAgentTools, Error, Workspace};

#[allow(clippy::unwrap_used)] // A Workspace that cannot open fails the test during setup.
fn workspace() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("agents.sqlite3")).unwrap();
    (dir, workspace)
}

fn triage() -> AutomationAgentSettings {
    AutomationAgentSettings {
        name: "  Triage ".into(),
        harness: AgentHarness::Codex,
        model: Some("gpt-5".into()),
        instructions: "Triage new tickets.".into(),
        tools: AutomationAgentTools {
            read_files: true,
            edit_files: true,
            run_commands: true,
            any_command: false,
            allowed_commands: vec!["npm test".into(), "  ".into(), " npm run lint ".into()],
            use_web: true,
        },
        turn_limit: 12,
        time_limit_minutes: 5,
    }
}

/// Until format 81 an empty command list meant "any command". Agents saved that way
/// keep it; a list with commands, and commands switched off, never gain it.
#[test]
fn agents_saved_with_an_empty_command_list_keep_any_command_after_migrating() {
    let (dir, mut workspace) = workspace();
    let mut ids = Vec::new();
    for (run_commands, commands) in [(true, "[]"), (true, "[\"npm test\"]"), (false, "[]")] {
        let agent = workspace.create_automation_agent(triage()).unwrap();
        ids.push((agent.id, run_commands, commands));
    }
    drop(workspace);
    let path = dir.path().join("agents.sqlite3");
    let db = rusqlite::Connection::open(&path).unwrap();
    for (id, run_commands, commands) in &ids {
        db.execute(
            "UPDATE automation_agents SET run_commands = ?2, allowed_commands = ?3 WHERE id = ?1",
            rusqlite::params![id, run_commands, commands],
        )
        .unwrap();
    }
    db.execute_batch(
        "ALTER TABLE automation_agents DROP COLUMN any_command; PRAGMA user_version = 80;",
    )
    .unwrap();
    drop(db);

    let workspace = Workspace::open(&path).unwrap();

    let any: Vec<bool> = ids
        .iter()
        .map(|(id, _, _)| {
            workspace
                .automation_agent(id)
                .unwrap()
                .settings
                .tools
                .any_command
        })
        .collect();
    assert_eq!(any, [true, false, false]);
}

#[test]
fn a_new_agent_starts_from_the_defaults_and_is_listed() {
    let (_dir, mut workspace) = workspace();
    assert!(workspace.automation_agents().unwrap().is_empty());

    let agent = workspace
        .create_automation_agent(AutomationAgentSettings::default())
        .unwrap();

    assert_eq!(agent.settings.name, "");
    assert_eq!(agent.settings.harness, AgentHarness::ClaudeCode);
    assert_eq!(agent.settings.model, None);
    assert_eq!(agent.settings.turn_limit, 40);
    assert_eq!(agent.settings.time_limit_minutes, 20);
    assert!(agent.settings.tools.read_files);
    assert!(!agent.settings.tools.edit_files);
    assert!(!agent.settings.tools.run_commands);
    assert!(!agent.settings.tools.any_command);
    assert!(!agent.settings.tools.use_web);
    assert_eq!(workspace.automation_agents().unwrap(), vec![agent]);
}

#[test]
fn new_agents_are_numbered_so_two_fresh_ones_differ_and_a_freed_name_is_reused() {
    let (_dir, mut workspace) = workspace();

    let first = workspace.create_new_automation_agent().unwrap();
    let second = workspace.create_new_automation_agent().unwrap();
    assert_eq!(first.settings.name, "New agent");
    assert_eq!(second.settings.name, "New agent 2");
    assert_eq!(first.settings.turn_limit, 40);

    workspace.delete_automation_agent(&first.id).unwrap();
    let third = workspace.create_new_automation_agent().unwrap();
    assert_eq!(third.settings.name, "New agent");

    // Names need not be unique: renaming one to another's name is kept.
    let renamed = workspace
        .update_automation_agent(
            &second.id,
            AutomationAgentSettings {
                name: "New agent".into(),
                ..second.settings.clone()
            },
        )
        .unwrap();
    assert_eq!(renamed.settings.name, "New agent");
}

#[test]
fn an_agent_keeps_every_setting_it_was_given() {
    let (dir, mut workspace) = workspace();

    let agent = workspace.create_automation_agent(triage()).unwrap();
    drop(workspace);

    let workspace = Workspace::open(dir.path().join("agents.sqlite3")).unwrap();
    let stored = workspace.automation_agent(&agent.id).unwrap();
    assert_eq!(stored, agent);
    assert_eq!(stored.settings.name, "Triage");
    assert_eq!(stored.settings.harness, AgentHarness::Codex);
    assert_eq!(stored.settings.model.as_deref(), Some("gpt-5"));
    assert_eq!(stored.settings.instructions, "Triage new tickets.");
    assert_eq!(
        stored.settings.tools.allowed_commands,
        ["npm test", "npm run lint"]
    );
    assert!(stored.settings.tools.edit_files && stored.settings.tools.use_web);
    assert_eq!(stored.settings.turn_limit, 12);
    assert_eq!(stored.settings.time_limit_minutes, 5);
}

#[test]
fn updating_an_agent_replaces_its_settings_and_moves_the_change_token() {
    let (_dir, mut workspace) = workspace();
    let agent = workspace.create_automation_agent(triage()).unwrap();
    let before = workspace.change_token().unwrap();

    let updated = workspace
        .update_automation_agent(
            &agent.id,
            AutomationAgentSettings {
                name: "Verifier".into(),
                model: Some(" ".into()),
                ..AutomationAgentSettings::default()
            },
        )
        .unwrap();

    assert_eq!(updated.id, agent.id);
    assert_eq!(updated.settings.name, "Verifier");
    assert_eq!(updated.settings.model, None);
    assert_eq!(updated.settings.harness, AgentHarness::ClaudeCode);
    assert_eq!(workspace.automation_agents().unwrap(), vec![updated]);
    assert_ne!(workspace.change_token().unwrap(), before);
}

#[test]
fn a_limit_outside_its_range_is_refused_and_nothing_changes() {
    let (_dir, mut workspace) = workspace();
    let agent = workspace.create_automation_agent(triage()).unwrap();

    for settings in [
        AutomationAgentSettings {
            turn_limit: 0,
            ..triage()
        },
        AutomationAgentSettings {
            time_limit_minutes: 0,
            ..triage()
        },
        AutomationAgentSettings {
            turn_limit: 501,
            ..triage()
        },
        AutomationAgentSettings {
            time_limit_minutes: 241,
            ..triage()
        },
    ] {
        assert!(matches!(
            workspace.update_automation_agent(&agent.id, settings.clone()),
            Err(Error::InvalidAutomationAgent(_))
        ));
        assert!(matches!(
            workspace.create_automation_agent(settings),
            Err(Error::InvalidAutomationAgent(_))
        ));
    }
    assert_eq!(workspace.automation_agents().unwrap(), vec![agent]);
}

#[test]
fn a_deleted_agent_is_gone_from_the_list_and_cannot_be_read_or_changed() {
    let (_dir, mut workspace) = workspace();
    let kept = workspace.create_automation_agent(triage()).unwrap();
    let deleted = workspace
        .create_automation_agent(AutomationAgentSettings::default())
        .unwrap();

    workspace.delete_automation_agent(&deleted.id).unwrap();

    assert_eq!(workspace.automation_agents().unwrap(), vec![kept]);
    for result in [
        workspace.automation_agent(&deleted.id).map(drop),
        workspace
            .update_automation_agent(&deleted.id, triage())
            .map(drop),
        workspace.delete_automation_agent(&deleted.id),
        workspace.delete_automation_agent("missing"),
    ] {
        assert!(matches!(result, Err(Error::AutomationAgentNotFound(_))));
    }
}

#[test]
fn a_workspace_in_the_previous_format_gains_agent_storage_quietly() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("agents.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Kept").unwrap();
    let token = workspace.change_token().unwrap();
    let events = workspace.workspace_event_head().unwrap();
    drop(workspace);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE automation_agents; PRAGMA user_version = 73;")
        .unwrap();
    drop(db);

    let mut workspace = Workspace::open(&path).unwrap();

    assert_eq!(workspace.show_ticket(&ticket.reference).unwrap(), ticket);
    // Migrating changes nothing a view shows and is not a Workspace event.
    assert_eq!(workspace.change_token().unwrap(), token);
    assert_eq!(workspace.workspace_event_head().unwrap(), events);
    let agent = workspace.create_automation_agent(triage()).unwrap();
    assert_eq!(workspace.automation_agents().unwrap().len(), 1);
    // Agents are not tickets: changing one logs no Workspace event.
    workspace
        .update_automation_agent(&agent.id, triage())
        .unwrap();
    workspace.delete_automation_agent(&agent.id).unwrap();
    assert_eq!(workspace.workspace_event_head().unwrap(), events);
}

/// The same limit as an Automation's name, counted after the name is trimmed.
#[test]
fn a_name_longer_than_an_automation_name_may_be_is_refused() {
    let (_dir, mut workspace) = workspace();
    let agent = workspace.create_automation_agent(triage()).unwrap();
    let longest = format!("  {} ", "a".repeat(120));
    let longer = "a".repeat(121);

    let saved = workspace
        .update_automation_agent(
            &agent.id,
            AutomationAgentSettings {
                name: longest,
                ..triage()
            },
        )
        .unwrap();
    assert_eq!(saved.settings.name, "a".repeat(120));
    let too_long = AutomationAgentSettings {
        name: longer,
        ..triage()
    };
    assert!(matches!(
        workspace.update_automation_agent(&agent.id, too_long.clone()),
        Err(Error::InvalidAutomationAgent(_))
    ));
    assert!(matches!(
        workspace.create_automation_agent(too_long),
        Err(Error::InvalidAutomationAgent(_))
    ));
    assert_eq!(workspace.automation_agents().unwrap(), vec![saved]);
}
