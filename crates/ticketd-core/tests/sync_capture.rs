use std::collections::BTreeSet;

use ticketd_core::{
    Error, TicketPatch, Workspace, WriteRequest,
    sync::{DirtyRecord, RecordKind},
};

#[allow(clippy::unwrap_used)] // A Workspace that cannot open fails the test during setup.
fn open(dir: &tempfile::TempDir) -> Workspace {
    Workspace::open(dir.path().join("capture.sqlite3")).unwrap()
}

/// Clear every mark and return which records were dirty.
#[allow(clippy::unwrap_used)] // test helper
fn take(workspace: &mut Workspace) -> BTreeSet<(RecordKind, String)> {
    let records = workspace.dirty_records().unwrap();
    for record in &records {
        assert!(workspace.clear_dirty(record).unwrap());
    }
    records
        .into_iter()
        .map(|record| (record.kind, record.id))
        .collect()
}

fn title(text: &str) -> TicketPatch {
    TicketPatch {
        title: Some(text.into()),
        ..Default::default()
    }
}

#[test]
fn a_write_to_synced_content_marks_the_record_that_owns_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = open(&dir);
    assert_eq!(workspace.dirty_records().unwrap(), []);

    let ticket = workspace.create_ticket("First").unwrap();
    let other = workspace.create_ticket("Second").unwrap();
    let both = BTreeSet::from([
        (RecordKind::Ticket, ticket.id.clone()),
        (RecordKind::Ticket, other.id.clone()),
    ]);
    assert_eq!(take(&mut workspace), both);
    assert_eq!(workspace.dirty_records().unwrap(), []);

    let owner = (RecordKind::Ticket, ticket.id.clone());
    let reference = ticket.reference.as_str();

    workspace
        .change_ticket(reference, title("Renamed"))
        .unwrap();
    assert_eq!(take(&mut workspace), BTreeSet::from([owner.clone()]));

    workspace.add_activity(reference, "Progress", None).unwrap();
    assert_eq!(take(&mut workspace), BTreeSet::from([owner.clone()]));

    workspace.add_tag(reference, "ui").unwrap();
    assert_eq!(take(&mut workspace), BTreeSet::from([owner.clone()]));
    workspace.remove_tag(reference, "ui").unwrap();
    assert_eq!(take(&mut workspace), BTreeSet::from([owner.clone()]));

    workspace.set_following(reference, true).unwrap();
    assert_eq!(take(&mut workspace), BTreeSet::from([owner.clone()]));

    workspace
        .set_reminder(reference, Some("2099-01-01T00:00:00Z"))
        .unwrap();
    assert_eq!(take(&mut workspace), BTreeSet::from([owner.clone()]));

    // A relationship belongs to one ticket: the blocked one, and the child.
    workspace
        .add_dependency(&other.reference, reference, None)
        .unwrap();
    assert!(take(&mut workspace).contains(&owner));
    workspace
        .set_parent(reference, Some(&other.reference), None)
        .unwrap();
    assert!(take(&mut workspace).contains(&owner));

    let document = workspace.create_document(Some("Doc"), "Body").unwrap();
    let document_owner = (RecordKind::Document, document.id.clone());
    assert_eq!(
        take(&mut workspace),
        BTreeSet::from([document_owner.clone()])
    );
    workspace
        .set_document_tag(&document.id, "spec", true)
        .unwrap();
    assert_eq!(
        take(&mut workspace),
        BTreeSet::from([document_owner.clone()])
    );
    workspace.set_document_trashed(&document.id, true).unwrap();
    assert_eq!(take(&mut workspace), BTreeSet::from([document_owner]));

    let plan = workspace.create_plan("Plan").unwrap();
    let plan_owner = (RecordKind::Plan, plan.id.clone());
    assert_eq!(take(&mut workspace), BTreeSet::from([plan_owner.clone()]));
    workspace.set_plan_purpose(&plan.id, "Why").unwrap();
    assert_eq!(take(&mut workspace), BTreeSet::from([plan_owner]));

    let project = workspace
        .create_project("Project", dir.path().to_str().unwrap())
        .unwrap();
    assert_eq!(
        take(&mut workspace),
        BTreeSet::from([(RecordKind::Project, project.id)])
    );
}

#[test]
fn device_local_writes_and_reads_leave_no_mark() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = open(&dir);
    let ticket = workspace.create_ticket("First").unwrap();
    let document = workspace.create_document(Some("Doc"), "Body").unwrap();
    let project = workspace
        .create_project("Project", dir.path().to_str().unwrap())
        .unwrap();
    take(&mut workspace);

    workspace
        .register_checkout(&project.id, dir.path().to_str().unwrap())
        .unwrap();
    workspace.open_document(&document.id).unwrap();
    workspace.show_ticket(&ticket.reference).unwrap();
    workspace.find_tickets(&Default::default()).unwrap();
    workspace.change_token().unwrap();
    let inbox: Vec<i64> = workspace
        .inbox(50, 0)
        .unwrap()
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    workspace.set_inbox_read(&inbox, true).unwrap();

    assert_eq!(workspace.dirty_records().unwrap(), []);
}

#[test]
fn a_mark_is_cleared_only_if_the_record_did_not_change_again() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = open(&dir);
    let ticket = workspace.create_ticket("First").unwrap();
    let read = workspace.dirty_records().unwrap();
    assert_eq!(read.len(), 1);

    // An edit lands while the version read above is being uploaded.
    workspace
        .change_ticket(&ticket.reference, title("Edited during upload"))
        .unwrap();

    assert!(!workspace.clear_dirty(&read[0]).unwrap());
    let still: Vec<DirtyRecord> = workspace.dirty_records().unwrap();
    assert_eq!(still.len(), 1);
    assert_eq!(still[0].id, ticket.id);
    assert!(workspace.clear_dirty(&still[0]).unwrap());
    assert_eq!(workspace.dirty_records().unwrap(), []);

    // A stale read never clears a later mark, even after the record was cleared in between.
    workspace
        .change_ticket(&ticket.reference, title("Edited again"))
        .unwrap();
    assert!(!workspace.clear_dirty(&read[0]).unwrap());
    assert!(!workspace.clear_dirty(&still[0]).unwrap());
    assert_eq!(workspace.dirty_records().unwrap().len(), 1);
}

#[test]
fn records_are_listed_oldest_change_first() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = open(&dir);
    let first = workspace.create_ticket("First").unwrap();
    let second = workspace.create_ticket("Second").unwrap();
    workspace
        .change_ticket(&first.reference, title("First again"))
        .unwrap();

    let ids: Vec<String> = workspace
        .dirty_records()
        .unwrap()
        .into_iter()
        .map(|record| record.id)
        .collect();
    assert_eq!(ids, [second.id, first.id]);
}

#[test]
fn a_write_from_another_process_is_captured() {
    let dir = tempfile::tempdir().unwrap();
    let mut desktop = open(&dir);
    // The CLI is a separate handle on the same file, writing through the request path.
    let mut cli = open(&dir);
    cli.write(
        Some("request-1"),
        WriteRequest::CreateDocument {
            title: Some("From the CLI".into()),
            summary: None,
            body: "Body".into(),
        },
    )
    .unwrap();
    let ticket = cli.create_ticket("From the CLI").unwrap();
    drop(cli);

    let dirty = take(&mut desktop);
    assert_eq!(dirty.len(), 2);
    assert!(dirty.contains(&(RecordKind::Ticket, ticket.id)));
    assert!(dirty.iter().any(|(kind, _)| *kind == RecordKind::Document));
}

#[test]
fn writes_made_while_applying_incoming_files_leave_no_mark() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = open(&dir);
    let existing = workspace.create_ticket("Existing").unwrap();
    take(&mut workspace);

    let incoming = workspace
        .applying_incoming(None, |workspace| {
            let ticket = workspace.create_ticket("Incoming")?;
            workspace.add_tag(&ticket.reference, "synced")?;
            workspace.add_activity(&existing.reference, "From another device", None)?;
            workspace.create_document(Some("Incoming"), "Body")?;
            Ok(ticket)
        })
        .unwrap();

    assert_eq!(
        workspace.show_ticket(&incoming.reference).unwrap().tags,
        ["synced"]
    );
    assert_eq!(workspace.dirty_records().unwrap(), []);

    // Capture is back on afterwards.
    workspace.add_tag(&incoming.reference, "local").unwrap();
    assert_eq!(
        take(&mut workspace),
        BTreeSet::from([(RecordKind::Ticket, incoming.id)])
    );
}

#[test]
fn a_failed_apply_changes_nothing_and_leaves_capture_on() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = open(&dir);
    let existing = workspace.create_ticket("Existing").unwrap();
    take(&mut workspace);

    let failed: Result<(), Error> = workspace.applying_incoming(None, |workspace| {
        workspace.change_ticket(&existing.reference, title("Half applied"))?;
        workspace.show_ticket("T-ZZ999")?;
        Ok(())
    });

    assert!(failed.is_err());
    assert_eq!(
        workspace.show_ticket(&existing.reference).unwrap().title,
        "Existing"
    );
    assert_eq!(workspace.dirty_records().unwrap(), []);
    workspace
        .change_ticket(&existing.reference, title("Local edit"))
        .unwrap();
    assert_eq!(
        take(&mut workspace),
        BTreeSet::from([(RecordKind::Ticket, existing.id)])
    );
}

#[test]
fn saving_a_ticket_unchanged_does_not_mark_it_for_upload() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = open(&dir);
    let ticket = workspace.create_ticket("Same").unwrap();
    take(&mut workspace);

    // An editor saving what it loaded writes the title, body and status again.
    workspace
        .change_ticket(
            &ticket.reference,
            TicketPatch {
                title: Some(ticket.title.clone()),
                body: Some(ticket.body.clone()),
                status: Some(ticket.status),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(take(&mut workspace), BTreeSet::new());

    workspace
        .change_ticket(&ticket.reference, title("Different"))
        .unwrap();
    assert_eq!(
        take(&mut workspace),
        BTreeSet::from([(RecordKind::Ticket, ticket.id)])
    );
}
