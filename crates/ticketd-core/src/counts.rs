use crate::{Error, Workspace, readiness, relationships};
use serde::{Deserialize, Serialize};

/// Counts shown beside the workspace sidebar views.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarCounts {
    pub unread_inbox: u32,
    pub total: u32,
    pub ready: u32,
    pub in_progress: u32,
    /// Automation runs that ended as Needs attention and the person has not yet run
    /// again, taken over or dismissed.
    pub runs_needing_you: u32,
}

impl Workspace {
    /// Count unread inbox entries plus Ready and In progress tickets in one read.
    ///
    /// Ready matches the Ready list (see `readiness`): Todo tickets with no unsatisfied
    /// prerequisite, where only Done satisfies one, and not held by their source. Trashed
    /// tickets are excluded from both ticket counts.
    pub fn sidebar_counts(&self) -> Result<SidebarCounts, Error> {
        let ready = readiness::ready_sql("t");
        let needs_you = crate::automation_runs::NEEDS_YOU;
        let counts = self.connection.prepare_cached(
            &format!(
                "SELECT \
               (SELECT COUNT(*) FROM inbox_entries WHERE person = ?1 AND read = 0), \
               (SELECT COUNT(*) FROM tickets t WHERE {ready}), \
               (SELECT COUNT(*) FROM tickets WHERE trashed = 0 AND status = 'In progress'), (SELECT COUNT(*) FROM tickets WHERE trashed = 0), \
               (SELECT COUNT(*) FROM automation_runs WHERE {needs_you})"
            ),
        )?.query_row(
            [crate::inbox::LOCAL_PERSON],
            |row| {
                Ok(SidebarCounts {
                    unread_inbox: row.get(0)?,
                    ready: row.get(1)?,
                    in_progress: row.get(2)?,
                    total: row.get(3)?,
                    runs_needing_you: row.get(4)?,
                })
            },
        )?;
        Ok(counts)
    }
}

/// Exact totals for the Linked and Files sections, independently of their loaded pages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TicketPeekCounts {
    pub linked: u64,
    pub files: u64,
}

impl Workspace {
    pub fn ticket_peek_counts(&self, reference: &str) -> Result<TicketPeekCounts, Error> {
        crate::read_scope::run(&self.connection, |tx| {
            let id = relationships::id(tx, reference)?;
            // A blocking subticket is one row in Linked, and a Document can
            // appear in Files through several independent sources.
            let (linked, files): (u64, u64) = tx.prepare_cached(
                "SELECT
                  (SELECT COUNT(*) FROM ticket_parents WHERE child_id = ?1 OR parent_id = ?1)
                  + (SELECT COUNT(*) FROM dependencies WHERE blocker_id = ?1)
                  + (SELECT COUNT(*) FROM dependencies d WHERE d.dependent_id = ?1
                     AND NOT EXISTS (SELECT 1 FROM ticket_parents p
                                     WHERE p.child_id = d.blocker_id AND p.parent_id = ?1))
                  + (SELECT COUNT(*) FROM contextual_relationships WHERE source_id = ?1 OR target_id = ?1)
                  + (SELECT COUNT(*) FROM duplicate_tickets WHERE source_id = ?1 OR canonical_id = ?1)
                  + (SELECT COUNT(*) FROM external_duplicate_targets e JOIN tickets t ON t.id = e.ticket_id
                     WHERE e.ticket_id = ?1 AND t.status = 'Duplicate'
                       AND NOT EXISTS (SELECT 1 FROM duplicate_tickets WHERE source_id = ?1)),
                  (SELECT COUNT(*) FROM ticket_attachments WHERE ticket_id = ?1)
                  + (SELECT COUNT(*) FROM documents WHERE id IN (
                       SELECT document_id FROM ticket_documents WHERE ticket_id = ?1
                       UNION SELECT target_id FROM context_mentions WHERE source_id = ?1
                       UNION SELECT m.target_id FROM activity_mentions m JOIN activities a ON a.id = m.activity_id
                       WHERE a.ticket_id = ?1
                  ))",
            )?.query_row([&id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            let mentions = crate::backlinks::mentioning_ticket_count(tx, reference)?;
            let documents =
                crate::document_links::ticket_document_mention_count(tx, &id, reference)?;
            Ok(TicketPeekCounts {
                linked: linked + mentions as u64 + documents as u64,
                files,
            })
        })
    }
}

/// Tickets of one filtered result set, by status.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct StatusCounts {
    pub todo: u64,
    pub in_progress: u64,
    pub in_review: u64,
    pub done: u64,
    pub canceled: u64,
    pub duplicate: u64,
}

impl StatusCounts {
    pub fn total(&self) -> u64 {
        self.todo + self.in_progress + self.in_review + self.done + self.canceled + self.duplicate
    }
}

/// Counts serialize with their `total`, so no client sums them itself.
impl Serialize for StatusCounts {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Wire {
            total: u64,
            todo: u64,
            in_progress: u64,
            in_review: u64,
            done: u64,
            canceled: u64,
            duplicate: u64,
        }
        Wire {
            total: self.total(),
            todo: self.todo,
            in_progress: self.in_progress,
            in_review: self.in_review,
            done: self.done,
            canceled: self.canceled,
            duplicate: self.duplicate,
        }
        .serialize(serializer)
    }
}
