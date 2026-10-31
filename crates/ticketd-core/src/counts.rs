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
        let counts = self.connection.query_row(
            &format!(
                "SELECT \
               (SELECT COUNT(*) FROM inbox_entries WHERE person = ?1 AND read = 0), \
               (SELECT COUNT(*) FROM tickets t WHERE t.trashed = 0 AND t.status = 'Todo' \
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
