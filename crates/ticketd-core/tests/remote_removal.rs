use ticketd_core::{Workspace, WriteRequest, WriteResult, drive::*};

struct Selected;
impl AttachmentProvider for Selected {
    fn metadata(&self, id: &str, _: Option<&str>) -> Result<DriveMetadata, DriveError> {
        Ok(DriveMetadata {
            id: id.into(),
            name: "Current plan".into(),
            mime_type: "application/vnd.google-apps.document".into(),
            size_bytes: None,
            web_url: format!("https://docs.google.com/document/d/{id}/edit"),
            resource_key: None,
        })
    }
}

#[test]
fn concurrent_reference_and_removal_cannot_commit_a_dangling_association() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut w = Workspace::open(&path).unwrap();
    let file = w
        .reference_drive_file(&uuid::Uuid::new_v4().to_string(), "plan", None, &Selected)
        .unwrap();
    let ticket = w.create_ticket("Concurrent reference").unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let other_path = path.clone();
    let other_id = file.id.clone();
    let other_barrier = barrier.clone();
    let reference = ticket.reference.clone();
    let writer = std::thread::spawn(move || {
        let mut w = Workspace::open(other_path).unwrap();
        other_barrier.wait();
        w.set_ticket_attachment(&reference, &other_id, true).is_ok()
    });
    barrier.wait();
    let removed = w.remove_remote_attachment(&file.id).is_ok();
    let linked = writer.join().unwrap();
    assert_ne!(removed, linked);
    if linked {
        assert_eq!(w.ticket_attachments(&ticket.reference).unwrap(), [file]);
    } else {
        assert!(w.ticket_attachments(&ticket.reference).unwrap().is_empty());
        assert!(w.attachment(&file.id).is_err());
    }
}

#[test]
fn a_metadata_refresh_already_in_flight_cannot_resurrect_a_removed_record() {
    struct RemoveDuringRead(std::path::PathBuf, String);
    impl AttachmentProvider for RemoveDuringRead {
        fn metadata(&self, id: &str, key: Option<&str>) -> Result<DriveMetadata, DriveError> {
            Workspace::open(&self.0)
                .unwrap()
                .remove_remote_attachment(&self.1)
                .unwrap();
            Selected.metadata(id, key)
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut w = Workspace::open(&path).unwrap();
    let file = w
        .reference_drive_file(&uuid::Uuid::new_v4().to_string(), "plan", None, &Selected)
        .unwrap();
    assert!(
        w.resolve_drive_reference(&file.id, &RemoveDuringRead(path, file.id.clone()))
            .is_err()
    );
    assert!(w.attachments(50, 0).unwrap().is_empty());
}

#[test]
fn removal_rechecks_current_uses_and_replays_provider_link_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut w = Workspace::open(&path).unwrap();
    let connection = uuid::Uuid::new_v4().to_string();
    let file = w
        .reference_drive_file(&connection, "plan", None, &Selected)
        .unwrap();
    assert!(
        w.attachment_cleanup_review(&file.id)
            .unwrap()
            .remove_eligible
    );
    let ticket = w.create_ticket("Keep context").unwrap();
    w.set_ticket_attachment(&ticket.reference, &file.id, true)
        .unwrap();
    assert!(w.remove_remote_attachment(&file.id).is_err());
    w.set_ticket_attachment(&ticket.reference, &file.id, false)
        .unwrap();
    let request = || WriteRequest::RemoveRemoteAttachment {
        id: file.id.clone(),
    };
    let result = w.write(Some("remove-plan"), request()).unwrap();
    let WriteResult::RemoteAttachmentRemoved(removed) = &result else {
        panic!("wrong result")
    };
    assert_eq!(
        removed.open_url,
        "https://docs.google.com/document/d/plan/edit"
    );
    assert!(removed.message.contains("remains in Drive"));
    assert!(w.attachments(50, 0).unwrap().is_empty());
    assert!(w.attachment(&file.id).is_err());
    drop(w);
    let mut w = Workspace::open(path).unwrap();
    assert_eq!(w.write(Some("remove-plan"), request()).unwrap(), result);
    let again = w
        .reference_drive_file(&connection, "plan", None, &Selected)
        .unwrap();
    assert_ne!(again.id, file.id);
    assert_eq!(w.write(Some("remove-plan"), request()).unwrap(), result);
    assert_eq!(w.attachments(50, 0).unwrap(), [again]);
}

#[test]
fn saved_draft_undo_trash_and_legacy_claims_protect_remote_records_without_detaching_other_uses() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut w = Workspace::open(&path).unwrap();
    let file = w
        .reference_drive_file(&uuid::Uuid::new_v4().to_string(), "plan", None, &Selected)
        .unwrap();
    let uri = w.attachment_uri(&file.id).unwrap();
    let body = format!("Read [authored label]({uri}).");
    let doc = w.create_document(None, &body).unwrap();
    let a = w.create_ticket("One use").unwrap();
    let b = w.create_ticket("Unrelated use").unwrap();
    w.set_ticket_attachment(&a.reference, &file.id, true)
        .unwrap();
    w.set_ticket_attachment(&b.reference, &file.id, true)
        .unwrap();
    w.set_ticket_attachment(&a.reference, &file.id, false)
        .unwrap();
    assert_eq!(
        w.ticket_attachments(&b.reference).unwrap(),
        std::slice::from_ref(&file)
    );
    assert!(w.remove_remote_attachment(&file.id).is_err());
    w.set_ticket_attachment(&b.reference, &file.id, false)
        .unwrap();
    assert!(w.remove_remote_attachment(&file.id).is_err());
    w.set_document_trashed(&doc.id, true).unwrap();
    assert!(
        w.attachment_usage(&file.id)
            .unwrap()
            .protections
            .iter()
            .any(|p| p.trashed)
    );
    assert!(w.remove_remote_attachment(&file.id).is_err());
    w.set_document_trashed(&doc.id, false).unwrap();
    w.change_document(
        &doc.id,
        ticketd_core::DocumentPatch {
            body: Some("Authored label remains in this Document".into()),
            ..Default::default()
        },
    )
    .unwrap();
    for kind in ["draft", "undo"] {
        w.retain_draft(&ticketd_core::DraftRetention {
            owner: kind.into(),
            kind: kind.into(),
            revision: 0,
            payload: None,
            markdown: vec![body.clone()],
        })
        .unwrap();
        assert!(w.remove_remote_attachment(&file.id).is_err());
        w.release_draft(kind, 1).unwrap();
    }
    // Fault fixture models the conservative cutover flag from a legacy browser profile.
    let fixture = rusqlite::Connection::open(&path).unwrap();
    fixture
        .execute("UPDATE attachment_draft_cutover SET pending=1", [])
        .unwrap();
    assert!(w.remove_remote_attachment(&file.id).is_err());
    w.complete_draft_cutover().unwrap();
    assert!(w.remove_remote_attachment(&file.id).is_ok());
    assert_eq!(
        w.show_document(&doc.id).unwrap().body,
        "Authored label remains in this Document"
    );
}

#[test]
fn failed_removal_commit_preserves_metadata_and_receipts_and_backups_restore_deliberately() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut w = Workspace::open(&path).unwrap();
    let file = w
        .reference_drive_file(&uuid::Uuid::new_v4().to_string(), "plan", None, &Selected)
        .unwrap();
    let before = dir.path().join("before.sqlite3");
    w.backup(&before).unwrap();
    let fixture = rusqlite::Connection::open(&path).unwrap();
    fixture.execute_batch("CREATE TABLE removal_fault(id TEXT REFERENCES attachments(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_removal AFTER DELETE ON attachments BEGIN INSERT INTO removal_fault VALUES(OLD.id); END;").unwrap();
    let request = || WriteRequest::RemoveRemoteAttachment {
        id: file.id.clone(),
    };
    assert!(w.write(Some("remove"), request()).is_err());
    assert_eq!(w.attachment(&file.id).unwrap(), file);
    assert_eq!(w.drive_reference(&file.id).unwrap().metadata.id, "plan");
    fixture
        .execute_batch("DROP TRIGGER fail_removal; DROP TABLE removal_fault;")
        .unwrap();
    let result = w.write(Some("remove"), request()).unwrap();
    let after = dir.path().join("after.sqlite3");
    w.backup(&after).unwrap();
    assert_eq!(
        w.inspect_backup(&after)
            .unwrap()
            .attachment_content
            .unwrap()
            .remote_references,
        0
    );
    let restored_path = dir.path().join("restored.sqlite3");
    Workspace::restore(&restored_path, &after).unwrap();
    let mut restored = Workspace::open(&restored_path).unwrap();
    assert!(restored.attachments(10, 0).unwrap().is_empty());
    assert_eq!(restored.write(Some("remove"), request()).unwrap(), result);
    drop(restored);
    Workspace::restore(&restored_path, &before).unwrap();
    assert_eq!(
        Workspace::open(restored_path)
            .unwrap()
            .attachment(&file.id)
            .unwrap(),
        file
    );
    let local = w
        .import_attachment_bytes("local", "keep.txt", b"keep", |_, _| true)
        .unwrap();
    assert!(w.remove_remote_attachment(&local.id).is_err());
    assert_eq!(w.attachment(&local.id).unwrap(), local);
}
