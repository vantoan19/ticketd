use std::fs;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::{
    Attachment, AttachmentKind, AttachmentPurgeState, AttachmentUsage, Error, Workspace,
    attachments,
};

#[derive(Debug, Serialize)]
pub struct AttachmentCleanupReview {
    pub attachment: Attachment,
    pub eligible: bool,
    pub purge_eligible: bool,
    pub remove_eligible: bool,
    pub reason: String,
    pub usage: AttachmentUsage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteAttachmentRemoval {
    pub id: String,
    pub display_name: String,
    pub open_url: String,
    pub message: String,
}

pub(crate) fn migrate(tx: &Connection) -> Result<(), Error> {
    tx.execute_batch("ALTER TABLE attachments ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0 CHECK(quarantined IN (0,1) AND (quarantined=0 OR kind='local_snapshot')); ALTER TABLE attachments ADD COLUMN added_at TEXT;")?;
    Ok(())
}

pub(crate) fn migrate_purge(tx: &Connection) -> Result<(), Error> {
    tx.execute_batch("ALTER TABLE attachments ADD COLUMN purge_state TEXT NOT NULL DEFAULT 'retained' CHECK(purge_state IN ('retained','pending','purged') AND (purge_state='retained' OR (kind='local_snapshot' AND quarantined=1)));")?;
    Ok(())
}

pub(crate) fn purge_unavailable(file: &Attachment) -> String {
    match file.purge_state {
        AttachmentPurgeState::Pending => "Permanent purge is pending; local bytes are unavailable. Retry the explicit purge to finish, or deliberately restore an older complete backup to a separate workspace.".into(),
        AttachmentPurgeState::Purged => "Local bytes were permanently purged. Restore an older complete backup to a separate workspace, or choose a replacement for this reference.".into(),
        AttachmentPurgeState::Retained => String::new(),
    }
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
    } else if attachment.purge_state != AttachmentPurgeState::Retained {
        (false, purge_unavailable(&attachment))
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
    } else if attachment.quarantined {
        (
            false,
            "Quarantined · Restore to reuse, or explicitly purge permanently.".into(),
        )
    } else {
        (
            true,
            "Unused local snapshot · Eligible for reversible quarantine.".into(),
        )
    };
    let purge_eligible = attachment.kind == AttachmentKind::LocalSnapshot
        && (attachment.purge_state == AttachmentPurgeState::Pending
            || (attachment.quarantined
                && attachment.purge_state == AttachmentPurgeState::Retained
                && usage.eligible
                && attachments::validate_attachment_bytes(tx, &attachment).is_ok()));
    Ok(AttachmentCleanupReview {
        remove_eligible: attachment.kind == AttachmentKind::ExternalReference && usage.eligible,
        attachment,
        eligible,
        purge_eligible,
        reason,
        usage,
    })
}

impl Workspace {
    /// Record-only cleanup: no provider or credential capability is involved.
    pub fn remove_remote_attachment(&mut self, id: &str) -> Result<RemoteAttachmentRemoval, Error> {
        let tx = self.connection.savepoint()?;
        crate::transaction_write_lock(&tx)?;
        let current = review(&tx, id)?;
        if current.attachment.kind != AttachmentKind::ExternalReference {
            return Err(Error::Attachment("Remove from ticketd is for remote records. Use reversible quarantine for local snapshots.".into()));
        }
        if !current.remove_eligible {
            return Err(Error::Attachment("Protected by saved references, recoverable drafts, Undo, Trash or unreviewed legacy drafts; review usage before removing from ticketd.".into()));
        }
        let metadata: String = tx.query_row(
            "SELECT metadata FROM drive_references WHERE attachment_id=?1",
            [id],
            |row| row.get(0),
        )?;
        let metadata: crate::drive::DriveMetadata = serde_json::from_str(&metadata)?;
        crate::drive::validate_metadata(&metadata.id, &metadata)?;
        let result = RemoteAttachmentRemoval {
            id: id.into(),
            display_name: current.attachment.display_name,
            open_url: metadata.web_url,
            message: "Removed from ticketd. The file remains in Drive, including copies uploaded by ticketd; no provider storage was reclaimed. Choose it again in the Google Drive picker to re-add it.".into(),
        };
        tx.execute("DELETE FROM drive_references WHERE attachment_id=?1", [id])?;
        tx.execute("DELETE FROM attachments WHERE id=?1", [id])?;
        tx.execute("UPDATE drive_upload_operations SET operation=json_set(operation,'$.record_removed',json('true')) WHERE attachment_id=?1", [id])?;
        tx.commit()?;
        Ok(result)
    }

    /// The identity itself makes retries idempotent. Never run inside a replay transaction:
    /// intent must commit before irreversible I/O, and completion only after deletion.
    pub fn purge_attachment(&mut self, id: &str) -> Result<Attachment, Error> {
        let _files = self.attachment_backup_lock()?;
        let tx = self.connection.savepoint()?;
        crate::transaction_write_lock(&tx)?;
        let file = attachments::read_attachment(&tx, id)?;
        if file.kind != AttachmentKind::LocalSnapshot {
            return Err(Error::Attachment(
                "Only quarantined local snapshots can be purged. Remote files are never deleted."
                    .into(),
            ));
        }
        if file.purge_state == AttachmentPurgeState::Purged {
            return Ok(file);
        }
        if file.purge_state == AttachmentPurgeState::Retained {
            let usage = crate::attachment_retention::read_usage(&tx, id)?;
            if !usage.eligible {
                return Err(Error::Attachment("Protected by saved references, recoverable drafts, Undo, Trash or unreviewed legacy drafts; review usage before purging.".into()));
            }
            if !file.quarantined {
                return Err(Error::Attachment(
                    "Move this local snapshot to quarantine before permanent purge.".into(),
                ));
            }
            let source = attachments::validate_attachment_bytes(&tx, &file)?;
            let root = attachments::attachment_directory(&tx)?.canonicalize()?;
            if source != root.join(quarantine_locator(&file.locator)) {
                return Err(Error::Attachment(
                    "Quarantine move is incomplete. Restore this attachment, then quarantine it again before permanent purge."
                        .into(),
                ));
            }
            tx.execute(
                "UPDATE attachments SET purge_state='pending' WHERE id=?1",
                [id],
            )?;
        }
        tx.commit()?;

        // No writer transaction during filesystem I/O. Committed pending state makes
        // concurrent canonical/draft restoration refuse these bytes without lock inversion.
        self.delete_purged_bytes(&file).map_err(|error| Error::Attachment(format!("Permanent purge is pending, not confirmed: {error}. Retry explicit purge for '{id}' after repairing managed storage; do not restore individual bytes.")))?;
        (|| {
            let tx = self.connection.savepoint()?;
            crate::transaction_write_lock(&tx)?;
            tx.execute("UPDATE attachments SET purge_state='purged' WHERE id=?1", [id])?;
            let file = attachments::read_attachment(&tx, id)?;
            tx.commit()?;
            Ok(file)
        })().map_err(|error: Error| Error::Attachment(format!("Permanent purge is pending: bytes were removed but completion was not recorded: {error}. Retry explicit purge for '{id}' to confirm completion.")))
    }

    fn delete_purged_bytes(&self, file: &Attachment) -> Result<(), Error> {
        let root = self.attachment_directory()?;
        let relative = quarantine_locator(&file.locator);
        if uuid::Uuid::parse_str(&file.id).is_err()
            || file.original_filename.contains(['/', '\\', ':', '\0'])
            || matches!(file.original_filename.as_str(), "" | "." | "..")
            || file.locator != format!("{}/bytes/{}", file.id, file.original_filename)
        {
            return Err(Error::Attachment(
                "Invalid managed snapshot locator; preserve files and repair metadata.".into(),
            ));
        }
        for path in [
            root.clone(),
            root.join(&file.id),
            root.join(&file.id).join("quarantine"),
        ] {
            crate::attachment_previews::reject_link(&path)
                .map_err(|error| Error::Attachment(error.message))?;
        }
        let destination = root.canonicalize()?.join(relative);
        let parent = destination
            .parent()
            .ok_or_else(|| Error::Attachment("invalid managed purge path".into()))?;
        match fs::symlink_metadata(root.join(&file.locator)) {
            Ok(_) => {
                return Err(Error::Attachment(
                    "Active bytes exist; preserve them and review managed storage before retrying."
                        .into(),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        match fs::symlink_metadata(&destination) {
            Ok(metadata) => {
                crate::attachment_previews::reject_link(&destination)
                    .map_err(|error| Error::Attachment(error.message))?;
                if !metadata.is_file() || Some(metadata.len()) != file.size_bytes {
                    return Err(Error::Attachment("Quarantined bytes are not the expected regular file; preserve them and review storage.".into()));
                }
                fs::remove_file(&destination)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        crate::backup_archive::sync_directory(parent)?;
        Ok(())
    }

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
    if file.purge_state != AttachmentPurgeState::Retained {
        return Err(Error::Attachment(purge_unavailable(&file)));
    }
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
