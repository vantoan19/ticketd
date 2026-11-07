use std::fs;

use rusqlite::Connection;
use serde::Serialize;

use crate::{Attachment, AttachmentKind, AttachmentUsage, Error, Workspace, attachments};

#[derive(Debug, Serialize)]
pub struct AttachmentCleanupReview {
    pub attachment: Attachment,
    pub eligible: bool,
    pub reason: String,
    pub usage: AttachmentUsage,
}

pub(crate) fn migrate(tx: &Connection) -> Result<(), Error> {
    tx.execute_batch("ALTER TABLE attachments ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0 CHECK(quarantined IN (0,1) AND (quarantined=0 OR kind='local_snapshot')); ALTER TABLE attachments ADD COLUMN added_at TEXT; PRAGMA user_version=53;")?;
    Ok(())
}

fn review(tx: &Connection, id: &str) -> Result<AttachmentCleanupReview, Error> {
    let attachment = attachments::read_attachment(tx, id)?;
    let usage = crate::attachment_retention::read_usage(tx, id)?;
    let (eligible, reason) = if attachment.kind != AttachmentKind::LocalSnapshot {
        (
            false,
            "External reference · No local storage to reclaim. Remote files are never deleted."
                .into(),
        )
    } else if attachment.quarantined {
        (false, "Quarantined · Restore to reuse this file.".into())
    } else if usage.legacy_drafts_pending {
        (
            false,
            "Protected · Review recoverable drafts in all profiles first.".into(),
        )
    } else if !usage.protections.is_empty() {
        (
            false,
            "Protected by saved references, recoverable drafts, Undo or Trash.".into(),
        )
    } else if let Err(error) = attachments::validate_attachment_bytes(tx, &attachment) {
        (false, error.to_string())
    } else {
        (
            true,
            "Unused local snapshot · Eligible for reversible quarantine.".into(),
        )
    };
    Ok(AttachmentCleanupReview {
        attachment,
        eligible,
        reason,
        usage,
    })
}

impl Workspace {
    pub fn attachment_cleanup_reviews(
        &self,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<AttachmentCleanupReview>, Error> {
        self.recover_uploads()?;
        let tx = self.connection.unchecked_transaction()?;
        let mut statement =
            tx.prepare("SELECT id FROM attachments ORDER BY rowid DESC LIMIT ?1 OFFSET ?2")?;
        let ids = statement
            .query_map(rusqlite::params![limit.min(1000), offset], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let results = ids
            .iter()
            .map(|id| review(&tx, id))
            .collect::<Result<_, _>>()?;
        tx.commit()?;
        Ok(results)
    }

    pub fn attachment_cleanup_review(&self, id: &str) -> Result<AttachmentCleanupReview, Error> {
        self.recover_uploads()?;
        let tx = self.connection.unchecked_transaction()?;
        let result = review(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }

    /// Explicit and idempotent. Previously displayed eligibility is never authority.
    pub fn quarantine_attachment(&mut self, id: &str) -> Result<Attachment, Error> {
        let _files = self.attachment_backup_lock()?;
        self.quarantine_attachment_locked(id)
    }

    pub(crate) fn quarantine_attachment_locked(&mut self, id: &str) -> Result<Attachment, Error> {
        let tx = self.connection.savepoint()?;
        crate::transaction_write_lock(&tx)?;
        let current = review(&tx, id)?;
        if current.attachment.quarantined {
            return Ok(current.attachment);
        }
        if !current.eligible {
            return Err(Error::Attachment(current.reason));
        }
        move_bytes(&tx, &current.attachment, true)?;
        tx.execute("UPDATE attachments SET quarantined=1 WHERE id=?1", [id])?;
        let file = attachments::read_attachment(&tx, id)?;
        tx.commit()?;
        Ok(file)
    }

    pub fn restore_attachment(&mut self, id: &str) -> Result<Attachment, Error> {
        let _files = self.attachment_backup_lock()?;
        self.restore_attachment_locked(id)
    }

    pub(crate) fn restore_attachment_locked(&mut self, id: &str) -> Result<Attachment, Error> {
        let tx = self.connection.savepoint()?;
        crate::transaction_write_lock(&tx)?;
        let file = attachments::read_attachment(&tx, id)?;
        if file.kind != AttachmentKind::LocalSnapshot {
            return Err(Error::Attachment("External references have no local bytes to restore. Remote files remain unchanged.".into()));
        }
        restore_reference(&tx, id)?;
        attachments::validate_attachment_bytes(&tx, &file)?;
        let file = attachments::read_attachment(&tx, id)?;
        tx.commit()?;
        Ok(file)
    }
}

/// The caller already holds the SQLite writer lock. Never acquire the upload lock here.
pub(crate) fn restore_reference(tx: &Connection, id: &str) -> Result<(), Error> {
    let file = attachments::read_attachment(tx, id)?;
    if file.kind != AttachmentKind::LocalSnapshot {
        return Ok(());
    }
    let root = attachments::attachment_directory(tx)?;
    let quarantined_bytes = root.join(quarantine_locator(&file.locator)).try_exists()?;
    let needs_restore = file.kind == AttachmentKind::LocalSnapshot
        && (file.quarantined || (!root.join(&file.locator).try_exists()? && quarantined_bytes));
    if needs_restore {
        move_bytes(tx, &file, false)?;
        tx.execute("UPDATE attachments SET quarantined=0 WHERE id=?1", [id])?;
    }
    Ok(())
}

pub(crate) fn quarantine_locator(locator: &str) -> String {
    locator.replacen("/bytes/", "/quarantine/", 1)
}

fn move_bytes(tx: &Connection, file: &Attachment, quarantine: bool) -> Result<(), Error> {
    if file.kind != AttachmentKind::LocalSnapshot {
        return Err(Error::Attachment(
            "Only local snapshots have reclaimable bytes.".into(),
        ));
    }
    // The checked handle resolver accepts either retained location after a failed DB commit.
    let source = attachments::validate_attachment_bytes(tx, file)?;
    let root = attachments::attachment_directory(tx)?;
    let relative = if quarantine {
        quarantine_locator(&file.locator)
    } else {
        file.locator.clone()
    };
    let destination = root.canonicalize()?.join(relative);
    let parent = destination
        .parent()
        .ok_or_else(|| Error::Attachment("invalid managed destination".into()))?;
    fs::create_dir_all(parent)?;
    // Reject redirections at the destination as well as at the source.
    crate::attachment_previews::reject_link(parent)
        .map_err(|error| Error::Attachment(error.message))?;
    if fs::symlink_metadata(&destination).is_ok() {
        crate::attachment_previews::reject_link(&destination)
            .map_err(|error| Error::Attachment(error.message))?;
    }
    if source == destination {
        return Ok(());
    }
    if destination.try_exists()? {
        return Err(Error::Attachment("Both retained byte locations exist; preserve both files and review storage before retrying.".into()));
    }
    fs::rename(&source, &destination)?;
    crate::backup_archive::sync_directory(parent)?;
    if let Some(parent) = source.parent() {
        crate::backup_archive::sync_directory(parent)?;
    }
    Ok(())
}
