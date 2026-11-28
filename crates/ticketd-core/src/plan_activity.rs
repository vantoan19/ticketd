use rusqlite::{Row, params};
use serde::Serialize;

use crate::{Error, Status, Workspace};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanActivity {
    pub reference: String,
    pub title: String,
    pub timestamp: String,
    pub editing_agent: Option<String>,
    #[serde(flatten)]
    pub change: PlanActivityChange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanActivityChange {
    Status { from: Status, to: Status },
    Joined,
    Update { brief: String },
}

impl Workspace {
    /// Newest status changes, joins and authored updates across the Plan's current members.
    /// The response contains at most 100 events with at most 1024 characters of each brief.
    pub fn plan_activity(&self, id: &str, limit: u32) -> Result<Vec<PlanActivity>, Error> {
        self.read_plan_activity(id, limit, false)
    }

    /// The same events, keeping only each member's latest change before applying the limit.
    pub fn latest_plan_activity(&self, id: &str, limit: u32) -> Result<Vec<PlanActivity>, Error> {
        self.read_plan_activity(id, limit, true)
    }

    fn read_plan_activity(
        &self,
        id: &str,
        limit: u32,
        latest_per_ticket: bool,
    ) -> Result<Vec<PlanActivity>, Error> {
        crate::read_scope::run(&self.connection, |tx| {
            crate::plans::get(tx, id)?;
            let limit = limit.min(100);
            if limit == 0 {
                return Ok(Vec::new());
            }
            // No event past the per-member limit in either stream can make the
            // final page. The two correlated reads use the existing feed indexes.
            let per_member = if latest_per_ticket { 1 } else { limit };
            let mut stmt = tx.prepare(
                "WITH candidates AS (
                    SELECT t.id, t.reference, t.title, h.kind, h.timestamp, h.editing_agent,
                           h.from_value, h.to_value, NULL AS brief, 0 AS authored, h.number
                    FROM tickets t JOIN ticket_history h ON h.number IN (
                        SELECT number FROM ticket_history
                        WHERE ticket_id = t.id AND (kind = 'status' OR (kind = 'plan' AND to_value = ?1))
                        ORDER BY timestamp DESC, number DESC LIMIT ?2
                    )
                    WHERE t.plan_id = ?1 AND t.trashed = 0
                    UNION ALL
                    SELECT t.id, t.reference, t.title, 'update', a.reported_at, a.editing_agent,
                           NULL, NULL, substr(a.brief, 1, 1024), 1, a.number
                    FROM tickets t JOIN activities a ON a.number IN (
                        SELECT number FROM activities WHERE ticket_id = t.id
                        ORDER BY reported_at DESC, number DESC LIMIT ?2
                    )
                    WHERE t.plan_id = ?1 AND t.trashed = 0
                ), ranked AS (
                    SELECT *, row_number() OVER (
                        PARTITION BY id ORDER BY timestamp DESC, authored DESC, number DESC
                    ) AS member_order
                    FROM candidates
                )
                SELECT reference, title, timestamp, editing_agent, kind, from_value, to_value, brief
                FROM ranked
                WHERE NOT ?3 OR member_order = 1
                ORDER BY timestamp DESC, authored DESC, number DESC
                LIMIT ?4",
            )?;
            Ok(stmt
                .query_map(
                    params![id, per_member, latest_per_ticket, limit],
                    read_event,
                )?
                .collect::<Result<Vec<_>, _>>()?)
        })
    }
}

fn read_event(row: &Row<'_>) -> rusqlite::Result<PlanActivity> {
    let change = match row.get_ref(4)?.as_str()? {
        "status" => PlanActivityChange::Status {
            from: read_status(row, 5)?,
            to: read_status(row, 6)?,
        },
        "plan" => PlanActivityChange::Joined,
        "update" => PlanActivityChange::Update { brief: row.get(7)? },
        kind => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("invalid Plan activity kind: {kind}"),
                )
                .into(),
            ));
        }
    };
    Ok(PlanActivity {
        reference: row.get(0)?,
        title: row.get(1)?,
        timestamp: row.get(2)?,
        editing_agent: row.get(3)?,
        change,
    })
}

fn read_status(row: &Row<'_>, column: usize) -> rusqlite::Result<Status> {
    row.get::<_, String>(column)?.parse().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}
