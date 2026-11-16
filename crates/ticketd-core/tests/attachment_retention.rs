#[path = "support/old_workspace.rs"]
mod old_workspace;

use serde_json::json;
use ticketd_core::{DraftRetention, Workspace};

#[test]
fn unpublished_draft_and_independent_undo_survive_reopen_and_release_without_deleting_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let source = dir.path().join("trace.txt");
    std::fs::write(&source, b"recoverable bytes").unwrap();
    let mut w = Workspace::open(&path).unwrap();
    let file = w.import_attachment("draft-upload", &source, None).unwrap();
    let body = format!("[Trace]({})", w.attachment_uri(&file.id).unwrap());
    let draft = DraftRetention {
        owner: "new-ticket".into(),
        kind: "draft".into(),
        revision: 0,
        payload: Some(json!({"title": "Unpublished", "body": body})),
        markdown: vec![body.clone()],
    };
    let retained = w.retain_draft(&draft).unwrap();
    assert_eq!(w.retain_draft(&draft).unwrap(), retained);
    assert!(!w.export().unwrap().to_string().contains("Unpublished"));
    let undo = w
        .retain_draft(&DraftRetention {
            owner: "editor-history".into(),
            kind: "undo".into(),
            payload: None,
            ..draft.clone()
        })
        .unwrap();
    let undo = w
        .retain_draft(&DraftRetention {
            markdown: vec!["Reference removed, still in Undo".into()],
            ..undo
        })
        .unwrap();
    drop(w);
    let mut w = Workspace::open(&path).unwrap();
    let mut other_window = Workspace::open(&path).unwrap();
    assert_eq!(w.draft_retentions().unwrap().len(), 2);
    assert_eq!(w.draft_retentions().unwrap()[1].payload, draft.payload);
    assert!(
        w.search_documents("Unpublished", None, 50, 0)
            .unwrap()
            .is_empty()
    );
    let usage = w.attachment_usage(&file.id).unwrap();
    assert!(!usage.eligible);
    assert_eq!(usage.protections.len(), 2);
    w.release_draft(&retained.owner, retained.revision).unwrap();
    assert_eq!(
        other_window
            .release_draft(&retained.owner, retained.revision)
            .unwrap()
            .revision,
        retained.revision + 1
    );
    assert!(other_window.retain_draft(&retained).is_err());
    assert_eq!(
        w.attachment_usage(&file.id).unwrap().protections[0].kind,
        "undo"
    );
    // An old window/completion cannot resurrect or remove a newer generation.
    assert!(w.retain_draft(&draft).is_err());
    assert!(w.release_draft(&undo.owner, 0).is_err());
    w.release_draft(&undo.owner, undo.revision).unwrap();
    assert!(w.attachment_usage(&file.id).unwrap().eligible);
    let export = dir.path().join("export.txt");
    w.export_attachment(&file.id, &export).unwrap();
    assert_eq!(std::fs::read(export).unwrap(), b"recoverable bytes");
}

#[test]
fn usage_counts_trash_and_preserves_activity_details_ownership() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let source = dir.path().join("file.txt");
    std::fs::write(&source, b"retained").unwrap();
    let file = w.import_attachment("upload", source, None).unwrap();
    let body = format!("[File]({})", w.attachment_uri(&file.id).unwrap());
    let ticket = w.create_ticket("Ticket").unwrap();
    w.set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    w.change_ticket(
        &ticket.reference,
        ticketd_core::TicketPatch {
            body: Some(body.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    let activity = w
        .add_activity_with_details(&ticket.reference, &body, None, Some(&body), None)
        .unwrap();
    let details = activity.supporting_document_id.as_ref().unwrap();
    w.set_document_trashed(details, true).unwrap();
    w.set_trashed(&ticket.reference, true, None).unwrap();
    let usage = w.attachment_usage(&file.id).unwrap();
    assert!(!usage.eligible);
    assert_eq!(usage.protections.len(), 4);
    assert!(usage.protections.iter().all(|p| p.trashed));
    w.set_trashed(&ticket.reference, false, None).unwrap();
    w.delete_activity(&ticket.reference, &activity.id).unwrap();
    let usage = w.attachment_usage(&file.id).unwrap();
    assert_eq!(usage.protections.len(), 3);
    assert!(
        usage
            .protections
            .iter()
            .any(|p| p.kind == "document_body" && p.owner == *details)
    );
    assert_eq!(w.show_document(details).unwrap().body, body);
}

#[test]
fn recovery_backup_is_complete_and_failed_replacement_preserves_the_previous_draft() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut w = Workspace::open(&path).unwrap();
    let source = dir.path().join("file.txt");
    std::fs::write(&source, b"draft backup").unwrap();
    let file = w.import_attachment("upload", source, None).unwrap();
    let body = format!("[File]({})", w.attachment_uri(&file.id).unwrap());
    let draft = w
        .retain_draft(&DraftRetention {
            owner: "document:capture".into(),
            kind: "draft".into(),
            revision: 0,
            payload: Some(json!({"body":body})),
            markdown: vec![body],
        })
        .unwrap();
    let faults = rusqlite::Connection::open(&path).unwrap();
    faults.execute_batch("CREATE TABLE reject_commit (id TEXT REFERENCES tickets(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_draft AFTER UPDATE ON attachment_drafts BEGIN INSERT INTO reject_commit VALUES ('missing'); END;").unwrap();
    assert!(w.release_draft(&draft.owner, draft.revision).is_err());
    assert_eq!(w.draft_retentions().unwrap(), std::slice::from_ref(&draft));
    assert!(!w.attachment_usage(&file.id).unwrap().eligible);
    faults
        .execute_batch("DROP TRIGGER reject_draft; DROP TABLE reject_commit;")
        .unwrap();
    let backup = dir.path().join("backup.sqlite3");
    w.backup(&backup).unwrap();
    let target = dir.path().join("restored.sqlite3");
    drop(Workspace::open(&target).unwrap());
    Workspace::restore(&target, &backup).unwrap();
    let restored = Workspace::open(&target).unwrap();
    assert_eq!(restored.draft_retentions().unwrap(), [draft]);
    assert!(!restored.attachment_usage(&file.id).unwrap().eligible);
    let export = dir.path().join("restored.txt");
    restored.export_attachment(&file.id, &export).unwrap();
    assert_eq!(std::fs::read(export).unwrap(), b"draft backup");
}

#[test]
fn older_workspace_with_retained_bytes_withholds_eligibility_until_browser_cutover() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    // Format version 49 predates draft tracking, so its retained bytes have no draft record.
    let id = old_workspace::workspace_with_attachment(&path, 49, "legacy", b"legacy draft bytes");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE attachment_upload_settings SET limit_bytes = 4096",
            [],
        )
        .unwrap();
    let mut w = Workspace::open(&path).unwrap();
    let usage = w.attachment_usage(&id).unwrap();
    assert_eq!(w.attachment_upload_limit().unwrap(), 4096);
    assert!(usage.legacy_drafts_pending);
    assert!(!usage.eligible);
    let backups = w.safety_backups().unwrap();
    assert_eq!(backups.len(), 1);
    assert!(matches!(
        w.inspect_backup(&backups[0].path).unwrap().check,
        ticketd_core::BackupCheck::Valid {
            format_version: 49,
            ..
        }
    ));
    w.complete_draft_cutover().unwrap();
    assert!(w.attachment_usage(&id).unwrap().eligible);
    let export = dir.path().join("export.txt");
    w.export_attachment(&id, &export).unwrap();
    assert_eq!(std::fs::read(export).unwrap(), b"legacy draft bytes");
    let target = dir.path().join("recovered-49.sqlite3");
    drop(Workspace::open(&target).unwrap());
    Workspace::restore(&target, &backups[0].path).unwrap();
    let recovered = Workspace::open(&target).unwrap();
    assert_eq!(recovered.attachment_upload_limit().unwrap(), 4096);
    assert!(recovered.draft_cutover_pending().unwrap());
    let export = dir.path().join("recovered-49.txt");
    recovered.export_attachment(&id, &export).unwrap();
    assert_eq!(std::fs::read(export).unwrap(), b"legacy draft bytes");
}

#[test]
fn attachment_free_upgrade_keeps_new_cli_uploads_eligible_without_a_desktop() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    drop(Workspace::open(&path).unwrap());
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch("DROP TABLE attachment_draft_references; DROP TABLE attachment_drafts; DROP TABLE attachment_draft_cutover; PRAGMA user_version=49;").unwrap();
    drop(old);
    let mut w = Workspace::open(&path).unwrap();
    assert!(!w.draft_cutover_pending().unwrap());
    let source = dir.path().join("new.txt");
    std::fs::write(&source, b"new CLI upload").unwrap();
    let file = w.import_attachment("new", source, None).unwrap();
    assert!(w.attachment_usage(&file.id).unwrap().eligible);
}
