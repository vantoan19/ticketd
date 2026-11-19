use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::{
    Attachment, AttachmentUsage, Error, Workspace, attachment_retention, attachments, relationships,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentState {
    #[default]
    All,
    InUse,
    Unused,
    Quarantined,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AttachmentQuery {
    pub search: String,
    pub state: AttachmentState,
    /// Prioritize related files without changing their reference ownership.
    pub ticket: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

impl Default for AttachmentQuery {
    fn default() -> Self {
        Self {
            search: String::new(),
            state: AttachmentState::All,
            ticket: None,
            limit: 50,
            offset: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentSearchResult {
    pub attachment: Attachment,
    pub usage: AttachmentUsage,
    pub related: bool,
    /// A kept local file whose stored copy is gone or cut short on this computer.
    #[serde(default)]
    pub missing: bool,
}

impl Workspace {
    /// Changes metadata only. Authored Markdown, upload replay outcomes and bytes stay literal.
    pub fn rename_attachment(&mut self, id: &str, display_name: &str) -> Result<Attachment, Error> {
        let display_name = attachments::normalize_display_name(display_name)?;
        let tx = self.connection.savepoint()?;
        crate::write_scope::lock(&tx)?;
        attachments::read_attachment(&tx, id)?;
        tx.execute(
            "UPDATE attachments SET display_name=?2 WHERE id=?1",
            params![id, display_name],
        )?;
        let attachment = attachments::read_attachment(&tx, id)?;
        tx.commit()?;
        Ok(attachment)
    }

    /// A bounded, consistent library snapshot, including completed abandoned uploads.
    pub fn search_attachments(
        &self,
        query: &AttachmentQuery,
    ) -> Result<Vec<AttachmentSearchResult>, Error> {
        self.recover_uploads()?;
        let tx = self.connection.unchecked_transaction()?;
        let ticket = query
            .ticket
            .as_deref()
            .map(|reference| relationships::id(&tx, reference))
            .transpose()?;
        let mut statement = tx.prepare(
            "WITH used AS (
                SELECT attachment_id FROM ticket_attachments
                UNION SELECT attachment_id FROM embedded_attachments WHERE attachment_id IS NOT NULL
                UNION SELECT attachment_id FROM attachment_draft_references WHERE attachment_id IS NOT NULL
             ), related_sources AS (
                SELECT ?1 AS id WHERE ?1 IS NOT NULL
                UNION SELECT id FROM activities WHERE ticket_id=?1
                UNION SELECT document_id FROM ticket_documents WHERE ticket_id=?1
                UNION SELECT target_id FROM context_mentions WHERE source_id=?1
                UNION SELECT supporting_document_id FROM activities WHERE ticket_id=?1
             ), related AS (
                SELECT attachment_id FROM ticket_attachments WHERE ticket_id=?1
                UNION SELECT attachment_id FROM embedded_attachments WHERE source_id IN (SELECT id FROM related_sources)
             )
             SELECT a.id, a.id IN (SELECT attachment_id FROM related WHERE attachment_id IS NOT NULL) AS is_related
             FROM attachments a
             WHERE (instr(lower(a.display_name), lower(?2)) > 0 OR instr(lower(a.original_filename), lower(?2)) > 0
                OR instr(lower(a.kind), lower(?2)) > 0 OR instr(lower(a.id), lower(?2)) > 0
                OR instr(CAST(a.size_bytes AS TEXT), ?2) > 0
                OR EXISTS (SELECT 1 FROM drive_references d WHERE d.attachment_id=a.id
                    AND (instr(lower(d.file_id), lower(?2)) > 0
                        OR instr(lower(json_extract(d.metadata, '$.name')), lower(?2)) > 0
                        OR instr(lower(json_extract(d.metadata, '$.mime_type')), lower(?2)) > 0)))
             AND (?3=0 OR (?3=1 AND a.id IN used) OR (?3=2 AND a.id NOT IN used AND a.quarantined=0) OR (?3=3 AND a.quarantined=1 AND a.purge_state<>'purged'))
             ORDER BY is_related DESC, a.rowid DESC LIMIT ?4 OFFSET ?5",
        )?;
        let ids = statement
            .query_map(
                params![
                    ticket,
                    query.search.trim(),
                    match query.state {
                        AttachmentState::All => 0,
                        AttachmentState::InUse => 1,
                        AttachmentState::Unused => 2,
                        AttachmentState::Quarantined => 3,
                    },
                    query.limit.min(1000),
                    query.offset
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let results = ids
            .into_iter()
            .map(|(id, related)| {
                let attachment = attachments::read_attachment(&tx, &id)?;
                Ok(AttachmentSearchResult {
                    missing: self.snapshot_missing(&attachment),
                    usage: attachment_retention::read_usage(&tx, &id)?,
                    attachment,
                    related,
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        tx.commit()?;
        Ok(results)
    }
}
