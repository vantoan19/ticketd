//! What New Chat suggests while its message box is empty, chosen from local records:
//! continue the In progress tickets changed last, review the latest In review ticket,
//! then triage the Inbox when anything in it is unread. Nothing here sends anything;
//! the view fills the box and links the records the person picks.
use std::cmp::Reverse;
use std::collections::HashSet;

use serde::Serialize;
use ticketd_core::Status;

use crate::chat_view::LinkedRecord;

/// At most this many suggestions show.
const MOST: usize = 3;
/// Continue suggests at most this many tickets.
const CONTINUE_MOST: usize = 2;
/// Triage links at most this many unread tickets.
const TRIAGE_LINKS: usize = 20;

/// A ticket as the suggestions weigh it.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: String,
    pub reference: String,
    pub title: String,
    pub status: Status,
    pub project_id: Option<String>,
    /// Last content or organization change, as an RFC 3339 timestamp.
    pub updated_at: Option<String>,
}

/// One unread Inbox entry: the ticket it is about and when it arrived.
#[derive(Debug, Clone)]
pub struct Unread {
    pub reference: String,
    pub timestamp: String,
}

/// What the suggestions are chosen from.
#[derive(Debug, Default)]
pub struct Records {
    pub tickets: Vec<Candidate>,
    /// Newest first.
    pub unread: Vec<Unread>,
    /// The Project whose checkout the chosen folder is in; its tickets come first.
    pub project_id: Option<String>,
    /// Tickets already linked to the New Chat, or linked to a Chat that is working.
    pub skip: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Suggestion {
    Continue {
        ticket: LinkedRecord,
        at: Option<String>,
    },
    Review {
        ticket: LinkedRecord,
        at: Option<String>,
    },
    /// `count` unread entries about the linked tickets; `at` is the newest.
    Triage {
        count: usize,
        links: Vec<LinkedRecord>,
        at: String,
    },
}

fn record(ticket: &Candidate) -> LinkedRecord {
    LinkedRecord::Ticket {
        id: ticket.id.clone(),
        reference: ticket.reference.clone(),
        title: ticket.title.clone(),
        status: match ticket.status {
            Status::Todo => "Todo",
            Status::InProgress => "In progress",
            Status::InReview => "In review",
            Status::Done => "Done",
            Status::Canceled => "Canceled",
            Status::Duplicate => "Duplicate",
        }
        .to_owned(),
    }
}

pub fn suggest(records: &Records) -> Vec<Suggestion> {
    // The folder's Project first, then the most recently changed.
    let mut open: Vec<&Candidate> = records
        .tickets
        .iter()
        .filter(|ticket| !records.skip.contains(&ticket.id))
        .collect();
    open.sort_by_key(|ticket| {
        (
            records.project_id.is_none() || ticket.project_id != records.project_id,
            Reverse(ticket.updated_at.clone()),
        )
    });
    let with = |status: Status| open.iter().filter(move |ticket| ticket.status == status);
    let mut found: Vec<Suggestion> = with(Status::InProgress)
        .take(CONTINUE_MOST)
        .map(|ticket| Suggestion::Continue {
            ticket: record(ticket),
            at: ticket.updated_at.clone(),
        })
        .collect();
    found.extend(with(Status::InReview).take(1).map(|ticket| Suggestion::Review {
        ticket: record(ticket),
        at: ticket.updated_at.clone(),
    }));
    if let Some(newest) = records.unread.first() {
        let mut seen = HashSet::new();
        let links = records
            .unread
            .iter()
            .filter(|entry| seen.insert(entry.reference.as_str()))
            .filter_map(|entry| {
                records
                    .tickets
                    .iter()
                    .find(|ticket| ticket.reference == entry.reference)
            })
            .filter(|ticket| !records.skip.contains(&ticket.id))
            .take(TRIAGE_LINKS)
            .map(record)
            .collect();
        found.push(Suggestion::Triage {
            count: records.unread.len(),
            links,
            at: newest.timestamp.clone(),
        });
    }
    found.truncate(MOST);
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket(reference: &str, status: Status, updated_at: &str) -> Candidate {
        Candidate {
            id: format!("id-{reference}"),
            reference: reference.to_owned(),
            title: format!("Title {reference}"),
            status,
            project_id: None,
            updated_at: Some(updated_at.to_owned()),
        }
    }

    fn refs(found: &[Suggestion]) -> Vec<String> {
        found
            .iter()
            .map(|suggestion| match suggestion {
                Suggestion::Continue {
                    ticket: LinkedRecord::Ticket { reference, .. },
                    ..
                } => format!("continue {reference}"),
                Suggestion::Review {
                    ticket: LinkedRecord::Ticket { reference, .. },
                    ..
                } => format!("review {reference}"),
                Suggestion::Triage { count, .. } => format!("triage {count}"),
                other => format!("{other:?}"),
            })
            .collect()
    }

    #[test]
    fn continues_the_latest_in_progress_then_reviews_then_triages_up_to_three() {
        let records = Records {
            tickets: vec![
                ticket("T-1", Status::InProgress, "2026-11-10T10:00:00Z"),
                ticket("T-2", Status::InReview, "2026-11-12T10:00:00Z"),
                ticket("T-3", Status::InProgress, "2026-11-12T09:00:00Z"),
                ticket("T-4", Status::Todo, "2026-11-13T09:00:00Z"),
            ],
            unread: vec![Unread {
                reference: "T-4".into(),
                timestamp: "2026-11-13T09:00:00Z".into(),
            }],
            ..Records::default()
        };
        assert_eq!(
            refs(&suggest(&records)),
            ["continue T-3", "continue T-1", "review T-2"]
        );
    }

    #[test]
    fn puts_the_folders_project_first_and_skips_linked_and_busy_tickets() {
        let mut ours = ticket("T-1", Status::InProgress, "2026-11-01T00:00:00Z");
        ours.project_id = Some("p".into());
        let records = Records {
            tickets: vec![
                ours,
                ticket("T-2", Status::InProgress, "2026-11-12T00:00:00Z"),
                ticket("T-3", Status::InProgress, "2026-11-13T00:00:00Z"),
            ],
            project_id: Some("p".into()),
            skip: HashSet::from(["id-T-3".to_owned()]),
            ..Records::default()
        };
        assert_eq!(
            refs(&suggest(&records)),
            ["continue T-1", "continue T-2"]
        );
    }

    #[test]
    fn triage_counts_unread_entries_and_links_each_ticket_once() {
        let records = Records {
            tickets: vec![ticket("T-1", Status::Todo, "2026-11-01T00:00:00Z")],
            unread: vec![
                Unread {
                    reference: "T-1".into(),
                    timestamp: "2026-11-13T00:00:00Z".into(),
                },
                Unread {
                    reference: "T-1".into(),
                    timestamp: "2026-11-12T00:00:00Z".into(),
                },
            ],
            ..Records::default()
        };
        let found = suggest(&records);
        let [Suggestion::Triage { count, links, at }] = found.as_slice() else {
            panic!("expected one triage suggestion, got {found:?}");
        };
        assert_eq!((*count, links.len(), at.as_str()), (2, 1, "2026-11-13T00:00:00Z"));
    }
}
