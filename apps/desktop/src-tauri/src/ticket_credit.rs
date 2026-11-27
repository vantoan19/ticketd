//! The sub-agent a ticket's Activity or status change is credited to, for the ticket's feed
//! and history (`credited_to`, see `docs/architecture.md`).
//!
//! Credit is kept in the Workspace of the computer the Chat ran on and never synced, so the
//! field is filled only where the writing Chat is on this computer, and only for a
//! sub-agent (the author line already names the main agent). Everywhere else it is absent
//! and the record shows its author alone.

use serde::Serialize;
use serde_json::{Value, json};
use ticketd_core::{ActivityFeedEntry, ChatWriteCredit, Error, HistoryEntry, Workspace};

use crate::chat_view::retention;

#[derive(Serialize)]
struct CreditedSubAgent {
    chat_id: String,
    retention: &'static str,
    /// The sub-agent's ID in the Chat's view (its native ID).
    sub_agent: String,
    title: String,
}

/// The credit as the interface reads it, when a sub-agent of a Chat this computer holds.
fn credited_to(workspace: &Workspace, credit: &ChatWriteCredit) -> Result<Option<Value>, Error> {
    let Some(native_id) = &credit.sub_agent else {
        return Ok(None);
    };
    let Some(record) = workspace.chat_sub_agent(&credit.chat_id, native_id)? else {
        return Ok(None);
    };
    let chat = workspace.chat(&credit.chat_id)?;
    Ok(Some(json!(CreditedSubAgent {
        chat_id: chat.id.clone(),
        retention: retention(&chat),
        sub_agent: record.native_id.clone(),
        title: record.title(),
    })))
}

/// A ticket's feed, each recorded change and authored Activity carrying its credit.
pub fn credited_feed(
    workspace: &Workspace,
    reference: &str,
    feed: Vec<ActivityFeedEntry>,
) -> Result<Vec<Value>, Error> {
    let credits = workspace.ticket_write_credits(reference)?;
    feed.into_iter()
        .map(|entry| {
            let credit = match &entry {
                ActivityFeedEntry::Authored { activity } => credits.activities.get(&activity.id),
                ActivityFeedEntry::Automatic { id, .. } => credits.statuses.get(id),
            };
            let credited = credit
                .map(|credit| credited_to(workspace, credit))
                .transpose()?
                .flatten();
            let mut value = serde_json::to_value(&entry)?;
            if let Some(credited) = credited {
                let inner = match entry {
                    ActivityFeedEntry::Authored { .. } => "activity",
                    ActivityFeedEntry::Automatic { .. } => "event",
                };
                value[inner]["credited_to"] = credited;
            }
            Ok(value)
        })
        .collect()
}

/// A ticket's history, each status move carrying its credit.
pub fn credited_history(workspace: &Workspace, reference: &str) -> Result<Vec<Value>, Error> {
    workspace
        .ticket_history_credits(reference)?
        .into_iter()
        .map(|(entry, credit): (HistoryEntry, _)| {
            let credited = credit
                .map(|credit| credited_to(workspace, &credit))
                .transpose()?
                .flatten();
            let mut value = serde_json::to_value(&entry)?;
            if let Some(credited) = credited {
                value["credited_to"] = credited;
            }
            Ok(value)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use ticketd_core::{ChatObservation, ChatOwner, ChatToolState, NewChat, Status, TicketPatch};

    struct Fixture {
        _dir: tempfile::TempDir,
        host: Workspace,
        path: std::path::PathBuf,
        chat: String,
    }

    /// A Chat whose sub-agent "sa-tests" has a shell command open.
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite3");
        let mut host = Workspace::open(&path).unwrap();
        let chat = host
            .create_chat(
                None,
                NewChat {
                    title: None,
                    harness: "claude-code".into(),
                    execution_folder: "/work/app".into(),
                    folder_managed: false,
                    links: Vec::new(),
                },
            )
            .unwrap();
        host.create_ticket("Limiter").unwrap();
        host.record_chat_observations(
            &chat.id,
            vec![
                ChatObservation::SubAgentStarted {
                    native_id: "sa-tests".into(),
                    parent: None,
                    tool_id: None,
                    turn_id: None,
                    native_run_id: None,
                    background: true,
                    payload: r#"{"description":"Check limiter test coverage\nand report"}"#.into(),
                },
                ChatObservation::Tool {
                    tool_id: "run-1:bash".into(),
                    turn_id: None,
                    owner: ChatOwner::SubAgent {
                        native_id: "sa-tests".into(),
                    },
                    name: "Bash".into(),
                    input: String::new(),
                    state: ChatToolState::Running,
                    output: None,
                },
                ChatObservation::ShellStep {
                    tool_id: "run-1:bash".into(),
                    writes: Vec::new(),
                },
            ],
        )
        .unwrap();
        Fixture {
            _dir: dir,
            host,
            path,
            chat: chat.id,
        }
    }

    /// What the `ticketd` CLI does for the Chat's harness.
    fn cli(fixture: &Fixture) -> Workspace {
        let mut cli = Workspace::open(&fixture.path).unwrap();
        cli.act_for_chat(&fixture.chat).unwrap();
        cli
    }

    fn reference(workspace: &Workspace) -> String {
        workspace.list_tickets().unwrap()[0].reference.clone()
    }

    #[test]
    fn the_feed_and_the_history_carry_the_sub_agent_a_write_is_credited_to() {
        let fixture = fixture();
        let reference = reference(&fixture.host);
        let mut cli = cli(&fixture);
        cli.add_activity(&reference, "Added a case.", Some("claude-code"))
            .unwrap();
        cli.change_ticket(
            &reference,
            TicketPatch {
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
        .unwrap();
        // A person's own update, on the same ticket, is credited to nobody.
        let mut person = Workspace::open(&fixture.path).unwrap();
        person
            .add_activity(&reference, "By a person.", None)
            .unwrap();

        let feed = fixture.host.activity_feed(&reference, 20, 0).unwrap();
        let feed = credited_feed(&fixture.host, &reference, feed).unwrap();
        let expected = json!({
            "chat_id": fixture.chat,
            "retention": "active",
            "sub_agent": "sa-tests",
            "title": "Check limiter test coverage",
        });
        let authored: Vec<_> = feed
            .iter()
            .filter(|entry| entry["type"] == "authored")
            .collect();
        assert_eq!(authored.len(), 2);
        let credited = authored
            .iter()
            .find(|entry| entry["activity"]["brief"] == "Added a case.")
            .unwrap();
        assert_eq!(credited["activity"]["credited_to"], expected);
        let by_person = authored
            .iter()
            .find(|entry| entry["activity"]["brief"] == "By a person.")
            .unwrap();
        assert!(by_person["activity"].get("credited_to").is_none());
        let moved = feed
            .iter()
            .find(|entry| entry["type"] == "automatic" && entry["event"]["kind"] == "status")
            .unwrap();
        assert_eq!(moved["event"]["credited_to"], expected);

        let history = credited_history(&fixture.host, &reference).unwrap();
        let status = history
            .iter()
            .find(|entry| entry["kind"] == "status")
            .unwrap();
        assert_eq!(status["credited_to"], expected);
    }

    #[test]
    fn a_write_of_the_main_agent_carries_no_sub_agent() {
        let mut fixture = fixture();
        let reference = reference(&fixture.host);
        // The command is over; the Chat's main agent writes afterwards.
        fixture
            .host
            .record_chat_observations(
                &fixture.chat,
                vec![ChatObservation::Tool {
                    tool_id: "run-1:bash".into(),
                    turn_id: None,
                    owner: ChatOwner::SubAgent {
                        native_id: "sa-tests".into(),
                    },
                    name: "Bash".into(),
                    input: String::new(),
                    state: ChatToolState::Completed,
                    output: None,
                }],
            )
            .unwrap();
        cli(&fixture)
            .add_activity(&reference, "From the main agent.", Some("claude-code"))
            .unwrap();

        let feed = fixture.host.activity_feed(&reference, 20, 0).unwrap();
        let feed = credited_feed(&fixture.host, &reference, feed).unwrap();
        assert!(
            feed.iter()
                .all(|entry| entry["activity"].get("credited_to").is_none())
        );
    }
}
