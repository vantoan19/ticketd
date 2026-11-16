use crate::{Error, Workspace, readiness};
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
        self.deliver_due_reminders()?;
        let ready = readiness::ready_sql("t");
        let counts = self.connection.query_row(
            &format!(
                "SELECT \
               (SELECT COUNT(*) FROM inbox_entries WHERE person = ?1 AND read = 0), \
               (SELECT COUNT(*) FROM tickets t WHERE {ready}), \
               (SELECT COUNT(*) FROM tickets WHERE trashed = 0 AND status = 'In progress'), (SELECT COUNT(*) FROM tickets WHERE trashed = 0), \
               (SELECT COUNT(*) FROM automation_runs WHERE status = 'needs_attention' AND attention_cleared = 0)"
            ),
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
