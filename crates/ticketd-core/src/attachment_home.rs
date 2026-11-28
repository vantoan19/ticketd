use rusqlite::{OptionalExtension, Row, types::Type};
use serde::{Deserialize, Serialize};

use crate::{Error, Status, Workspace, documents::HEADING};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentHomePlan {
    pub id: String,
    pub name: String,
    pub archived: bool,
}

/// The live ticket or Document where a file belongs in Files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttachmentHome {
    Ticket {
        id: String,
        reference: String,
        title: String,
        status: Status,
        plan: Option<AttachmentHomePlan>,
    },
    Document {
        id: String,
        title: String,
        plan: Option<AttachmentHomePlan>,
        spec: bool,
    },
}

impl Workspace {
    /// The live home of a file, if any. For cleanup eligibility, use
    /// [`attachment_usage`](Self::attachment_usage).
    pub fn attachment_home(&self, id: &str) -> Result<Option<AttachmentHome>, Error> {
        let homes = home_ctes();
        Ok(self
            .connection
            .query_row(
                &format!(
                    "WITH attachment_ids(id) AS (SELECT ?1), {homes} SELECT * FROM attachment_homes"
                ),
                [id],
                home_from_row,
            )
            .optional()?)
    }
}

/// One home per used attachment in the caller's `attachment_ids(id)` CTE.
/// The winning reference is retained alongside its home for ordering files within a home.
/// Reference rowids preserve addition order even when a reference has no recorded date.
pub(crate) fn home_ctes() -> String {
    format!(
        "home_embeds AS (
             SELECT a.attachment_id, a.source_id, a.uri, a.rowid AS reference_order
             FROM embedded_attachments a JOIN attachment_ids f ON f.id = a.attachment_id
         ), home_candidates AS (
             SELECT a.attachment_id, t.id AS ticket_id, NULL AS document_id, 0 AS priority,
                    a.rowid AS reference_order, 0 AS source_order, t.id AS source_id, NULL AS source_uri
             FROM ticket_attachments a
             JOIN attachment_ids f ON f.id = a.attachment_id
             JOIN tickets t ON t.id = a.ticket_id AND t.trashed = 0
             UNION ALL
             SELECT a.attachment_id, t.id, NULL, 1, a.reference_order, 0, a.source_id, a.uri
             FROM home_embeds a JOIN tickets t ON t.id = a.source_id AND t.trashed = 0
             UNION ALL
             SELECT a.attachment_id, t.id, NULL, 2, a.reference_order, n.rowid, a.source_id, a.uri
             FROM home_embeds a
             JOIN activities n ON n.id = a.source_id
             JOIN tickets t ON t.id = n.ticket_id AND t.trashed = 0
             UNION ALL
             SELECT a.attachment_id, t.id, NULL, 2, a.reference_order, n.rowid, a.source_id, a.uri
             FROM home_embeds a
             JOIN documents d ON d.id = a.source_id AND d.trashed = 0
             JOIN activities n ON n.supporting_document_id = d.id
             JOIN tickets t ON t.id = n.ticket_id AND t.trashed = 0
             UNION ALL
             SELECT a.attachment_id, NULL, d.id, 3, a.reference_order, 0, a.source_id, a.uri
             FROM home_embeds a JOIN documents d ON d.id = a.source_id AND d.trashed = 0
             WHERE d.originating_activity_id IS NULL OR d.kept = 1
         ), ranked_attachment_homes AS (
             SELECT *, row_number() OVER (
                 PARTITION BY attachment_id ORDER BY priority, reference_order, source_order
             ) AS rank
             FROM home_candidates
         ), attachment_homes AS (
             SELECT h.attachment_id, h.ticket_id, h.document_id, t.reference,
                    coalesce(t.title, {HEADING}) AS title, t.status,
                    p.id AS plan_id, p.name AS plan_name, p.archived AS plan_archived,
                    coalesce(p.spec_document_id = d.id, 0) AS spec,
                    h.priority, h.reference_order, h.source_order, h.source_id, h.source_uri
             FROM ranked_attachment_homes h
             LEFT JOIN tickets t ON t.id = h.ticket_id
             LEFT JOIN documents d ON d.id = h.document_id
             LEFT JOIN plans p ON p.id = coalesce(t.plan_id, (
                 SELECT id FROM (
                     SELECT dp.id, dp.archived, coalesce(dp.spec_document_id = d.id, 0) AS spec, dp.name
                     FROM plan_documents pd JOIN plans dp ON dp.id = pd.plan_id
                     WHERE pd.document_id = d.id
                 )
                 ORDER BY archived, spec DESC, name, id LIMIT 1
             ))
             WHERE h.rank = 1
         )"
    )
}

pub(crate) fn home_from_row(row: &Row<'_>) -> rusqlite::Result<AttachmentHome> {
    let plan = match row.get("plan_id")? {
        Some(id) => Some(AttachmentHomePlan {
            id,
            name: row.get("plan_name")?,
            archived: row.get("plan_archived")?,
        }),
        None => None,
    };
    let title = row.get("title")?;
    if let Some(id) = row.get("ticket_id")? {
        let status_index = row.as_ref().column_index("status")?;
        let status = row
            .get::<_, String>(status_index)?
            .parse()
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(status_index, Type::Text, Box::new(error))
            })?;
        Ok(AttachmentHome::Ticket {
            id,
            reference: row.get("reference")?,
            title,
            status,
            plan,
        })
    } else {
        Ok(AttachmentHome::Document {
            id: row.get("document_id")?,
            title,
            plan,
            spec: row.get("spec")?,
        })
    }
}
