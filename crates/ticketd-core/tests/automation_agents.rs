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
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("agents.sqlite3");
    ticketd_core::create_workspace_at_format_version(&path, 80).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    let mut ids = Vec::new();
    for (n, (run_commands, commands)) in [(true, "[]"), (true, "[\"npm test\"]"), (false, "[]")]
        .into_iter()
        .enumerate()
    {
        let id = format!("00000000-0000-4000-8000-00000000000{n}");
        db.execute(
            "INSERT INTO automation_agents (id, name, harness, model, instructions, read_files, edit_files, run_commands, allowed_commands, use_web, turn_limit, time_limit_minutes) \
             VALUES (?1, 'Triage', 'codex', NULL, 'Triage new tickets.', 1, 1, ?2, ?3, 0, 12, 5)",
            rusqlite::params![id, run_commands, commands],
        )
        .unwrap();
        ids.push((id, run_commands, commands));
    }
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
    // Format 73 had Workspace events but no Automation agents.
    ticketd_core::create_workspace_at_format_version(&path, 73).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute(
        "INSERT INTO tickets (id, title, status, reference) VALUES ('11111111-1111-4111-8111-111111111111', 'Kept', 'Todo', 'T-1')",
        [],
    )
    .unwrap();
    let token: i64 = db
        .query_row(
            "SELECT token FROM workspace_changes WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let events: i64 = db
        .query_row(
            "SELECT seq FROM sqlite_sequence WHERE name = 'workspace_events'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    drop(db);

    let mut workspace = Workspace::open(&path).unwrap();

    assert_eq!(workspace.show_ticket("T-1").unwrap().title, "Kept");
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

#[test]
fn changing_harnesses_cannot_turn_a_command_list_into_any_command_implicitly() {
    let (_dir, mut workspace) = workspace();
    let mut settings = triage();
    settings.harness = AgentHarness::ClaudeCode;
    let agent = workspace.create_automation_agent(settings.clone()).unwrap();

    settings.harness = AgentHarness::Codex;
    assert!(matches!(
        workspace.update_automation_agent(&agent.id, settings.clone()),
        Err(Error::InvalidAutomationAgent(_))
    ));
    assert_eq!(workspace.automation_agent(&agent.id).unwrap(), agent);

    settings.tools.any_command = true;
    workspace
        .update_automation_agent(&agent.id, settings)
        .unwrap();
}
