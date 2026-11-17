//! What New Chat suggests while its message box is empty, chosen from local records:
//! continue the In progress tickets changed last, review the latest In review ticket,
//! then triage the Inbox when anything in it is unread. Nothing here sends anything;
//! the view fills the box and links the records the person picks.
use std::cmp::Reverse;
use std::collections::HashSet;
use std::path::Path;

use crate::search::ActiveTicket;
use crate::{Error, Status, Workspace};

/// At most this many suggestions show.
const MOST: usize = 3;
/// Continue suggests at most this many tickets.
const CONTINUE_MOST: usize = 2;
/// Triage links at most this many unread tickets.
const TRIAGE_LINKS: usize = 20;

/// A ticket as the suggestions weigh it.
type Candidate = ActiveTicket;

/// One unread Inbox entry: the ticket it is about and when it arrived.
#[derive(Debug, Clone)]
struct Unread {
    pub reference: String,
    pub timestamp: String,
}

/// What the suggestions are chosen from.
#[derive(Debug, Default)]
struct Records {
    pub tickets: Vec<Candidate>,
    /// Newest first.
    pub unread: Vec<Unread>,
    /// The Project whose checkout the chosen folder is in; its tickets come first.
    pub project_id: Option<String>,
    /// Tickets already linked to the New Chat, or linked to a Chat that is working.
    pub skip: HashSet<String>,
}

/// A ticket a suggestion links.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuggestedTicket {
    pub id: String,
    pub reference: String,
    pub title: String,
    pub status: Status,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatSuggestion {
    Continue {
        ticket: SuggestedTicket,
        at: Option<String>,
    },
    Review {
        ticket: SuggestedTicket,
        at: Option<String>,
    },
    /// `count` unread entries about the linked tickets; `at` is the newest.
    Triage {
        count: usize,
        links: Vec<SuggestedTicket>,
        at: String,
    },
}

fn record(ticket: &Candidate) -> SuggestedTicket {
    SuggestedTicket {
        id: ticket.id.clone(),
        reference: ticket.reference.clone(),
        title: ticket.title.clone(),
        status: ticket.status,
    }
}

impl Workspace {
    /// New Chat's suggestions for `folder` (`None`: a folder ticketd keeps): the
    /// tickets of the Project whose checkout holds it come first. `skip` names tickets
    /// not to suggest: those already linked, and those a working Chat is linked to.
    pub fn chat_suggestions(
        &self,
        folder: Option<&Path>,
        skip: HashSet<String>,
    ) -> Result<Vec<ChatSuggestion>, Error> {
        self.read(|_| {
            let project_id = match folder {
                Some(folder) => self.project_for_folder(folder)?.map(|project| project.id),
                None => None,
            };
            let unread: Vec<Unread> = self
                .inbox_page(100, 0, true)?
                .into_iter()
                .map(|entry| Unread {
                    reference: entry.reference,
                    timestamp: entry.timestamp,
                })
                .collect();
            // Only the tickets a suggestion can name: the first of those under way in the
            // order `suggest` weighs them, enough to remain once `skip` is left out, and
            // those the unread entries are about.
            let references = serde_json::to_string(
                &unread
                    .iter()
                    .map(|entry| entry.reference.as_str())
                    .collect::<Vec<_>>(),
            )?;
            let tickets = crate::search::suggestion_candidates(
                &self.connection,
                project_id.as_deref(),
                [
                    (Status::InProgress, CONTINUE_MOST + skip.len()),
                    (Status::InReview, 1 + skip.len()),
                ],
                &references,
            )?;
            Ok(suggest(&Records {
                tickets,
                unread,
                project_id,
                skip,
            }))
        })
    }
}

fn suggest(records: &Records) -> Vec<ChatSuggestion> {
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
    let mut found: Vec<ChatSuggestion> = with(Status::InProgress)
        .take(CONTINUE_MOST)
        .map(|ticket| ChatSuggestion::Continue {
            ticket: record(ticket),
            at: ticket.updated_at.clone(),
        })
        .collect();
    found.extend(
        with(Status::InReview)
            .take(1)
            .map(|ticket| ChatSuggestion::Review {
                ticket: record(ticket),
                at: ticket.updated_at.clone(),
            }),
    );
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
        found.push(ChatSuggestion::Triage {
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

    fn refs(found: &[ChatSuggestion]) -> Vec<String> {
        found
            .iter()
            .map(|suggestion| match suggestion {
                ChatSuggestion::Continue { ticket, .. } => format!("continue {}", ticket.reference),
                ChatSuggestion::Review { ticket, .. } => format!("review {}", ticket.reference),
                ChatSuggestion::Triage { count, .. } => format!("triage {count}"),
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
        assert_eq!(refs(&suggest(&records)), ["continue T-1", "continue T-2"]);
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
        let [ChatSuggestion::Triage { count, links, at }] = found.as_slice() else {
            panic!("expected one triage suggestion, got {found:?}");
        };
        assert_eq!(
            (*count, links.len(), at.as_str()),
            (2, 1, "2026-11-13T00:00:00Z")
        );
    }
}
