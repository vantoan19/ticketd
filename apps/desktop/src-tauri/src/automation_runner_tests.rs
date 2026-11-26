//! The desktop's one Automation runner: when it is created, and what it tells the
//! runner about the Chat host. No window: the runner is built from a temporary
//! Workspace and a notifier that shows nothing.
#![allow(clippy::unwrap_used, clippy::panic)] // test setup and assertions

use ticketd_chat_host::HostError;
use ticketd_core::{
    AutomationAgentSettings, AutomationDefinition, AutomationRun, AutomationRunStatus, Step,
    StepAction, Trigger, Workspace,
};

use super::*;

const TAG: &str = "ready-for-triage";

struct Fixture {
    dir: tempfile::TempDir,
    chats: Arc<Chats>,
    runner: AutomationRunner,
    automation: String,
}

impl Fixture {
    /// A Workspace whose Automation has a run the previous process left Running, and
    /// a runner over it with Chat off.
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite3");
        let mut core = Workspace::open(&path).unwrap();
        let agent = core
            .create_automation_agent(AutomationAgentSettings::default())
            .unwrap();
        let automation = core
            .create_automation(AutomationDefinition {
                name: "Triage".into(),
                trigger: Some(Trigger::TagAdded { tag: TAG.into() }),
                conditions: Vec::new(),
                steps: vec![Step {
                    id: "triage".into(),
                    action: StepAction::RunAgent {
                        agent_id: Some(agent.id),
                        execution_folder: Some(std::env::temp_dir().to_string_lossy().into_owned()),
                        on_failure: None,
                    },
                }],
            })
            .unwrap();
        core.set_automation_enabled(&automation.id, true).unwrap();
        let opener: WorkspaceOpener =
            Arc::new(move || ticketd_core::WorkspaceSession::for_file(&path)?.workspace());
        let chats = Chats::new(opener.clone(), Vec::new(), Vec::new(), None);
        let runner = AutomationRunner::new(chats.clone(), opener, Arc::new(|_| Ok(())));
        let fixture = Self {
            dir,
            chats,
            runner,
            automation: automation.id,
        };
        fixture.start_a_run("Left running");
        fixture
    }

    fn core(&self) -> Workspace {
        Workspace::open(self.dir.path().join("workspace.sqlite3")).unwrap()
    }

    /// A ticket is tagged and its run starts, so it is Running.
    fn start_a_run(&self, title: &str) {
        let mut core = self.core();
        let ticket = core.create_ticket(title).unwrap();
        core.add_tag(&ticket.reference, TAG).unwrap();
        core.queue_automation_runs().unwrap();
        core.start_automation_runs(5).unwrap();
    }

    fn runs(&self) -> Vec<AutomationRun> {
        let mut runs = self.core().automation_runs(&self.automation).unwrap();
        runs.reverse();
        runs
    }
}

/// A Stop in the first moments after launch must find the run still Running, as the
/// person saw it, not already ended by the runner's cleanup of the previous process's
/// runs: the runner exists before any command, and with Chat off.
#[tokio::test]
async fn the_runner_ends_the_runs_a_gone_process_left_going_at_startup_even_with_chat_off() {
    let f = Fixture::new();
    assert!(!f.chats.enabled());
    assert_eq!(f.runs()[0].status, AutomationRunStatus::Running);

    f.runner.start_up();

    let runs = f.runs();
    assert_eq!(runs[0].status, AutomationRunStatus::NeedsAttention);
    assert_eq!(
        runs[0].reason.as_deref(),
        Some("ticketd closed while this run was going.")
    );
}

/// The same runner serves every later command: asking for it again does not end the
/// runs that began since as left over.
#[tokio::test]
async fn asking_for_the_runner_again_does_not_end_runs_that_began_since() {
    let f = Fixture::new();
    f.runner.start_up();
    // A run that begins after launch, and the person's Stop of it through the runner
    // the commands use.
    let mut core = f.core();
    let ticket = core.create_ticket("Started after launch").unwrap();
    core.add_tag(&ticket.reference, TAG).unwrap();
    core.queue_automation_runs().unwrap();
    let started = core.start_automation_runs(5).unwrap().remove(0);

    let runner = f.runner.get().unwrap();
    let stopped = runner.stop_run(&started.id).await.unwrap();

    assert_eq!(stopped.reason.as_deref(), Some("You stopped this run."));
}

/// A pass that fails is tried again every few seconds, so its log line must not repeat:
/// one when the failure starts or changes kind, and one when passes work again.
#[tokio::test]
async fn a_failing_pass_logs_when_it_starts_changes_kind_and_recovers_not_on_every_attempt() {
    use std::sync::atomic::{AtomicU8, Ordering};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    Workspace::open(&path).unwrap();
    let mode = Arc::new(AtomicU8::new(0));
    let opener: WorkspaceOpener = {
        let mode = Arc::clone(&mode);
        Arc::new(move || match mode.load(Ordering::SeqCst) {
            0 => Err(Error::ChatNotFound("c".into())),
            1 => Err(Error::Attachment("a".into())),
            _ => ticketd_core::WorkspaceSession::for_file(&path)?.workspace(),
        })
    };
    let chats = Chats::new(opener.clone(), Vec::new(), Vec::new(), None);
    let runner = AutomationRunner::new(chats, opener, Arc::new(|_| Ok(())));
    let logs = ticketd_diagnostics::DesktopLogs::open(dir.path().join("logs"), Default::default());

    logs.with_default(|| {
        for step in [0, 0, 0, 1, 1, 2, 2, 2] {
            mode.store(step, Ordering::SeqCst);
            runner.pass();
        }
    });

    let mut text = String::new();
    for entry in std::fs::read_dir(dir.path().join("logs")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|extension| extension == "log") {
            text.push_str(&std::fs::read_to_string(path).unwrap());
        }
    }
    let lines: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let summary: Vec<_> = lines
        .iter()
        .map(|line| {
            (
                line["level"].as_str().unwrap(),
                line["message"].as_str().unwrap(),
                line["error_kind"].as_str().unwrap_or(""),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("WARN", "an Automation pass failed", "not_found"),
            ("WARN", "an Automation pass failed", "failed"),
            ("INFO", "Automation passes work again", ""),
        ]
    );
}

#[tokio::test]
async fn the_runner_is_told_why_there_is_no_chat_host() {
    let f = Fixture::new();
    assert!(matches!(
        f.chats.automation_host(),
        Err(HostError::TurnedOff)
    ));
    let _ = f.chats.set_enabled(true).await;
    assert!(f.chats.automation_host().is_ok());
    let backup = f.dir.path().join("valid.ticketd-backup");
    assert!(f.core().backup(&backup).unwrap());
    let chats = f.chats.clone();
    f.chats
        .restore(backup, move |path| {
            assert!(matches!(chats.automation_host(), Err(HostError::Restoring)));
            Ok(path)
        })
        .await
        .unwrap();
}
