//! The examples the empty Automations page offers. Each becomes an ordinary
//! Automation, off, that the person finishes and switches on.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::automations::{
    Automation, AutomationDefinition, Check, Schedule, Step, StepAction, StepChange, Trigger,
    Weekday,
};
use crate::{Error, Status, Workspace};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationExample {
    TriageTaggedTickets,
    VerifyReadyForTesting,
    WeeklySummary,
}

impl AutomationExample {
    fn name(self) -> &'static str {
        match self {
            Self::TriageTaggedTickets => "Triage tagged tickets",
            Self::VerifyReadyForTesting => "Verify what is ready for testing",
            Self::WeeklySummary => "Weekly summary",
        }
    }

    /// The name of the Automation agent its step runs, when the person has one.
    fn agent(self) -> &'static str {
        match self {
            Self::TriageTaggedTickets => "Triage",
            Self::VerifyReadyForTesting => "Verifier",
            Self::WeeklySummary => "Weekly summary",
        }
    }
}

fn step(action: StepAction) -> Step {
    Step {
        id: Uuid::new_v4().to_string(),
        action,
    }
}

impl Workspace {
    /// Creates the Automation an example describes. Its Run agent step runs the
    /// agent with the example's name; without one the step has no agent, and like
    /// every value an example cannot know (the folder to work in) it shows on the
    /// step as what it still needs.
    pub fn create_example_automation(
        &mut self,
        example: AutomationExample,
    ) -> Result<Automation, Error> {
        let agent_id = self
            .automation_agents()?
            .into_iter()
            .find(|agent| agent.settings.name.eq_ignore_ascii_case(example.agent()))
            .map(|agent| agent.id);
        let run_agent = step(StepAction::RunAgent {
            agent_id,
            execution_folder: None,
            on_failure: None,
        });
        let tag_added = |tag: &str| {
            Some(Trigger::TagAdded {
                tag: tag.to_owned(),
            })
        };
        let (trigger, steps) = match example {
            AutomationExample::TriageTaggedTickets => {
                (tag_added("ready-for-triage"), vec![run_agent])
            }
            // The agent records its result on the ticket: it adds the tag `verified`
            // when the work passes. An agent that finds the work broken has still
            // finished its step, so the If reads the tag, not how the step ended.
            AutomationExample::VerifyReadyForTesting => (
                tag_added("ready-for-testing"),
                vec![
                    run_agent,
                    step(StepAction::If {
                        checks: vec![Check::Tag {
                            tag: "verified".to_owned(),
                            has: true,
                        }],
                        yes: vec![step(StepAction::ChangeTicket {
                            change: Some(StepChange::SetStatus {
                                status: Status::Done,
                            }),
                            on_failure: None,
                        })],
                        no: vec![step(StepAction::ChangeTicket {
                            change: Some(StepChange::AddTag {
                                tag: "needs-fix".to_owned(),
                            }),
                            on_failure: None,
                        })],
                    }),
                ],
            ),
            AutomationExample::WeeklySummary => (
                Some(Trigger::Schedule {
                    schedule: Schedule::Weekly {
                        time: "09:00".to_owned(),
                        weekdays: vec![Weekday::Mon],
                    },
                }),
                vec![run_agent],
            ),
        };
        self.create_automation(AutomationDefinition {
            name: example.name().to_owned(),
            trigger,
            conditions: Vec::new(),
            steps,
        })
    }
}
