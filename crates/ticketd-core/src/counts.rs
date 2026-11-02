use crate::{Error, Workspace, history::unresolved_blocker_sql};
use serde::{Deserialize, Serialize};

/// Counts shown beside the workspace sidebar views.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarCounts {
    pub unread_inbox: u32,
    pub ready: u32,
    pub in_progress: u32,
}

impl Workspace {
    /// Count unread inbox entries plus Ready and In progress tickets in one read.
    ///
    /// Ready matches the Ready list: Todo tickets with no unsatisfied prerequisite, where
    /// only Done satisfies one. Trashed tickets are excluded from both ticket counts.
    pub fn sidebar_counts(&self) -> Result<SidebarCounts, Error> {
        self.deliver_due_reminders()?;
        let unresolved = unresolved_blocker_sql("blocker");
        let held = crate::source::held_sql("t.id");
        let counts = self.connection.query_row(
            &format!(
                "SELECT \
               (SELECT COUNT(*) FROM inbox_entries WHERE person = ?1 AND read = 0), \
               (SELECT COUNT(*) FROM tickets t WHERE t.trashed = 0 AND t.status = 'Todo' \
                  AND NOT {held} \
                  AND NOT EXISTS (SELECT 1 FROM dependencies d JOIN tickets blocker ON blocker.id = d.blocker_id \
                                  WHERE d.dependent_id = t.id AND {unresolved})), \
               (SELECT COUNT(*) FROM tickets WHERE trashed = 0 AND status = 'In progress')"
            ),
            [crate::inbox::LOCAL_PERSON],
            |row| {
                Ok(SidebarCounts {
                    unread_inbox: row.get(0)?,
                    ready: row.get(1)?,
                    in_progress: row.get(2)?,
                })
            },
        )?;
        Ok(counts)
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
