use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{Error, Workspace, embedded_attachments};

/// Recovery is private authoring state, never a published ticket, Document or Activity.
/// Revision is compare-and-swap: zero creates an owner; releases retain a tombstone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DraftRetention {
    pub owner: String,
    pub kind: String,
    pub revision: i64,
    pub payload: Option<serde_json::Value>,
    pub markdown: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentProtection {
    pub kind: String,
    pub owner: String,
    pub ticket_id: Option<String>,
    pub trashed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentUsage {
    /// Advisory only: cleanup must recheck under its write/file coordination.
    pub eligible: bool,
    pub legacy_drafts_pending: bool,
    pub protections: Vec<AttachmentProtection>,
}

pub(crate) fn migrate(tx: &Connection, existing_workspace: bool) -> Result<(), Error> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS attachment_drafts (
            owner TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('draft','undo')),
            revision INTEGER NOT NULL CHECK(revision>0), payload TEXT, markdown TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS attachment_draft_references (
            owner TEXT NOT NULL REFERENCES attachment_drafts(owner), uri TEXT NOT NULL,
            attachment_id TEXT REFERENCES attachments(id), PRIMARY KEY(owner, uri));
         CREATE INDEX IF NOT EXISTS attachment_draft_uses ON attachment_draft_references(attachment_id);
         CREATE TABLE IF NOT EXISTS attachment_draft_cutover (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pending INTEGER NOT NULL CHECK(pending IN (0,1)));",
    )?;
    let retained_files: bool =
        tx.query_row("SELECT EXISTS(SELECT 1 FROM attachments)", [], |r| r.get(0))?;
    tx.execute(
        "INSERT OR IGNORE INTO attachment_draft_cutover VALUES (1,?1)",
        [existing_workspace && retained_files],
    )?;
    // Usage is visible to library consumers and workspace change pollers.
    crate::change_token::migrate(tx)?;
    Ok(())
}

impl Workspace {
    pub fn draft_cutover_pending(&self) -> Result<bool, Error> {
        Ok(self.connection.query_row(
            "SELECT pending FROM attachment_draft_cutover WHERE singleton=1",
            [],
            |r| r.get(0),
        )?)
    }
    /// Only after the desktop has durably imported every legacy browser recovery slot.
    pub fn complete_draft_cutover(&mut self) -> Result<(), Error> {
        self.connection.execute(
            "UPDATE attachment_draft_cutover SET pending=0 WHERE singleton=1",
            [],
        )?;
        Ok(())
    }
    /// Every recovery row an editor may resume, read at desktop startup. Empty
    /// editor-history rows (`undo:` owners, unique to one editor mount) are
    /// skipped: earlier versions left one behind for every closed editor.
    pub fn draft_retentions(&self) -> Result<Vec<DraftRetention>, Error> {
        let mut statement = self.connection.prepare(
            "SELECT owner, kind, revision, payload, markdown FROM attachment_drafts
             WHERE NOT (owner LIKE 'undo:%' AND payload IS NULL AND markdown = '[]')
             ORDER BY owner",
        )?;
        let rows = statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        rows.map(|row| {
            let (owner, kind, revision, payload, markdown) = row?;
            Ok(DraftRetention {
                owner,
                kind,
                revision,
                payload: payload.map(|s| serde_json::from_str(&s)).transpose()?,
                markdown: serde_json::from_str(&markdown)?,
            })
        })
        .collect()
    }

    /// Atomically persist recovery prose and its derived attachment protections.
    /// Never expires or deletes bytes; missing/foreign links remain recoverable text.
    pub fn retain_draft(&mut self, draft: &DraftRetention) -> Result<DraftRetention, Error> {
        if draft.owner.trim().is_empty()
            || draft.owner.len() > 512
            || !matches!(draft.kind.as_str(), "draft" | "undo")
            || draft.revision < 0
            || draft.revision == i64::MAX
        {
            return Err(Error::Attachment(
                "invalid recovery owner, kind or revision".into(),
            ));
        }
        crate::write_scope::run(&self.connection, |tx| {
            let previous: Option<i64> = tx
                .query_row(
                    "SELECT revision FROM attachment_drafts WHERE owner=?1",
                    [&draft.owner],
                    |r| r.get(0),
                )
                .optional()?;
            if previous == Some(draft.revision + 1) {
                let (kind, payload, markdown): (String, Option<String>, String) = tx.query_row(
                    "SELECT kind,payload,markdown FROM attachment_drafts WHERE owner=?1",
                    [&draft.owner],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                if kind == draft.kind
                    && payload
                        == draft
                            .payload
                            .as_ref()
                            .map(serde_json::to_string)
                            .transpose()?
                    && markdown == serde_json::to_string(&draft.markdown)?
                {
                    return Ok(DraftRetention {
                        revision: draft.revision + 1,
                        ..draft.clone()
                    });
                }
            }
            let release = draft.payload.is_none() && draft.markdown.is_empty();
            // A replayed release of editor history that is already gone.
            if previous.is_none() && release && draft.revision > 0 {
                return Ok(DraftRetention {
                    revision: 0,
                    ..draft.clone()
                });
            }
            if previous.unwrap_or(0) != draft.revision {
                return Err(Error::Attachment("recovery draft changed in another window; copy this window's draft before reloading to review the stored recovery".into()));
            }
            // Releasing editor history removes it: its owner belongs to one editor
            // mount, so no other window can resume or resurrect it, and a tombstone
            // would only grow the startup read.
            if release && previous.is_some() {
                let history: bool = tx.query_row(
                    "SELECT kind='undo' FROM attachment_drafts WHERE owner=?1",
                    [&draft.owner],
                    |r| r.get(0),
                )?;
                if history {
                    tx.execute(
                        "DELETE FROM attachment_draft_references WHERE owner=?1",
                        [&draft.owner],
                    )?;
                    tx.execute(
                        "DELETE FROM attachment_drafts WHERE owner=?1",
                        [&draft.owner],
                    )?;
                    return Ok(DraftRetention {
                        revision: 0,
                        ..draft.clone()
                    });
                }
            }
            let next = draft.revision + 1;
            tx.execute("INSERT INTO attachment_drafts(owner,kind,revision,payload,markdown) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(owner) DO UPDATE SET kind=excluded.kind,revision=excluded.revision,payload=excluded.payload,markdown=excluded.markdown",
            params![draft.owner,draft.kind,next,draft.payload.as_ref().map(serde_json::to_string).transpose()?,serde_json::to_string(&draft.markdown)?])?;
            // Undo/Redo can still reach older values after autosave or controlled replacement.
            // Its union is retired only by an explicit history release/reset.
            if draft.kind != "undo" {
                tx.execute(
                    "DELETE FROM attachment_draft_references WHERE owner=?1",
                    [&draft.owner],
                )?;
            }
            let prefix = format!(
                "ticketd://attachment/{}/",
                embedded_attachments::workspace_id(tx)?
            );
            for uri in draft
                .markdown
                .iter()
                .flat_map(|body| embedded_attachments::destinations(body))
                .collect::<std::collections::BTreeSet<_>>()
            {
                // Recovery must preserve broken links too. An unknown ID is unresolved, never a valid stored file.
                let id = if let Some(id) = uri.strip_prefix(&prefix) {
                    let exists: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM attachments WHERE id=?1)",
                        [id],
                        |r| r.get(0),
                    )?;
                    if exists {
                        let file = crate::attachments::read_attachment(tx, id)?;
                        // Private recovery must still save prose containing missing bytes.
                        // A canonical save performs strict restore/validation before committing.
                        if file.quarantined
                            && crate::attachments::validate_attachment_bytes(tx, &file).is_ok()
                        {
                            crate::attachment_cleanup::restore_reference(tx, id)?;
                        }
                    }
                    exists.then_some(id)
                } else {
                    None
                };
                tx.execute("INSERT OR IGNORE INTO attachment_draft_references(owner,uri,attachment_id) VALUES (?1,?2,?3)", params![draft.owner,uri,id])?;
            }
            Ok(DraftRetention {
                revision: next,
                ..draft.clone()
            })
        })
    }

    pub fn release_draft(&mut self, owner: &str, revision: i64) -> Result<DraftRetention, Error> {
        self.retain_draft(&DraftRetention {
            owner: owner.into(),
            kind: "draft".into(),
            revision,
            payload: None,
            markdown: vec![],
        })
    }

    /// Includes recoverable trash and unpromoted Activity details; never flattens linked Documents.
    pub fn attachment_usage(&self, id: &str) -> Result<AttachmentUsage, Error> {
        crate::read_scope::run(&self.connection, |tx| read_usage(tx, id))
    }
}

pub(crate) fn read_usage(tx: &Connection, id: &str) -> Result<AttachmentUsage, Error> {
    let file = crate::attachments::read_attachment(tx, id)?;
    let mut statement = tx.prepare(
            "SELECT 'ticket_attachment', t.id, t.id, t.trashed FROM ticket_attachments a JOIN tickets t ON t.id=a.ticket_id WHERE a.attachment_id=?1
             UNION ALL SELECT 'ticket_body', t.id, t.id, t.trashed FROM embedded_attachments a JOIN tickets t ON t.id=a.source_id WHERE a.attachment_id=?1
             UNION ALL SELECT 'document_body', d.id, NULL, d.trashed FROM embedded_attachments a JOIN documents d ON d.id=a.source_id WHERE a.attachment_id=?1
             UNION ALL SELECT 'activity_brief', n.id, t.id, t.trashed FROM embedded_attachments a JOIN activities n ON n.id=a.source_id JOIN tickets t ON t.id=n.ticket_id WHERE a.attachment_id=?1
             UNION ALL SELECT d.kind, d.owner, NULL, 0 FROM attachment_draft_references a JOIN attachment_drafts d ON d.owner=a.owner WHERE a.attachment_id=?1
             ORDER BY 1,2",
        )?;
    let protections = statement
        .query_map([id], |r| {
            Ok(AttachmentProtection {
                kind: r.get(0)?,
                owner: r.get(1)?,
                ticket_id: r.get(2)?,
                trashed: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let legacy_drafts_pending: bool = tx.query_row(
        "SELECT pending FROM attachment_draft_cutover WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    Ok(AttachmentUsage {
        // Bytes already purged, or being purged, are nothing to clean up.
        eligible: file.purge_state == crate::AttachmentPurgeState::Retained
            && protections.is_empty()
            && !legacy_drafts_pending,
        legacy_drafts_pending,
        protections,
    })
}
