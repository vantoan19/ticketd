//! The steps the runner executes itself, without an agent: Change ticket and Notify
//! me, in the order the flow gives them.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ticketd_automation_runner::{Notifier, Runner};
use ticketd_chat_host::{ChatHost, WorkspaceOpener};
use ticketd_core::{
    AutomationDefinition, AutomationNotification, AutomationRun, AutomationRunStatus,
    AutomationStepStatus, Check, NotifyTarget, Status, Step, StepAction, StepChange, Ticket,
    Trigger, Workspace, WorkspaceActor,
};

const TAG: &str = "ready-for-testing";

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    runner: Runner,
    automation_id: String,
    shown: Arc<Mutex<Vec<AutomationNotification>>>,
}

fn opener(path: &Path) -> WorkspaceOpener {
    let path = path.to_owned();
    Arc::new(move || Workspace::open(&path))
}

fn change(id: &str, change: StepChange) -> Step {
    Step {
        id: id.into(),
        action: StepAction::ChangeTicket {
            change: Some(change),
            on_failure: None,
        },
    }
}

fn notify(id: &str, text: &str) -> Step {
    Step {
        id: id.into(),
        action: StepAction::Notify {
            text: text.into(),
            opens: NotifyTarget::Ticket,
            on_failure: None,
        },
    }
}

impl Fixture {
    /// A Workspace with an Automation of `steps` that is on, and a runner whose
    /// notifications are kept, or refused when `notifications_work` is false.
    #[allow(clippy::unwrap_used)] // Setup that fails fails the test.
    fn new(steps: Vec<Step>, notifications_work: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite3");
        let mut workspace = Workspace::open(&path).unwrap();
        let automation = workspace
            .create_automation(AutomationDefinition {
                name: "Verify on staging".into(),
                trigger: Some(Trigger::TagAdded { tag: TAG.into() }),
                conditions: Vec::new(),
                steps,
            })
            .unwrap();
        workspace
            .set_automation_enabled(&automation.id, true)
            .unwrap();
        let shown = Arc::new(Mutex::new(Vec::new()));
        let kept = Arc::clone(&shown);
        let notifier: Notifier = Arc::new(move |notification| {
            if !notifications_work {
                return Err("Notifications are off for ticketd.".to_owned());
            }
            kept.lock().unwrap().push(notification);
            Ok(())
        });
        let host = ChatHost::new(opener(&path), Vec::new()).unwrap();
        let runner =
            Runner::new(opener(&path), Arc::new(move || Ok(host.clone())), notifier).unwrap();
        Self {
            _dir: dir,
            path,
            runner,
            automation_id: automation.id,
            shown,
        }
    }

    #[allow(clippy::unwrap_used)]
    fn core(&self) -> Workspace {
        Workspace::open(&self.path).unwrap()
    }

    #[allow(clippy::unwrap_used)]
    fn tag(&self, title: &str) -> Ticket {
        let mut core = self.core();
        let ticket = core.create_ticket(title).unwrap();
        core.add_tag(&ticket.reference, TAG).unwrap()
    }

    /// One pass of the loop, then everything it started runs until it waits.
    #[allow(clippy::unwrap_used)]
    async fn tick(&self) {
        self.runner.tick().unwrap();
        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    /// The Automation's one run.
    #[allow(clippy::unwrap_used)]
    fn run(&self) -> AutomationRun {
        let mut runs = self.core().automation_runs(&self.automation_id).unwrap();
        assert_eq!(runs.len(), 1);
        runs.remove(0)
    }

    #[allow(clippy::unwrap_used)]
    fn shown(&self) -> Vec<AutomationNotification> {
        self.shown.lock().unwrap().clone()
    }
}

fn steps(run: &AutomationRun) -> Vec<(&str, AutomationStepStatus)> {
    run.steps
        .iter()
        .map(|step| (step.step_id.as_str(), step.status))
        .collect()
}

#[tokio::test(start_paused = true)]
async fn steps_run_in_order_each_on_the_ticket_the_one_before_left() {
    let f = Fixture::new(
        vec![
            change(
                "tag",
                StepChange::AddTag {
                    tag: "verified".into(),
                },
            ),
            change("untag", StepChange::RemoveTag { tag: TAG.into() }),
            change(
                "done",
                StepChange::SetStatus {
                    status: Status::Done,
                },
            ),
            change(
                "update",
                StepChange::PostUpdate {
                    text: "Verified: {{ticket.title}} is {{ticket.status}}.".into(),
                },
            ),
            notify(
                "tell",
                "{{ticket.reference}} is {{ticket.status}} ({{event.tag}})",
            ),
        ],
        true,
    );
    let ticket = f.tag("Fix login");

    f.tick().await;

    use AutomationStepStatus::Completed;
    let run = f.run();
    assert_eq!(run.status, AutomationRunStatus::Completed);
    assert_eq!(
        steps(&run),
        [
            ("tag", Completed),
            ("untag", Completed),
            ("done", Completed),
            ("update", Completed),
            ("tell", Completed)
        ]
    );
    let core = f.core();
    let changed = core.show_ticket(&ticket.reference).unwrap();
    assert_eq!(changed.tags, ["verified"]);
    assert_eq!(changed.status, Status::Done);
    // The update and the notification were written after the status step ran.
    let updates = core.activities(&ticket.reference, 10, 0).unwrap();
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].brief, "Verified: Fix login is Done.");
    assert_eq!(
        updates[0].editing_agent.as_deref(),
        Some("Verify on staging")
    );
    let shown = f.shown();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].title, "Verify on staging");
    assert_eq!(
        shown[0].body,
        format!("{} is Done ({TAG})", ticket.reference)
    );
    assert_eq!(shown[0].opens, NotifyTarget::Ticket);
    assert_eq!(shown[0].run_id, run.id);

    // Everything the steps changed is the Automation's, so nothing starts from it.
    let after_tagging = run.event.as_ref().unwrap().id;
    let events = core.workspace_events_after(after_tagging, 100).unwrap();
    assert_eq!(events.len(), 4);
    assert!(
        events
            .iter()
            .all(|event| event.actor == WorkspaceActor::Automation)
    );
    f.tick().await;
    f.run();
}

#[tokio::test(start_paused = true)]
async fn a_change_the_workspace_refuses_fails_the_run_and_the_steps_after_it_do_not_run() {
    let f = Fixture::new(
        vec![
            change(
                "tag",
                StepChange::AddTag {
                    tag: "verified".into(),
                },
            ),
            notify("tell", "Verified {{ticket.reference}}"),
        ],
        true,
    );
    let ticket = f.tag("Fix login");
    // A trashed ticket takes no changes.
    f.core().set_trashed(&ticket.reference, true, None).unwrap();

    f.tick().await;

    let run = f.run();
    assert_eq!(run.status, AutomationRunStatus::NeedsAttention);
    assert_eq!(steps(&run), [("tag", AutomationStepStatus::Failed)]);
    let reason = run.reason.unwrap();
    assert!(reason.contains(&ticket.reference), "{reason}");
    assert_eq!(run.steps[0].reason.as_deref(), Some(reason.as_str()));
    assert_eq!(f.shown(), []);
}

/// `step` with the path the run takes when it fails.
fn or_else(mut step: Step, path: Vec<Step>) -> Step {
    match &mut step.action {
        StepAction::RunAgent { on_failure, .. }
        | StepAction::ChangeTicket { on_failure, .. }
        | StepAction::Notify { on_failure, .. } => *on_failure = Some(path),
        StepAction::If { .. } => {}
    }
    step
}

#[tokio::test(start_paused = true)]
async fn a_step_that_fails_with_a_failure_path_runs_the_path_and_the_run_completes() {
    let f = Fixture::new(
        vec![
            or_else(
                change(
                    "done",
                    StepChange::SetStatus {
                        status: Status::Done,
                    },
                ),
                vec![
                    notify("tell", "Could not close {{ticket.reference}}"),
                    notify("tell-again", "Still open"),
                ],
            ),
            notify("never-reached", "Closed"),
        ],
        true,
    );
    let ticket = f.tag("Fix login");
    // A trashed ticket takes no changes.
    f.core().set_trashed(&ticket.reference, true, None).unwrap();

    f.tick().await;

    use AutomationStepStatus::{Completed, Failed};
    let run = f.run();
    // The failure was handled: nothing asks for the person.
    assert_eq!(run.status, AutomationRunStatus::Completed);
    assert_eq!(run.reason, None);
    assert_eq!(
        steps(&run),
        [
            ("done", Failed),
            ("tell", Completed),
            ("tell-again", Completed)
        ]
    );
    // The step still says why it failed.
    let reason = run.steps[0].reason.as_deref().unwrap();
    assert!(reason.contains(&ticket.reference), "{reason}");
    let shown = f.shown();
    assert_eq!(shown.len(), 2);
    assert_eq!(
        shown[0].body,
        format!("Could not close {}", ticket.reference)
    );
    assert_eq!(shown[1].body, "Still open");
}

fn has_tag(id: &str, tag: &str, yes: Vec<Step>, no: Vec<Step>) -> Step {
    Step {
        id: id.into(),
        action: StepAction::If {
            checks: vec![Check::Tag {
                tag: tag.into(),
                has: true,
            }],
            yes,
            no,
        },
    }
}

/// record → If verified? → Yes: [yes] / No: [If needs-fix? → Yes: [fix] / No: [neither]]
fn branching(recorded: &str) -> Vec<Step> {
    vec![
        change(
            "record",
            StepChange::AddTag {
                tag: recorded.into(),
            },
        ),
        has_tag(
            "verified?",
            "verified",
            vec![notify("yes", "Verified")],
            vec![has_tag(
                "needs-fix?",
                "needs-fix",
                vec![notify("fix", "Needs a fix")],
                vec![notify("neither", "Nothing recorded")],
            )],
        ),
    ]
}

#[tokio::test(start_paused = true)]
async fn an_if_takes_the_yes_path_on_what_an_earlier_step_of_the_run_recorded() {
    let f = Fixture::new(branching("verified"), true);
    f.tag("Fix login");

    f.tick().await;

    use AutomationStepStatus::Completed;
    let run = f.run();
    assert_eq!(run.status, AutomationRunStatus::Completed);
    // The ticket had no "verified" tag when the run started.
    assert_eq!(
        steps(&run),
        [
            ("record", Completed),
            ("verified?", Completed),
            ("yes", Completed)
        ]
    );
    assert_eq!(f.shown()[0].body, "Verified");
}

#[tokio::test(start_paused = true)]
async fn an_if_takes_the_no_path_and_a_nested_if_chooses_again() {
    for (recorded, last, body) in [
        ("needs-fix", "fix", "Needs a fix"),
        ("unrelated", "neither", "Nothing recorded"),
    ] {
        let f = Fixture::new(branching(recorded), true);
        f.tag("Fix login");

        f.tick().await;

        use AutomationStepStatus::Completed;
        let run = f.run();
        assert_eq!(run.status, AutomationRunStatus::Completed);
        assert_eq!(
            steps(&run),
            [
                ("record", Completed),
                ("verified?", Completed),
                ("needs-fix?", Completed),
                (last, Completed)
            ]
        );
        assert_eq!(f.shown()[0].body, body);
    }
}

#[tokio::test(start_paused = true)]
async fn a_notification_that_cannot_be_shown_fails_its_step() {
    let f = Fixture::new(vec![notify("tell", "Verified")], false);
    f.tag("Fix login");

    f.tick().await;

    let run = f.run();
    assert_eq!(run.status, AutomationRunStatus::NeedsAttention);
    assert_eq!(
        run.reason.as_deref(),
        Some("The notification could not be shown. Notifications are off for ticketd.")
    );
}
