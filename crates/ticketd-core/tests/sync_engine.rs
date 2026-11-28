//! Sync runs of three temporary Workspaces against one fake storage account,
//! through the shared-core interface. The desktops are set up and run as the
//! app does: signed in, bound to a folder by an upload or a download, and run
//! only through `Workspace::sync_now`.
#![allow(clippy::unwrap_used)] // Setup and sync runs that fail must fail the test.

use std::io::Cursor;

use ticketd_core::{
    ActivityFeedEntry, Error, RecordKind, Status, SyncKind, SyncValue, TicketPatch, Workspace,
    WriteRequest,
    sync::{
        SyncChoice, SyncNoticeKind, SyncRecovery, SyncResolution, SyncState,
        remote::{RemoteCapabilities, RemoteError, RemoteKey, RemoteKind, RemoteOp, RemoteStorage},
    },
};

#[path = "support/sync_desks.rs"]
mod sync_desks;
use sync_desks::Devices;

const NAMES: [&str; 3] = ["Desk A", "Desk B", "Desk C"];

/// Three desktops, as the app runs them.
fn devices() -> Devices {
    Devices::new(&NAMES)
}

impl Devices {
    /// Sync the devices in this order, then twice more so everything has travelled.
    fn settle(&mut self, order: [usize; 3]) {
        for _ in 0..3 {
            for device in order {
                self.sync(device);
            }
        }
    }

    /// Every device holds the same files, has nothing left to upload, and a
    /// further run moves nothing.
    fn assert_converged(&mut self) {
        let expected = files(&self.workspaces[0]);
        for device in [0, 1, 2] {
            assert_eq!(
                files(&self.workspaces[device]),
                expected,
                "{}",
                self.names[device]
            );
            let report = self.sync(device);
            assert_eq!(
                (report.uploaded, report.pending),
                (0, 0),
                "{}",
                self.names[device]
            );
            assert_eq!(
                files(&self.workspaces[device]),
                expected,
                "{}",
                self.names[device]
            );
        }
    }

    /// A ticket created on the first device and synced to all three.
    fn shared_ticket(&mut self, title: &str) -> String {
        let reference = self.workspaces[0].create_ticket(title).unwrap().reference;
        self.settle([0, 1, 2]);
        reference
    }

    fn remote_text(&self, kind: RemoteKind, id: &str) -> (String, String) {
        let key = RemoteKey::new(kind, id);
        let file = self
            .remote
            .list(&self.folder)
            .unwrap()
            .into_iter()
            .find(|file| file.key == key)
            .unwrap();
        let mut bytes = Vec::new();
        self.remote
            .download(&self.folder, &key, &file.version, &mut bytes)
            .unwrap();
        (file.name, String::from_utf8(bytes).unwrap())
    }

    /// Put a file into the storage the way a person editing it there would.
    fn hand_edit(&self, kind: RemoteKind, id: &str, text: &str) {
        let key = RemoteKey::new(kind, id);
        let version = self
            .remote
            .list(&self.folder)
            .unwrap()
            .into_iter()
            .find(|file| file.key == key)
            .map(|file| file.version);
        self.remote
            .write(
                &self.folder,
                &key,
                "edited by hand.md",
                version.as_deref(),
                &mut Cursor::new(text.as_bytes()),
            )
            .unwrap();
    }
}

/// Every sync file of a Workspace, as (path, text), in a stable order.
fn files(workspace: &Workspace) -> Vec<(String, String)> {
    let mut files = Vec::new();
    for kind in SyncKind::ALL {
        for id in workspace.sync_record_ids(kind).unwrap() {
            let record = workspace.export_sync_record(kind, &id).unwrap();
            files.push((record.path(), record.to_markdown()));
        }
    }
    files
}

fn title(text: &str) -> TicketPatch {
    TicketPatch {
        title: Some(text.into()),
        ..Default::default()
    }
}

/// A choice for a field in review, made on the value that is shown now.
fn choose(
    workspace: &Workspace,
    kind: SyncKind,
    id: &str,
    field: &str,
    choice: SyncChoice,
) -> SyncResolution {
    let shown = workspace.sync_conflict(kind, id).unwrap();
    let detected_at = shown
        .fields
        .iter()
        .find(|shown| shown.field == field)
        .map(|shown| shown.detected_at.clone())
        .unwrap_or_default();
    SyncResolution {
        field: field.into(),
        choice,
        detected_at,
    }
}

const ORDERS: [[usize; 3]; 3] = [[0, 1, 2], [2, 1, 0], [1, 2, 0]];

#[test]
fn records_made_on_one_device_arrive_on_the_others_and_are_not_uploaded_again() {
    let mut devices = devices();
    let a = &mut devices.workspaces[0];
    let checkout = tempfile::tempdir().unwrap();
    a.create_project("Project", checkout.path().to_str().unwrap())
        .unwrap();
    let plan = a.create_plan("Plan").unwrap();
    let document = a.create_document(Some("Notes"), "Body").unwrap();
    let first = a.create_ticket("First").unwrap();
    let second = a.create_ticket("Second").unwrap();
    a.add_tag(&first.reference, "ui").unwrap();
    a.add_activity(&first.reference, "Started", Some("codex"))
        .unwrap();
    a.add_dependency(&second.reference, &first.reference, None)
        .unwrap();
    a.set_parent(&second.reference, Some(&first.reference), None)
        .unwrap();
    a.set_ticket_document(&first.reference, &document.id, true)
        .unwrap();
    a.set_plan_document(&plan.id, &document.id, true).unwrap();

    let uploaded = devices.sync(0);
    assert_eq!((uploaded.uploaded, uploaded.pending), (5, 0));

    let writes = |devices: &Devices| {
        devices
            .remote
            .calls()
            .into_iter()
            .filter(|op| *op == RemoteOp::Write)
            .count()
    };
    let before = writes(&devices);
    for device in [1, 2] {
        let report = devices.sync(device);
        assert_eq!((report.uploaded, report.pending), (0, 0));
        assert_eq!(files(&devices.workspaces[device]).len(), 5);
    }
    // What arrived by sync is not a local change: nothing was written back.
    assert_eq!(writes(&devices), before);
    devices.assert_converged();
    assert_eq!(writes(&devices), before);
    let b = &devices.workspaces[1];
    assert_eq!(b.show_ticket(&first.reference).unwrap().tags, ["ui"]);
    assert_eq!(b.sync_conflicts().unwrap(), []);
    assert_eq!(b.sync_notices().unwrap(), []);
}

#[test]
fn changes_to_different_fields_combine_without_review() {
    for order in ORDERS {
        let mut devices = devices();
        let reference = devices.shared_ticket("Login");
        devices.workspaces[0]
            .change_ticket(&reference, title("Fix login"))
            .unwrap();
        devices.workspaces[1]
            .change_ticket(
                &reference,
                TicketPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();
        devices.workspaces[2]
            .add_activity(&reference, "Looked at it", None)
            .unwrap();

        devices.settle(order);

        devices.assert_converged();
        for workspace in &devices.workspaces {
            let ticket = workspace.show_ticket(&reference).unwrap();
            assert_eq!(
                (ticket.title.as_str(), ticket.status),
                ("Fix login", Status::Done)
            );
            assert_eq!(
                workspace
                    .activity_feed(&reference, 10, 0)
                    .unwrap()
                    .iter()
                    .filter(|entry| matches!(entry, ActivityFeedEntry::Authored { .. }))
                    .count(),
                1
            );
            assert_eq!(workspace.sync_conflicts().unwrap(), []);
        }
    }
}

#[test]
fn sync_status_transitions_invalidate_stale_review_decisions() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Review the change");
    devices.workspaces[0]
        .set_following(&reference, true)
        .unwrap();

    let mut sync_status = |status| {
        devices.workspaces[0]
            .change_ticket(
                &reference,
                TicketPatch {
                    status: Some(status),
                    ..Default::default()
                },
            )
            .unwrap();
        devices.sync(0);
        let report = devices.sync(1);
        assert_eq!((report.uploaded, report.conflicts), (0, 0));
        let ticket = devices.workspaces[1].show_ticket(&reference).unwrap();
        assert_eq!(ticket.status, status);
        ticket.status_history_number.unwrap()
    };
    let first_review = sync_status(Status::InReview);
    let sent_back = sync_status(Status::InProgress);
    let later_review = sync_status(Status::InReview);
    assert!(first_review < sent_back && sent_back < later_review);

    let id = devices.workspaces[1].show_ticket(&reference).unwrap().id;
    let (_, text) = devices.remote_text(RemoteKind::Ticket, &id);
    let replay = text.replacen("\n---\n", "\n# Unchanged ticket fields\n---\n", 1);
    devices.hand_edit(RemoteKind::Ticket, &id, &replay);
    let report = devices.sync(1);
    assert_eq!((report.skipped, report.conflicts), (0, 0));

    let target = &mut devices.workspaces[1];
    let ticket = target.show_ticket(&reference).unwrap();
    assert_eq!(ticket.status_history_number, Some(later_review));
    assert_eq!(target.ticket_history(&reference).unwrap().len(), 3);
    assert!(target.is_following(&reference).unwrap());
    assert!(target.inbox(10, 0).unwrap().is_empty());

    for (request_id, decision) in [
        (
            "stale-send-back",
            WriteRequest::SendBack {
                reference: reference.clone(),
                brief: "Feedback on the earlier review".into(),
                expected_status_history_number: first_review,
            },
        ),
        (
            "stale-move-to-done",
            WriteRequest::ChangeTicket {
                reference: reference.clone(),
                patch: TicketPatch {
                    expected_status: Some(Status::InReview),
                    expected_status_history_number: Some(first_review),
                    status: Some(Status::Done),
                    ..Default::default()
                },
            },
        ),
    ] {
        assert!(matches!(
            target.write(Some(request_id), decision),
            Err(Error::TicketChanged(_))
        ));
    }
    assert!(target.activities(&reference, 10, 0).unwrap().is_empty());
    assert_eq!(target.show_ticket(&reference).unwrap(), ticket);
}

#[test]
fn the_same_field_changed_on_two_devices_keeps_local_and_waits_for_review() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    devices.workspaces[0]
        .change_ticket(&reference, title("From A"))
        .unwrap();
    devices.workspaces[1]
        .change_ticket(&reference, title("From B"))
        .unwrap();

    devices.remote.set_now("2026-03-04T05:06:07Z");
    devices.sync(0);
    let report = devices.sync(1);

    assert_eq!(report.conflicts, 1);
    let b = &devices.workspaces[1];
    assert_eq!(b.show_ticket(&reference).unwrap().title, "From B");
    let conflicts = b.sync_conflicts().unwrap();
    assert_eq!(conflicts.len(), 1);
    let conflict = &conflicts[0];
    assert_eq!(
        (
            conflict.kind,
            conflict.id.as_str(),
            conflict.reference.as_deref(),
            conflict.title.as_str(),
            conflict.read
        ),
        (
            SyncKind::Ticket,
            id.as_str(),
            Some(reference.as_str()),
            "From B",
            false
        )
    );
    assert_eq!(conflict.fields.len(), 1);
    let field = &conflict.fields[0];
    assert_eq!(field.field, "title");
    assert_eq!(field.base, Some(SyncValue::Text("Login".into())));
    assert_eq!(field.local, Some(SyncValue::Text("From B".into())));
    assert_eq!(field.remote, Some(SyncValue::Text("From A".into())));
    assert_eq!(field.remote_device.as_deref(), Some("Desk A"));
    assert_eq!(
        field.remote_changed_at.as_deref(),
        Some("2026-03-04T05:06:07Z")
    );
    let versions = b.versions(RecordKind::Ticket, &reference).unwrap();
    assert_eq!(
        field.local_changed_at.as_deref(),
        Some(versions[0].replaced_at.as_str())
    );

    // Every device converges on one value, and the conflict stays until someone decides.
    devices.settle([2, 0, 1]);
    devices.assert_converged();
    for workspace in &devices.workspaces {
        assert_eq!(workspace.show_ticket(&reference).unwrap().title, "From B");
    }
    assert_eq!(devices.workspaces[0].sync_conflicts().unwrap(), []);
    let waiting = devices.workspaces[1]
        .sync_conflict(SyncKind::Ticket, &id)
        .unwrap();
    assert_eq!(
        waiting.fields[0].remote,
        Some(SyncValue::Text("From A".into()))
    );

    devices.workspaces[1]
        .set_sync_read(std::slice::from_ref(&id), true)
        .unwrap();
    assert!(devices.workspaces[1].sync_conflicts().unwrap()[0].read);

    // Taking the other device's value is an ordinary edit that syncs.
    let taken = choose(
        &devices.workspaces[1],
        SyncKind::Ticket,
        &id,
        "title",
        SyncChoice::Remote,
    );
    devices.workspaces[1]
        .resolve_sync_conflict(SyncKind::Ticket, &id, &[taken])
        .unwrap();
    assert_eq!(devices.workspaces[1].sync_conflicts().unwrap(), []);
    devices.settle([1, 0, 2]);
    devices.assert_converged();
    for workspace in &devices.workspaces {
        assert_eq!(workspace.show_ticket(&reference).unwrap().title, "From A");
        assert_eq!(workspace.sync_conflicts().unwrap(), []);
    }
}

#[test]
fn a_conflicting_body_can_be_settled_with_an_edited_value() {
    let mut devices = devices();
    let document = devices.workspaces[0]
        .create_document(Some("Notes"), "Start")
        .unwrap();
    devices.settle([0, 1, 2]);
    for (device, body) in [(0, "A's text"), (1, "B's text")] {
        devices.workspaces[device]
            .change_document(
                &document.id,
                ticketd_core::DocumentPatch {
                    title: None,
                    body: Some(body.into()),
                    expected_updated_at: None,
                    ..Default::default()
                },
            )
            .unwrap();
    }
    devices.sync(1);
    devices.sync(0);
    let a = &mut devices.workspaces[0];
    assert_eq!(a.show_document(&document.id).unwrap().body, "A's text");
    assert!(matches!(
        a.resolve_sync_conflict(
            SyncKind::Document,
            &document.id,
            &[choose(
                a,
                SyncKind::Document,
                &document.id,
                "title",
                SyncChoice::Local
            )]
        ),
        Err(Error::SyncReviewChanged)
    ));

    let edited = choose(
        a,
        SyncKind::Document,
        &document.id,
        "body",
        SyncChoice::Edited("Both texts".into()),
    );
    a.resolve_sync_conflict(SyncKind::Document, &document.id, &[edited])
        .unwrap();

    devices.settle([0, 1, 2]);
    devices.assert_converged();
    for workspace in &devices.workspaces {
        assert_eq!(
            workspace.show_document(&document.id).unwrap().body,
            "Both texts"
        );
        assert_eq!(workspace.sync_conflicts().unwrap(), []);
    }
}

#[test]
fn tags_combine_additions_and_removals_from_every_device() {
    for order in ORDERS {
        let mut devices = devices();
        let reference = devices.workspaces[0]
            .create_ticket("Tagged")
            .unwrap()
            .reference;
        for tag in ["a", "b"] {
            devices.workspaces[0].add_tag(&reference, tag).unwrap();
        }
        devices.settle([0, 1, 2]);
        devices.workspaces[0].remove_tag(&reference, "a").unwrap();
        devices.workspaces[0].add_tag(&reference, "x").unwrap();
        devices.workspaces[1].remove_tag(&reference, "b").unwrap();
        devices.workspaces[1].add_tag(&reference, "y").unwrap();
        devices.workspaces[2].add_tag(&reference, "x").unwrap();

        devices.settle(order);

        devices.assert_converged();
        for workspace in &devices.workspaces {
            assert_eq!(workspace.show_ticket(&reference).unwrap().tags, ["x", "y"]);
            assert_eq!(workspace.sync_conflicts().unwrap(), []);
        }
    }
}

#[test]
fn trash_against_an_edit_elsewhere_stays_trashed_with_the_edit_kept() {
    for order in ORDERS {
        let mut devices = devices();
        let reference = devices.shared_ticket("Login");
        devices.workspaces[0]
            .set_trashed(&reference, true, None)
            .unwrap();
        devices.workspaces[1]
            .change_ticket(&reference, title("Fix login"))
            .unwrap();

        devices.settle(order);

        devices.assert_converged();
        for workspace in &devices.workspaces {
            let ticket = workspace.show_ticket(&reference).unwrap();
            assert!(ticket.trashed);
            assert_eq!(ticket.title, "Fix login");
            assert_eq!(workspace.sync_conflicts().unwrap(), []);
        }
    }
}

/// The `blocked_by` edges every ticket file of a Workspace carries, as (blocked, blocker, time).
fn dependencies(workspace: &Workspace) -> Vec<(String, String, String)> {
    let mut edges = Vec::new();
    for id in workspace.sync_record_ids(SyncKind::Ticket).unwrap() {
        let record = workspace.export_sync_record(SyncKind::Ticket, &id).unwrap();
        if let Some(SyncValue::Set(since)) = record.fields.get("blocked_since") {
            for item in since {
                let (blocker, time) = item.split_once(' ').unwrap();
                edges.push((id.clone(), blocker.to_owned(), time.to_owned()));
            }
        }
    }
    edges
}

#[test]
fn a_dependency_loop_made_on_two_devices_loses_the_same_later_edge_everywhere() {
    for order in ORDERS {
        let mut devices = devices();
        let one = devices.workspaces[0].create_ticket("One").unwrap();
        let two = devices.workspaces[0].create_ticket("Two").unwrap();
        devices.settle([0, 1, 2]);
        // Each half is fine on its own device; together they are a loop.
        devices.workspaces[0]
            .add_dependency(&two.reference, &one.reference, None)
            .unwrap();
        devices.workspaces[1]
            .add_dependency(&one.reference, &two.reference, None)
            .unwrap();
        let mut made = dependencies(&devices.workspaces[0]);
        made.extend(dependencies(&devices.workspaces[1]));
        made.sort_by(|a, b| (&a.2, &a.0, &a.1).cmp(&(&b.2, &b.0, &b.1)));
        let (kept, dropped) = (made[0].clone(), made[1].clone());

        devices.settle(order);

        devices.assert_converged();
        for workspace in &devices.workspaces {
            assert_eq!(dependencies(workspace), std::slice::from_ref(&kept));
        }
        // Every device says which dependency went, once, whether it met the
        // loop itself or received the repaired file; more runs add nothing.
        devices.settle([order[2], order[0], order[1]]);
        let reference_of = |id: &str| {
            if id == one.id {
                &one.reference
            } else {
                &two.reference
            }
        };
        let mut noticed = 0;
        for workspace in &devices.workspaces {
            let notices = workspace.sync_notices().unwrap();
            assert_eq!(notices.len(), 1, "{order:?}");
            for notice in notices {
                noticed += 1;
                let SyncNoticeKind::DependencyRemoved {
                    ticket_id,
                    reference,
                    relation,
                    other,
                    ..
                } = notice.notice
                else {
                    panic!("unexpected notice {notice:?}");
                };
                assert_eq!(
                    (ticket_id.as_str(), relation.as_str()),
                    (dropped.0.as_str(), "blocked_by")
                );
                assert_eq!(
                    (&reference, &other),
                    (reference_of(&dropped.0), reference_of(&dropped.1))
                );
                let feed = workspace.activity_feed(&reference, 20, 0).unwrap();
                assert_eq!(
                    feed.iter()
                        .filter(|entry| matches!(entry, ActivityFeedEntry::Automatic { event, .. } if event.kind == "sync_dependency_removed" && event.from_value == other && event.to_value == "blocked_by"))
                        .count(),
                    1
                );
            }
        }
        assert_eq!(noticed, 3);
    }
}

#[test]
fn a_parent_loop_made_on_two_devices_is_broken_the_same_way_everywhere() {
    for order in ORDERS {
        parent_loop_is_broken_the_same_way_everywhere(order);
    }
}

fn parent_loop_is_broken_the_same_way_everywhere(order: [usize; 3]) {
    let mut devices = devices();
    let one = devices.workspaces[0].create_ticket("One").unwrap();
    let two = devices.workspaces[0].create_ticket("Two").unwrap();
    devices.settle([0, 1, 2]);
    devices.workspaces[0]
        .set_parent(&one.reference, Some(&two.reference), None)
        .unwrap();
    devices.workspaces[1]
        .set_parent(&two.reference, Some(&one.reference), None)
        .unwrap();

    devices.settle(order);

    devices.assert_converged();
    let parents: Vec<String> = files(&devices.workspaces[2])
        .into_iter()
        .flat_map(|(_, text)| {
            text.lines()
                .filter(|line| line.starts_with("parent:"))
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(parents.len(), 1);
    // Every device says so once, in the Activity of both tickets.
    devices.settle([order[2], order[0], order[1]]);
    let mut recorded = 0;
    for workspace in &devices.workspaces {
        assert_eq!(workspace.sync_notices().unwrap().len(), 1, "{order:?}");
        for notice in workspace.sync_notices().unwrap() {
            let SyncNoticeKind::ParentRemoved {
                reference, other, ..
            } = notice.notice
            else {
                unreachable!("unexpected notice {notice:?}");
            };
            for (ticket, other, relation) in [
                (&reference, &other, "parent"),
                (&other, &reference, "child"),
            ] {
                let feed = workspace.activity_feed(ticket, 20, 0).unwrap();
                assert_eq!(feed.iter().filter(|entry| matches!(entry, ActivityFeedEntry::Automatic { event, .. } if event.kind == "sync_parent_removed" && &event.from_value == other && event.to_value == relation)).count(), 1);
                recorded += 1;
            }
        }
    }
    assert_eq!(recorded, 6);
}

/// F52: the parent links are cleared and made again on purpose, on two devices
/// as before, so the same link is removed a second time. That is a new
/// removal: every device says so again, once.
#[test]
fn a_parent_loop_made_again_on_purpose_is_reported_again() {
    let mut devices = devices();
    let one = devices.workspaces[0].create_ticket("One").unwrap();
    let two = devices.workspaces[0].create_ticket("Two").unwrap();
    devices.settle([0, 1, 2]);
    for removals in [1, 2] {
        devices.workspaces[0]
            .set_parent(&one.reference, Some(&two.reference), None)
            .unwrap();
        devices.workspaces[1]
            .set_parent(&two.reference, Some(&one.reference), None)
            .unwrap();
        devices.settle([0, 1, 2]);
        // Further runs add nothing.
        devices.settle([2, 0, 1]);
        devices.assert_converged();
        for workspace in &devices.workspaces {
            let notices = workspace.sync_notices().unwrap();
            assert_eq!(notices.len(), removals);
            let SyncNoticeKind::ParentRemoved { reference, .. } = &notices[0].notice else {
                unreachable!("unexpected notice {:?}", notices[0]);
            };
            let feed = workspace.activity_feed(reference, 50, 0).unwrap();
            assert_eq!(
                feed.iter()
                    .filter(|entry| matches!(entry, ActivityFeedEntry::Automatic { event, .. } if event.kind == "sync_parent_removed"))
                    .count(),
                removals
            );
        }
        for reference in [&one.reference, &two.reference] {
            devices.workspaces[0]
                .set_parent(reference, None, None)
                .unwrap();
        }
        devices.settle([0, 1, 2]);
    }
}

#[test]
fn an_upload_that_replaced_an_unseen_change_from_another_device_merges_it_back() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    // The other device's upload: the same file with one more tag.
    let (_, synced) = devices.remote_text(RemoteKind::Ticket, &id);
    let theirs = synced.replacen("trashed: false\n", "tags: [urgent]\ntrashed: false\n", 1);
    assert_ne!(theirs, synced);
    devices.remote.write_unseen_before_next_update(
        &RemoteKey::new(RemoteKind::Ticket, id.clone()),
        theirs.as_bytes(),
    );
    devices.workspaces[0]
        .change_ticket(&reference, title("Sign in"))
        .unwrap();

    // The storage accepts the update although the tag landed first.
    assert_eq!(devices.sync(0).uploaded, 1);
    devices.settle([0, 1, 2]);

    devices.assert_converged();
    for workspace in &devices.workspaces {
        let ticket = workspace.show_ticket(&reference).unwrap();
        assert_eq!(ticket.title, "Sign in");
        assert_eq!(ticket.tags, ["urgent"]);
        assert_eq!(workspace.sync_conflicts().unwrap(), []);
    }
}

#[test]
fn an_update_reads_revisions_only_when_the_storage_can_let_a_write_slip_in() {
    for (conditional, revisions_reads) in [(false, 1), (true, 0)] {
        let mut devices = devices();
        let reference = devices.shared_ticket("Login");
        devices.remote.set_capabilities(RemoteCapabilities {
            conditional_writes: conditional,
            keeps_revisions: true,
        });
        let before = devices.remote.calls().len();
        devices.workspaces[0]
            .change_ticket(&reference, title("Sign in"))
            .unwrap();

        assert_eq!(devices.sync(0).uploaded, 1);

        let reads = devices.remote.calls()[before..]
            .iter()
            .filter(|op| **op == RemoteOp::Revisions)
            .count();
        assert_eq!(reads, revisions_reads, "conditional_writes: {conditional}");
    }
}

#[test]
fn a_valid_file_edited_in_the_storage_is_taken_as_an_edit_from_another_device() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    let ticket = devices.workspaces[0].show_ticket(&reference).unwrap();
    devices.workspaces[1].add_tag(&reference, "local").unwrap();
    devices.hand_edit(
        RemoteKind::Ticket,
        &ticket.id,
        &format!(
            "---\nkind: ticket\nid: {}\nref: {reference}   # typed by hand\ntitle: Fix the login page\nstatus: In review\ntags: [urgent]\n---\nWritten in the storage.\n",
            ticket.id
        ),
    );

    devices.settle([1, 2, 0]);

    devices.assert_converged();
    for workspace in &devices.workspaces {
        let ticket = workspace.show_ticket(&reference).unwrap();
        assert_eq!(ticket.title, "Fix the login page");
        assert_eq!(ticket.status, Status::InReview);
        assert_eq!(ticket.body, "Written in the storage.");
        assert_eq!(ticket.tags, ["local", "urgent"]);
        assert_eq!(workspace.sync_conflicts().unwrap(), []);
        assert_eq!(workspace.sync_notices().unwrap(), []);
    }
}

#[test]
fn an_unreadable_file_is_skipped_with_one_notice_and_changes_nothing() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    let before = files(&devices.workspaces[1]);
    devices.hand_edit(RemoteKind::Ticket, &id, "---\nkind: ticket\ntitle: [oops\n");
    // A file for a record nobody has, saying it is a different record.
    devices.hand_edit(
        RemoteKind::Document,
        "7b0c8d1e-2f3a-4b5c-8d6e-9f0a1b2c3d4e",
        "---\nkind: document\nid: 00000000-0000-4000-8000-000000000000\ncreated_at: 2026-11-11T09:30:00Z\n---\n",
    );

    for device in 0..3 {
        let report = devices.sync(device);
        assert_eq!((report.skipped, report.uploaded), (2, 0));
        let again = devices.sync(device);
        assert_eq!((again.skipped, again.uploaded, again.pending), (0, 0, 0));
        let workspace = &devices.workspaces[device];
        assert_eq!(files(workspace), before);
        let notices = workspace.sync_notices().unwrap();
        assert_eq!(notices.len(), 2);
        assert!(notices.iter().all(|notice| !notice.read
            && matches!(&notice.notice, SyncNoticeKind::UnreadableFile { path, reason } if path.ends_with("edited by hand.md") && !reason.is_empty())));
        // The Ticket's notice names the Ticket it belongs to; the stray file has none.
        let mut named: Vec<_> = notices
            .iter()
            .map(|notice| notice.ticket_reference.as_deref())
            .collect();
        named.sort();
        assert_eq!(named, [None, Some(reference.as_str())]);
    }

    // The next change made in ticketd replaces the broken file for everyone.
    let notice = devices.workspaces[0].sync_notices().unwrap()[0].id.clone();
    devices.workspaces[0]
        .set_sync_read(&[notice], true)
        .unwrap();
    assert_eq!(
        devices.workspaces[0]
            .sync_notices()
            .unwrap()
            .iter()
            .filter(|notice| notice.read)
            .count(),
        1
    );
    devices.workspaces[0]
        .change_ticket(&reference, title("Fixed here"))
        .unwrap();
    devices.settle([0, 1, 2]);
    devices.assert_converged();
    assert_eq!(
        devices.workspaces[2].show_ticket(&reference).unwrap().title,
        "Fixed here"
    );
    // The notice about the replaced file is taken back where the file reads
    // again, read or not; the one about the stray file stays. The desktop
    // that replaced the file keeps a trace of it instead.
    for (device, workspace) in devices.workspaces.iter().enumerate() {
        let notices = workspace.sync_notices().unwrap();
        let unreadable: Vec<_> = notices
            .iter()
            .filter(|notice| matches!(notice.notice, SyncNoticeKind::UnreadableFile { .. }))
            .collect();
        assert!(
            matches!(&unreadable[..], [notice] if matches!(&notice.notice, SyncNoticeKind::UnreadableFile { reason, .. } if reason.contains("do not match"))),
            "{notices:?}"
        );
        let traces = usize::from(device == 0);
        assert_eq!(notices.len(), 1 + traces, "{notices:?}");
    }
}

fn downloads(devices: &Devices) -> usize {
    let calls = devices.remote.calls();
    calls.iter().filter(|op| **op == RemoteOp::Download).count()
}

/// L1: a field this version does not know is a hand edit gone wrong, not a
/// file from a newer ticketd. It is read once, and the next change here replaces it.
#[test]
fn a_file_with_an_unknown_field_or_section_is_read_once_and_replaced_by_the_next_change_here() {
    for (from, to, reason) in [
        ("ref:", "priority: high\nref:", "unknown field 'priority'"),
        ("ref:", "x_note: typo-field\nref:", "unknown field 'x_note'"),
        (
            "---\n",
            "---\n<!-- ticketd:mood -->\n",
            "unknown section marker",
        ),
    ] {
        let mut devices = devices();
        let reference = devices.shared_ticket("Login");
        let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
        let (_, synced) = devices.remote_text(RemoteKind::Ticket, &id);
        // The last match is the rule that closes the header.
        let at = synced.rfind(from).unwrap();
        let edited = format!("{}{to}{}", &synced[..at], &synced[at + from.len()..]);
        devices.hand_edit(RemoteKind::Ticket, &id, &edited);

        assert_eq!(devices.sync(1).skipped, 1, "{to}");
        let notices = devices.workspaces[1].sync_notices().unwrap();
        assert!(
            matches!(&notices[..], [notice] if matches!(&notice.notice, SyncNoticeKind::UnreadableFile { reason: told, .. } if told.contains(reason))),
            "{notices:?}"
        );
        let read = downloads(&devices);
        let idle = devices.sync(1);
        assert_eq!((idle.skipped, idle.pending), (0, 0), "{to}");
        assert_eq!(downloads(&devices), read, "{to}");

        devices.workspaces[1]
            .change_ticket(&reference, title("Changed here"))
            .unwrap();
        let report = devices.sync(1);

        assert_eq!((report.uploaded, report.pending), (1, 0), "{to}");
        let (_, replaced) = devices.remote_text(RemoteKind::Ticket, &id);
        assert!(replaced.contains("Changed here"), "{replaced}");
        // The hand edit is gone from the file, so the notice stays as a trace
        // of it: already read, and no longer a reason for Needs attention.
        let notices = devices.workspaces[1].sync_notices().unwrap();
        assert!(
            matches!(&notices[..], [notice] if notice.read && matches!(&notice.notice, SyncNoticeKind::ReplacedFile { path, reason: told } if path.starts_with("tickets/") && told.contains(reason))),
            "{notices:?}"
        );
        let state = devices.workspaces[1].sync_status().unwrap().state;
        assert_ne!(state, SyncState::NeedsAttention, "{to}");
        // The file reading again on later runs does not take the trace back.
        devices.settle([0, 1, 2]);
        assert_eq!(devices.workspaces[1].sync_notices().unwrap(), notices);
    }
}

/// L5: the notice goes when the file is corrected in the storage.
#[test]
fn the_notice_about_an_unreadable_file_is_taken_back_once_the_file_reads_again() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    let (_, synced) = devices.remote_text(RemoteKind::Ticket, &id);
    devices.hand_edit(RemoteKind::Ticket, &id, "---\nkind: ticket\ntitle: [oops\n");
    devices.sync(1);
    assert_eq!(devices.workspaces[1].sync_notices().unwrap().len(), 1);

    devices.hand_edit(RemoteKind::Ticket, &id, &synced);
    devices.sync(1);

    assert_eq!(devices.workspaces[1].sync_notices().unwrap(), []);
}

#[test]
fn an_interrupted_upload_or_download_repeats_without_duplicating_anything() {
    let mut devices = devices();
    let reference = devices.workspaces[0]
        .create_ticket("Login")
        .unwrap()
        .reference;
    devices.workspaces[0]
        .add_activity(&reference, "Started", None)
        .unwrap();
    devices.workspaces[0]
        .create_document(Some("Notes"), "Body")
        .unwrap();

    // The first write reaches the storage but its answer is lost; the second never arrives.
    devices.remote.drop_write(0, RemoteError::Offline);
    let failed = devices.try_sync(0);
    assert_eq!(failed.status.recovery, Some(SyncRecovery::Offline));
    assert_eq!(devices.workspaces[0].dirty_records().unwrap().len(), 2);
    devices.remote.fail(
        RemoteOp::Write,
        0,
        RemoteError::RateLimited { retry_after: None },
    );
    let failed = devices.try_sync(0);
    assert_eq!(failed.status.recovery, Some(SyncRecovery::RateLimited));
    let report = devices.sync(0);
    assert_eq!(report.pending, 0);
    assert_eq!(devices.versions().len(), 2);

    // A download that fails part-way is simply run again.
    devices
        .remote
        .fail(RemoteOp::Download, 1, RemoteError::Offline);
    let failed = devices.try_sync(1);
    assert_eq!(failed.status.recovery, Some(SyncRecovery::Offline));
    devices
        .remote
        .fail(RemoteOp::List, 0, RemoteError::Unauthorized);
    let failed = devices.try_sync(1);
    assert_eq!(
        failed.status.recovery,
        Some(SyncRecovery::AuthorizationExpired)
    );
    devices.settle([1, 2, 0]);

    devices.assert_converged();
    for workspace in &devices.workspaces {
        assert_eq!(
            workspace.sync_record_ids(SyncKind::Ticket).unwrap().len(),
            1
        );
        assert_eq!(
            workspace.sync_record_ids(SyncKind::Document).unwrap().len(),
            1
        );
        assert_eq!(
            workspace
                .activity_feed(&reference, 20, 0)
                .unwrap()
                .iter()
                .filter(|entry| matches!(entry, ActivityFeedEntry::Authored { .. }))
                .count(),
            1
        );
    }
}

#[test]
fn a_file_missing_among_several_is_uploaded_again_by_the_next_run_of_any_desktop_that_had_it() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    devices.workspaces[0].create_ticket("Other").unwrap();
    devices.settle([0, 1, 2]);
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    let before = files(&devices.workspaces[1]);

    // The file disappears from the storage: nothing is removed here, and the
    // run that notices puts it back without waiting for a local change.
    let (_, stored) = devices.remote_text(RemoteKind::Ticket, &id);
    assert!(devices.remote.remove_file(
        &devices.folder,
        &RemoteKey::new(RemoteKind::Ticket, id.clone())
    ));
    assert_eq!(devices.sync(1).uploaded, 1);
    assert_eq!(files(&devices.workspaces[1]), before);
    assert_eq!(
        devices.remote_text(RemoteKind::Ticket, &id).1,
        stored.replace("Desk A", "Desk B")
    );
    // A file that a listing merely left out is not written again.
    devices
        .remote
        .omit_from_next_listing(&[RemoteKey::new(RemoteKind::Ticket, id.clone())]);
    devices.sync(1);
    assert_eq!(
        devices
            .remote
            .revisions(
                &devices.folder,
                &RemoteKey::new(RemoteKind::Ticket, id.clone())
            )
            .unwrap()
            .len(),
        1
    );
    devices.workspaces[1]
        .change_ticket(&reference, title("Still here"))
        .unwrap();
    assert_eq!(devices.sync(1).uploaded, 1);
    devices.settle([0, 2, 1]);
    devices.assert_converged();
    // The other desktops meet a file made after the one they synced: it is
    // merged against the copy they kept, so a one-sided edit arrives silently.
    assert_eq!(devices.workspaces[0].sync_conflicts().unwrap(), []);
    assert_eq!(
        devices.workspaces[0].show_ticket(&reference).unwrap().title,
        "Still here"
    );
}

#[test]
fn an_emptied_or_missing_folder_is_a_recovery_state_and_never_removes_local_content() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    let before = files(&devices.workspaces[1]);

    // The only record file is gone: a listing without a record where some were
    // synced is a storage problem, not a deletion and not a reason to write.
    assert!(devices.remote.remove_file(
        &devices.folder,
        &RemoteKey::new(RemoteKind::Ticket, id.clone())
    ));
    let run = devices.try_sync(1);
    assert_eq!(run.status.recovery, Some(SyncRecovery::FolderMissing));
    assert_eq!(run.uploaded, 0);
    assert_eq!(files(&devices.workspaces[1]), before);

    // Recovering uploads this desktop's Workspace again, and the others take
    // the file in as a change made elsewhere.
    let status = devices.workspaces[1].sync_recover(&devices.remote).unwrap();
    assert_eq!(status.recovery, None);
    assert_eq!(devices.versions().len(), 1);
    devices.settle([0, 2, 1]);
    devices.assert_converged();
    assert_eq!(devices.workspaces[0].sync_conflicts().unwrap(), []);
    assert_eq!(files(&devices.workspaces[0]), before);

    // The whole folder is gone: the run reports it and local content stays.
    let before = files(&devices.workspaces[2]);
    devices.remote.remove_folder(&devices.folder);
    let run = devices.try_sync(2);
    assert_eq!(run.status.recovery, Some(SyncRecovery::FolderMissing));
    assert_eq!(files(&devices.workspaces[2]), before);
}

#[test]
fn project_archive_and_reactivation_sync_from_a_legacy_base_with_local_configuration() {
    let mut devices = Devices::new(&NAMES[..2]);
    let checkout_a = tempfile::tempdir().unwrap();
    let checkout_b = tempfile::tempdir().unwrap();
    let remote_a = "github.com/team/site";
    let remote_b = "github.example.com/team/site";
    let project = devices.workspaces[0]
        .create_project_with_remote(
            "Website",
            checkout_a.path().to_str().unwrap(),
            Some(remote_a),
        )
        .unwrap();
    let ticket = devices.workspaces[0]
        .create_ticket_in_context("Fix login", Some(&project.id), None)
        .unwrap();
    devices.sync(0);

    let legacy = format!(
        "---\nkind: project\nformat: 1\nid: \"{}\"\nname: \"Website\"\n---\n",
        project.id
    );
    devices.hand_edit(RemoteKind::Project, &project.id, &legacy);
    for index in 0..2 {
        let report = devices.sync(index);
        assert_eq!(
            (report.uploaded, report.conflicts, report.skipped),
            (0, 0, 0)
        );
        assert!(
            !devices.workspaces[index]
                .show_project(&project.id)
                .unwrap()
                .archived
        );
    }

    let imported = devices.workspaces[1].show_project(&project.id).unwrap();
    assert!(imported.paths.is_empty());
    assert!(imported.remote.is_none());
    let local_project = devices.workspaces[1]
        .edit_project_with_remote(
            &project.id,
            "Web",
            checkout_b.path().to_str().unwrap(),
            ticketd_core::ProjectRemoteChange::Set(remote_b),
        )
        .unwrap();

    // The rename and archive both travel, using the legacy Active value as their base.
    for (writer, archived) in [(0, true), (1, false)] {
        let reader = 1 - writer;
        devices.workspaces[writer]
            .set_project_archived(&project.id, archived)
            .unwrap();
        assert_eq!(devices.sync(writer).uploaded, 1);
        let report = devices.sync(reader);
        assert_eq!((report.conflicts, report.skipped), (0, 0));
        assert_eq!(report.uploaded, usize::from(archived));
        assert_eq!(devices.sync(writer).uploaded, 0);
        let (_, stored) = devices.remote_text(RemoteKind::Project, &project.id);
        assert!(stored.contains("\nformat: 4\n"));
        assert!(stored.contains(&format!("\narchived: {archived}\n")));
        assert!(!stored.contains(remote_a));
        assert!(!stored.contains(remote_b));

        for (index, original) in [(0, &project), (1, &local_project)] {
            let workspace = &devices.workspaces[index];
            let actual = workspace.show_project(&project.id).unwrap();
            assert_eq!(actual.id, project.id);
            assert_eq!(actual.archived, archived);
            assert_eq!(actual.name, "Web");
            assert_eq!(actual.paths, original.paths);
            assert_eq!(actual.remote, original.remote);
            assert_eq!(
                workspace
                    .show_ticket(&ticket.reference)
                    .unwrap()
                    .project_id
                    .as_deref(),
                Some(project.id.as_str())
            );
        }
        for index in 0..2 {
            let report = devices.sync(index);
            assert_eq!((report.uploaded, report.pending), (0, 0));
        }
    }
}

#[test]
fn different_project_archive_values_without_a_common_base_go_to_review() {
    let mut devices = Devices::new(&NAMES[..2]);
    let checkout = tempfile::tempdir().unwrap();
    let source = &mut devices.workspaces[0];
    let project = source
        .create_project("Website", checkout.path().to_str().unwrap())
        .unwrap();
    let active = source
        .export_sync_record(SyncKind::Project, &project.id)
        .unwrap();
    source.set_project_archived(&project.id, true).unwrap();
    devices.workspaces[1].apply_sync_record(&active).unwrap();
    devices.sync(0);

    assert_eq!(devices.sync(1).conflicts, 1);
    let target = &mut devices.workspaces[1];
    assert!(!target.show_project(&project.id).unwrap().archived);
    let conflict = target
        .sync_conflict(SyncKind::Project, &project.id)
        .unwrap();
    assert_eq!(conflict.fields[0].field, "archived");
    assert_eq!(conflict.fields[0].local, Some(SyncValue::Flag(false)));
    assert_eq!(conflict.fields[0].remote, Some(SyncValue::Flag(true)));
    let resolution = choose(
        target,
        SyncKind::Project,
        &project.id,
        "archived",
        SyncChoice::Remote,
    );
    target
        .resolve_sync_conflict(SyncKind::Project, &project.id, &[resolution])
        .unwrap();
    devices.sync(1);
    devices.sync(0);
    for workspace in &devices.workspaces {
        assert!(workspace.show_project(&project.id).unwrap().archived);
        assert!(workspace.sync_conflicts().unwrap().is_empty());
    }
}

#[test]
fn an_archived_project_and_its_ticket_stay_linked_in_either_arrival_order() {
    let mut devices = Devices::new(&NAMES[..2]);
    for project_first in [true, false] {
        let checkout = tempfile::tempdir().unwrap();
        let source = &mut devices.workspaces[0];
        let project = source
            .create_project("Website", checkout.path().to_str().unwrap())
            .unwrap();
        let ticket = source
            .create_ticket_in_context("Fix login", Some(&project.id), None)
            .unwrap();
        source.set_project_archived(&project.id, true).unwrap();
        devices.sync(0);

        let omitted = if project_first {
            RemoteKey::new(RemoteKind::Ticket, ticket.id.clone())
        } else {
            RemoteKey::new(RemoteKind::Project, project.id.clone())
        };
        devices.remote.omit_from_next_listing(&[omitted]);
        assert_eq!(devices.sync(1).skipped, 0);
        let target = &devices.workspaces[1];
        if project_first {
            assert!(target.show_project(&project.id).unwrap().archived);
            assert!(target.show_ticket(&ticket.reference).is_err());
        } else {
            assert!(target.show_project(&project.id).is_err());
            assert!(
                target
                    .show_ticket(&ticket.reference)
                    .unwrap()
                    .project_id
                    .is_none()
            );
        }

        let report = devices.sync(1);
        assert_eq!(
            (report.uploaded, report.conflicts, report.skipped),
            (0, 0, 0)
        );
        let target = &devices.workspaces[1];
        assert!(target.show_project(&project.id).unwrap().archived);
        let linked = target.show_ticket(&ticket.reference).unwrap();
        assert_eq!(linked.id, ticket.id);
        assert_eq!(linked.project_id.as_deref(), Some(project.id.as_str()));
    }
}

#[test]
fn a_relationship_whose_target_arrives_later_is_neither_lost_nor_undone_by_a_local_edit() {
    let mut devices = devices();
    let blocker = devices.workspaces[0].create_ticket("Blocker").unwrap();
    let blocked = devices.workspaces[0].create_ticket("Blocked").unwrap();
    devices.workspaces[0]
        .add_dependency(&blocker.reference, &blocked.reference, None)
        .unwrap();
    devices.sync(0);

    // The blocked ticket's file reaches B a run before the ticket it names.
    devices
        .remote
        .omit_from_next_listing(&[RemoteKey::new(RemoteKind::Ticket, blocker.id.clone())]);
    devices.sync(1);
    assert!(
        devices.workspaces[1]
            .show_ticket(&blocker.reference)
            .is_err()
    );
    devices.workspaces[1]
        .change_ticket(&blocked.reference, title("Blocked, renamed on B"))
        .unwrap();
    devices.sync(1);
    let (_, stored) = devices.remote_text(RemoteKind::Ticket, &blocked.id);
    assert!(stored.contains("Blocked, renamed on B"));
    assert!(
        stored.contains(&blocker.id),
        "the waiting dependency was uploaded as removed"
    );

    devices.settle([1, 0, 2]);
    devices.assert_converged();
    for workspace in &devices.workspaces {
        assert_eq!(dependencies(workspace).len(), 1);
        assert_eq!(
            workspace.show_ticket(&blocked.reference).unwrap().title,
            "Blocked, renamed on B"
        );
    }
}

#[test]
fn activities_added_on_different_devices_all_arrive_once() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    for (device, brief) in [(0, "From A"), (1, "From B"), (2, "From C")] {
        devices.workspaces[device]
            .add_activity(&reference, brief, None)
            .unwrap();
    }

    devices.settle([2, 0, 1]);
    devices.settle([0, 1, 2]);

    devices.assert_converged();
    for workspace in &devices.workspaces {
        let mut briefs: Vec<String> = workspace
            .activity_feed(&reference, 20, 0)
            .unwrap()
            .into_iter()
            .filter_map(|entry| match entry {
                ActivityFeedEntry::Authored { activity } => Some(activity.brief),
                ActivityFeedEntry::Automatic { .. } => None,
            })
            .collect();
        briefs.sort();
        assert_eq!(briefs, ["From A", "From B", "From C"]);
    }
}

#[test]
fn an_uploaded_file_is_readable_in_the_storage() {
    let mut devices = devices();
    let a = &mut devices.workspaces[0];
    let blocker = a.create_ticket("Set up: the \"server\"").unwrap();
    let blocked = a.create_ticket("Fix login").unwrap();
    a.add_dependency(&blocker.reference, &blocked.reference, None)
        .unwrap();
    a.set_parent(&blocked.reference, Some(&blocker.reference), None)
        .unwrap();
    devices.sync(0);

    let (name, text) = devices.remote_text(RemoteKind::Ticket, &blocked.id);

    assert_eq!(name, format!("{} Fix login.md", blocked.reference));
    assert!(text.starts_with("---\n# synced from: Desk A\nkind: ticket\nformat: 1\n"));
    assert!(text.contains(&format!(
        "parent: \"{}\" # {}\n",
        blocker.id, blocker.reference
    )));
    assert!(text.contains(&format!(
        "blocked_by:\n  - \"{}\" # {}\n",
        blocker.id, blocker.reference
    )));
    // The comments are for readers only: the file reads back as the record itself.
    let record = devices.workspaces[0]
        .export_sync_record(SyncKind::Ticket, &blocked.id)
        .unwrap();
    assert_eq!(ticketd_core::SyncRecord::parse(&text).unwrap(), record);
    assert_eq!(
        devices.workspaces[0].sync_file_text(&record).unwrap(),
        text.replace("# synced from: Desk A\n", "")
    );
    let (name, _) = devices.remote_text(RemoteKind::Ticket, &blocker.id);
    assert_eq!(name, format!("{} Set up the server.md", blocker.reference));
}

#[test]
fn history_names_the_desktop_an_incoming_change_was_made_on() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    devices.workspaces[0]
        .change_ticket(&reference, title("Renamed on A"))
        .unwrap();
    devices.sync(0);
    devices.sync(1);
    devices.workspaces[1]
        .change_ticket(&reference, title("Renamed on B"))
        .unwrap();

    let b = &devices.workspaces[1];
    let versions = b.versions(RecordKind::Ticket, &reference).unwrap();
    let devices_named: Vec<Option<&str>> = versions
        .iter()
        .map(|version| version.device.as_deref())
        .collect();
    assert_eq!(devices_named, [None, Some("Desk A")]);
    assert_eq!(
        b.version(versions[1].id).unwrap().device.as_deref(),
        Some("Desk A")
    );
}

#[test]
fn the_same_field_changed_on_two_devices_converges_in_every_order() {
    for order in ORDERS {
        let mut devices = devices();
        let reference = devices.shared_ticket("Login");
        devices.workspaces[0]
            .change_ticket(&reference, title("From A"))
            .unwrap();
        devices.workspaces[1]
            .change_ticket(&reference, title("From B"))
            .unwrap();

        devices.settle(order);

        devices.assert_converged();
        // One value everywhere; the device whose value it is holds the other for review.
        let kept = devices.workspaces[2].show_ticket(&reference).unwrap().title;
        let reviewing: Vec<usize> = (0..3)
            .filter(|device| {
                !devices.workspaces[*device]
                    .sync_conflicts()
                    .unwrap()
                    .is_empty()
            })
            .collect();
        assert_eq!(
            reviewing,
            [if kept == "From A" { 0 } else { 1 }],
            "{order:?} kept {kept}"
        );
    }
}

#[test]
fn a_file_from_a_newer_ticketd_is_skipped_and_never_overwritten_until_it_can_be_read() {
    // A higher format number, with or without what else this version does not know.
    for (from, to) in [
        ("format: 1\n", "format: 6\n"),
        ("format: 1\n", "format: 6\nmood: \"happy\"\n"),
        ("format: 1\n", "format: 6\n---\n<!-- ticketd:mood -->\n"),
    ] {
        let mut devices = devices();
        let reference = devices.shared_ticket("Login");
        let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
        let (_, synced) = devices.remote_text(RemoteKind::Ticket, &id);
        let newer = synced.replacen(from, to, 1);
        assert_ne!(newer, synced);
        devices.hand_edit(RemoteKind::Ticket, &id, &newer);

        assert_eq!(devices.sync(1).skipped, 1);
        devices.workspaces[1]
            .change_ticket(&reference, title("Changed here"))
            .unwrap();
        let report = devices.sync(1);

        assert_eq!(report.uploaded, 0, "{to}");
        // Held back, not on its way anywhere: the status leaves it out.
        assert_eq!(report.pending, 0, "{to}");
        assert_eq!(devices.workspaces[1].dirty_records().unwrap().len(), 1);
        assert_eq!(devices.remote_text(RemoteKind::Ticket, &id).1, newer);
        let notices = devices.workspaces[1].sync_notices().unwrap();
        assert!(
            matches!(&notices[..], [notice] if matches!(notice.notice, SyncNoticeKind::UnreadableFile { .. })),
            "{notices:?}"
        );
        // It is not read again on every run, only after the app starts again,
        // which is when this desktop may have been updated.
        let read = downloads(&devices);
        devices.sync(1);
        assert_eq!(downloads(&devices), read, "{to}");
        devices.workspaces[1] = devices.desks.launched_again(NAMES[1]);
        devices.sync(1);
        assert_eq!(downloads(&devices), read + 1, "{to}");
        assert_eq!(devices.workspaces[1].sync_notices().unwrap().len(), 1);

        // Once the file reads again, what was changed meanwhile is merged and sent.
        devices.hand_edit(RemoteKind::Ticket, &id, &synced);
        assert_eq!(devices.sync(1).uploaded, 1);
        assert!(
            devices
                .remote_text(RemoteKind::Ticket, &id)
                .1
                .contains("Changed here")
        );
    }
}

#[test]
fn a_last_synced_copy_that_cannot_be_read_is_taken_as_never_synced() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    // Desk B's stored copy of the file is damaged.
    rusqlite::Connection::open(devices.desks.directory.path().join(NAMES[1]))
        .unwrap()
        .execute(
            "UPDATE sync_files SET content = 'not a sync file' WHERE id = ?1",
            [&id],
        )
        .unwrap();
    devices.workspaces[0]
        .change_ticket(&reference, title("From A"))
        .unwrap();
    devices.sync(0);

    let report = devices.sync(1);

    // Without a copy to compare with, a differing value is not taken silently.
    assert_eq!(report.conflicts, 1);
    let b = &devices.workspaces[1];
    assert_eq!(b.show_ticket(&reference).unwrap().title, "Login");
    assert_eq!(
        b.sync_conflict(SyncKind::Ticket, &id).unwrap().fields[0].remote,
        Some(SyncValue::Text("From A".into()))
    );
}

#[test]
fn taking_the_other_value_of_a_relationship_waits_for_a_record_that_has_not_arrived() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    let theirs = devices.workspaces[0].create_ticket("Parent on A").unwrap();
    let ours = devices.workspaces[1].create_ticket("Parent on B").unwrap();
    devices.workspaces[0]
        .set_parent(&reference, Some(&theirs.reference), None)
        .unwrap();
    devices.workspaces[1]
        .set_parent(&reference, Some(&ours.reference), None)
        .unwrap();
    devices.sync(0);
    // Desk B sees the conflict a run before the ticket the other value names.
    devices
        .remote
        .omit_from_next_listing(&[RemoteKey::new(RemoteKind::Ticket, theirs.id.clone())]);
    devices.sync(1);

    let taken = choose(
        &devices.workspaces[1],
        SyncKind::Ticket,
        &id,
        "parent",
        SyncChoice::Remote,
    );
    devices.workspaces[1]
        .resolve_sync_conflict(SyncKind::Ticket, &id, &[taken])
        .unwrap();
    devices.settle([1, 0, 2]);

    devices.assert_converged();
    for workspace in &devices.workspaces {
        let record = workspace.export_sync_record(SyncKind::Ticket, &id).unwrap();
        assert_eq!(
            record.fields.get("parent"),
            Some(&SyncValue::Text(theirs.id.clone()))
        );
        assert_eq!(workspace.sync_conflicts().unwrap(), []);
    }
}

#[test]
fn a_hand_edit_may_name_a_ticket_by_its_reference_and_spell_a_status_loosely() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    let blocker = devices.workspaces[0].create_ticket("Blocker").unwrap();
    devices.settle([0, 1, 2]);
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    devices.hand_edit(
        RemoteKind::Ticket,
        &id,
        &format!(
            "---\nkind: ticket\nid: {id}\nref: {reference}\ntitle: Login\nstatus: in-progress\nparent: {blocker}\nblocked_by: [{blocker}, T-ZZ9]\n---\n",
            blocker = blocker.reference
        ),
    );

    devices.settle([1, 2, 0]);

    devices.assert_converged();
    for workspace in &devices.workspaces {
        assert_eq!(
            workspace.show_ticket(&reference).unwrap().status,
            Status::InProgress
        );
        let record = workspace.export_sync_record(SyncKind::Ticket, &id).unwrap();
        assert_eq!(
            record.fields.get("parent"),
            Some(&SyncValue::Text(blocker.id.clone()))
        );
        // The reference no ticket holds waits like any record that has not arrived.
        assert_eq!(
            record.fields.get("blocked_by"),
            Some(&SyncValue::Set([blocker.id.clone()].into()))
        );
        assert_eq!(workspace.sync_notices().unwrap(), []);
    }

    // What ticketd writes names tickets by GUID and statuses as it shows them.
    devices.workspaces[0]
        .change_ticket(&reference, title("Sign in"))
        .unwrap();
    devices.sync(0);
    let (_, written) = devices.remote_text(RemoteKind::Ticket, &id);
    assert!(written.contains("status: \"In progress\"\n"), "{written}");
    assert!(written.contains(&format!(
        "parent: \"{}\" # {}\n",
        blocker.id, blocker.reference
    )));
    assert!(written.contains(&format!(
        "  - \"{}\" # {}
",
        blocker.id, blocker.reference
    )));
    // Kept as written until a ticket with that reference arrives.
    assert!(
        written.contains(
            "  - \"T-ZZ9\"
"
        ),
        "{written}"
    );
}

/// F43: a field in review whose values later agree, or whose other value was
/// replaced by a later change, no longer waits with a stale value.
#[test]
fn a_conflict_is_withdrawn_when_later_changes_settle_the_field() {
    for case in [
        "remote moved on",
        "edited here to the other value",
        "conflicts again",
    ] {
        let mut devices = devices();
        let reference = devices.shared_ticket("Login");
        let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
        devices.workspaces[0]
            .change_ticket(&reference, title("From A"))
            .unwrap();
        devices.workspaces[1]
            .change_ticket(&reference, title("From B"))
            .unwrap();
        devices.sync(0);
        assert_eq!(devices.sync(1).conflicts, 1, "{case}");
        match case {
            "remote moved on" => {
                // A takes B's value silently, then changes the title again.
                devices.sync(0);
                devices.workspaces[0]
                    .change_ticket(&reference, title("Third"))
                    .unwrap();
                devices.sync(0);
                devices.sync(1);
                assert_eq!(
                    devices.workspaces[1].sync_conflicts().unwrap(),
                    [],
                    "{case}"
                );
                assert_eq!(
                    devices.workspaces[1].show_ticket(&reference).unwrap().title,
                    "Third"
                );
            }
            "edited here to the other value" => {
                devices.workspaces[1]
                    .change_ticket(&reference, title("From A"))
                    .unwrap();
                devices.sync(1);
                assert_eq!(
                    devices.workspaces[1].sync_conflicts().unwrap(),
                    [],
                    "{case}"
                );
            }
            _ => {
                // Both change the title again: one row, showing the newer other value.
                devices.sync(0);
                devices.workspaces[0]
                    .change_ticket(&reference, title("A again"))
                    .unwrap();
                devices.workspaces[1]
                    .change_ticket(&reference, title("B again"))
                    .unwrap();
                devices.sync(0);
                devices.sync(1);
                let conflict = devices.workspaces[1]
                    .sync_conflict(SyncKind::Ticket, &id)
                    .unwrap();
                assert_eq!(conflict.fields.len(), 1, "{case}");
                assert_eq!(
                    conflict.fields[0].remote,
                    Some(SyncValue::Text("A again".into()))
                );
            }
        }
        devices.settle([0, 1, 2]);
        devices.assert_converged();
    }
}

/// F51: a choice is made on the value the review showed. When the other side
/// changed that value meanwhile, or the field left review, the choice is
/// refused and nothing is applied.
#[test]
fn a_choice_made_on_a_value_that_is_no_longer_the_one_in_review_is_refused() {
    for case in ["the other value changed", "the field left review"] {
        let mut devices = devices();
        let reference = devices.shared_ticket("Login");
        let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
        devices.workspaces[0]
            .change_ticket(&reference, title("From A"))
            .unwrap();
        devices.workspaces[1]
            .change_ticket(&reference, title("From B"))
            .unwrap();
        devices.sync(0);
        devices.sync(1);
        let shown = choose(
            &devices.workspaces[1],
            SyncKind::Ticket,
            &id,
            "title",
            SyncChoice::Remote,
        );
        if case == "the other value changed" {
            devices.sync(0);
            devices.workspaces[0]
                .change_ticket(&reference, title("A again"))
                .unwrap();
            devices.workspaces[1]
                .change_ticket(&reference, title("B again"))
                .unwrap();
            devices.sync(0);
        } else {
            devices.workspaces[1]
                .change_ticket(&reference, title("From A"))
                .unwrap();
        }
        devices.sync(1);
        let before = devices.workspaces[1].show_ticket(&reference).unwrap().title;

        let refused = devices.workspaces[1].resolve_sync_conflict(
            SyncKind::Ticket,
            &id,
            std::slice::from_ref(&shown),
        );
        assert!(
            matches!(refused, Err(Error::SyncReviewChanged)),
            "{case}: {refused:?}"
        );
        assert_eq!(
            devices.workspaces[1].show_ticket(&reference).unwrap().title,
            before,
            "{case}"
        );
    }
}

fn sourced(state: &str, updated: &str) -> String {
    let closure = if state == "closed" {
        "source_closure_reason: \"completed\"\n"
    } else {
        ""
    };
    format!(
        "---\nkind: ticket\nformat: 1\nid: \"3f2c9a1e-0000-4000-8000-000000000001\"\nref: \"T-ZZ7\"\ntitle: \"Imported\"\nstatus: \"Todo\"\ntrashed: false\nfollowing: false\nsource_provider: \"github\"\nsource_external_id: \"I_42\"\nsource_locator: \"acme/site#42\"\nsource_display: \"acme/site#42 at {updated}\"\nsource_url: \"https://example.test/acme/site/issues/42\"\nsource_origin: \"imported\"\nsource_linked_at: \"2026-01-02T03:04:05.000Z\"\nsource_authority: \"external\"\nsource_authority_changed_at: \"2026-01-02T03:04:05.000Z\"\nsource_state: \"{state}\"\n{closure}source_updated_at: \"{updated}\"\n---\nFrom the tracker.\n"
    )
}

#[test]
fn a_synced_ticket_cannot_change_sites_under_the_same_legacy_issue_id() {
    let mut devices = devices();
    let id = "3f2c9a1e-0000-4000-8000-000000000001";
    let original = sourced("open", "2026-01-03T00:00:00Z").replace("I_42", "42");
    let key = RemoteKey::new(RemoteKind::Ticket, id);
    devices
        .remote
        .write(
            &devices.folder,
            &key,
            "Published.md",
            None,
            &mut Cursor::new(&original),
        )
        .unwrap();
    devices.sync(0);
    let incoming = original
        .replace("example.test", "different-enterprise.test")
        .replace("From the tracker.", "Another tracker’s description.");
    devices.hand_edit(RemoteKind::Ticket, id, &incoming);
    devices.workspaces[0]
        .change_ticket(
            "T-ZZ7",
            TicketPatch {
                status: Some(Status::InProgress),
                ..TicketPatch::default()
            },
        )
        .unwrap();

    let report = devices.sync(0);
    assert_eq!((report.skipped, report.uploaded), (1, 0));
    assert_eq!(devices.remote_text(RemoteKind::Ticket, id).1, incoming);
    let ticket = devices.workspaces[0].show_ticket("T-ZZ7").unwrap();
    assert_eq!(ticket.status, Status::InProgress);
    assert_eq!(ticket.body.trim(), "From the tracker.");
    assert_eq!(
        ticket.source.unwrap().url,
        "https://example.test/acme/site/issues/42"
    );
    let notice = devices.workspaces[0].sync_notices().unwrap().remove(0);
    assert!(
        matches!(&notice.notice, SyncNoticeKind::UnreadableFile { reason, .. }
        if reason.contains("legacy issue identifier"))
    );
    devices.workspaces[0]
        .set_sync_read(&[notice.id], true)
        .unwrap();
    assert_eq!(devices.sync(0).uploaded, 0);
    assert_eq!(devices.remote_text(RemoteKind::Ticket, id).1, incoming);
    assert_eq!(
        devices.workspaces[0].sync_status().unwrap().state,
        SyncState::NeedsAttention
    );

    devices.hand_edit(RemoteKind::Ticket, id, &original);
    assert_eq!(devices.sync(0).uploaded, 1);
    assert!(devices.workspaces[0].sync_notices().unwrap().is_empty());
    assert!(
        devices
            .remote_text(RemoteKind::Ticket, id)
            .1
            .contains("status: \"In progress\"")
    );
}

#[test]
fn a_collision_held_file_retries_when_its_source_holder_releases_the_identity() {
    let mut devices = Devices::new(&["Desk A"]);
    let holder = sourced("open", "2026-01-03T00:00:00Z");
    let holder_id = "3f2c9a1e-0000-4000-8000-000000000001";
    devices.hand_edit(RemoteKind::Ticket, holder_id, &holder);
    devices.sync(0);

    let held = devices.workspaces[0].create_ticket("Held ticket").unwrap();
    devices.sync(0);
    let incoming = holder
        .replace(holder_id, &held.id)
        .replace("T-ZZ7", &held.reference)
        .replace("example.test", "other.example.test");
    devices.hand_edit(RemoteKind::Ticket, &held.id, &incoming);
    devices.workspaces[0]
        .add_tag(&held.reference, "local-progress")
        .unwrap();
    let report = devices.sync(0);
    assert_eq!((report.skipped, report.uploaded), (1, 0));

    let seen = downloads(&devices);
    assert_eq!(devices.sync(0).uploaded, 0);
    assert_eq!(downloads(&devices), seen);
    assert_eq!(devices.workspaces[0].sync_notices().unwrap().len(), 1);

    let mut released = devices.workspaces[0]
        .export_sync_record(SyncKind::Ticket, holder_id)
        .unwrap();
    released
        .fields
        .retain(|name, _| !name.starts_with("source_"));
    devices.workspaces[0].apply_sync_record(&released).unwrap();

    let report = devices.sync(0);
    assert_eq!((report.skipped, report.uploaded), (0, 2));
    assert_eq!(downloads(&devices), seen + 1);
    assert!(devices.workspaces[0].sync_notices().unwrap().is_empty());
    let ticket = devices.workspaces[0].show_ticket(&held.reference).unwrap();
    assert_eq!(
        ticket.source.unwrap().url,
        "https://other.example.test/acme/site/issues/42"
    );
    assert_eq!(ticket.tags, ["local-progress"]);
}

#[test]
fn a_format_two_cached_base_merges_a_format_three_observation_with_local_progress() {
    let mut devices = devices();
    let id = "3f2c9a1e-0000-4000-8000-000000000001";
    let issue = |updated| {
        sourced("open", updated)
            .replace("format: 1", "format: 2")
            .replace("I_42", "@example.test:42")
    };
    let legacy = issue("2026-01-03T00:00:00Z");
    let key = RemoteKey::new(RemoteKind::Ticket, id);
    devices
        .remote
        .write(
            &devices.folder,
            &key,
            "Imported.md",
            None,
            &mut Cursor::new(&legacy),
        )
        .unwrap();
    devices.sync(0);
    devices.sync(1);
    let path = devices.desks.directory.path().join(NAMES[1]);
    rusqlite::Connection::open(path)
        .unwrap()
        .execute(
            "UPDATE sync_files SET content = ?2 WHERE kind = 'ticket' AND id = ?1",
            rusqlite::params![id, legacy],
        )
        .unwrap();
    devices.workspaces[1]
        .change_ticket(
            "T-ZZ7",
            TicketPatch {
                status: Some(Status::InProgress),
                ..TicketPatch::default()
            },
        )
        .unwrap();
    let incoming = ticketd_core::SyncRecord::parse(&issue("2026-01-04T00:00:00Z"))
        .unwrap()
        .to_markdown()
        .replace(
            "source_state_name: \"Open\"",
            "source_state_name: \"Reviewing\"",
        );
    devices.hand_edit(RemoteKind::Ticket, id, &incoming);

    assert_eq!(devices.sync(1).conflicts, 0);
    devices.sync(0);

    for index in [0, 1] {
        let ticket = devices.workspaces[index].show_ticket("T-ZZ7").unwrap();
        assert_eq!(ticket.status, ticketd_core::Status::InProgress);
        assert_eq!(
            ticket.source.unwrap().state.name.as_deref(),
            Some("Reviewing")
        );
        assert!(
            devices.workspaces[index]
                .sync_conflicts()
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn concurrent_publications_of_one_ticket_keep_one_complete_identity_on_all_devices() {
    for order in [[0, 1, 2], [1, 0, 2]] {
        let mut devices = devices();
        let reference = devices.shared_ticket("One local ticket");
        let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
        let linked = |state, updated, external, repository: &str| {
            ticketd_core::SyncRecord::parse(
                &sourced(state, updated)
                    .replace("3f2c9a1e-0000-4000-8000-000000000001", &id)
                    .replace("T-ZZ7", &reference)
                    .replace("I_42", external)
                    .replace("acme/site", repository)
                    .replace("imported", "published"),
            )
            .unwrap()
        };
        let winner = linked("open", "2026-01-03T00:00:00Z", "I_1", "acme/first");
        let mut other = linked("closed", "2026-01-04T00:00:00Z", "I_2", "acme/other");
        other
            .fields
            .insert("status".into(), SyncValue::Text("Done".into()));

        devices.workspaces[0].apply_sync_record(&winner).unwrap();
        devices.workspaces[1].apply_sync_record(&other).unwrap();
        devices.settle(order);
        devices.assert_converged();

        for workspace in &devices.workspaces {
            let record = workspace.export_sync_record(SyncKind::Ticket, &id).unwrap();
            for field in [
                "source_external_id",
                "source_partition",
                "source_locator",
                "source_display",
                "source_url",
                "source_state_category",
                "source_updated_at",
                "status",
            ] {
                assert_eq!(
                    record.fields[field], winner.fields[field],
                    "{field} {order:?}"
                );
            }
            assert!(workspace.sync_conflicts().unwrap().is_empty());
        }
    }
}

#[test]
fn legacy_numeric_github_ids_round_trip_with_their_host() {
    const ID: &str = "3f2c9a1e-0000-4000-8000-000000000001";
    for (url, id) in [
        (
            "https://example.test/acme/site/issues/42",
            "@example.test:7",
        ),
        ("", "@:7"),
        ("https://github.com/acme/site/issues/42", "7"),
    ] {
        let mut devices = devices();
        let legacy = sourced("open", "2026-01-03T00:00:00Z")
            .replace("source_external_id: \"I_42\"", "source_external_id: \"7\"")
            .replace("https://example.test/acme/site/issues/42", url);
        devices.hand_edit(RemoteKind::Ticket, ID, &legacy);
        assert_eq!(devices.sync(0).skipped, 0, "{url}");
        assert_eq!(devices.remote_text(RemoteKind::Ticket, ID).1, legacy);

        devices.workspaces[0].add_tag("T-ZZ7", "synced").unwrap();
        assert_eq!(devices.sync(0).uploaded, 1, "{url}");
        let written = devices.remote_text(RemoteKind::Ticket, ID).1;
        assert!(written.contains("\nformat: 3\n"), "{written}");
        assert!(written.contains(&format!("\nsource_external_id: \"{id}\"\n")));

        assert_eq!(devices.sync(1).skipped, 0, "{url}");
        let received = devices.workspaces[1]
            .export_sync_record(SyncKind::Ticket, ID)
            .unwrap();
        assert_eq!(
            received.fields["source_external_id"],
            SyncValue::Text(id.into())
        );
        assert_eq!(devices.sync(1).uploaded, 0, "{url}");
    }
}

#[test]
fn concurrent_github_identity_updates_keep_the_issue_and_its_observation_together() {
    const ID: &str = "3f2c9a1e-0000-4000-8000-000000000001";
    const ENTERPRISE: &str = "https://example.test/acme/site/issues/42";
    let issue = |id: &str, url: &str, state: &str, updated: &str| {
        sourced(state, updated)
            .replace("format: 1", "format: 2")
            .replace("\"I_42\"", &format!("\"{id}\""))
            .replace(ENTERPRISE, url)
    };
    let apply = |workspace: &mut Workspace, text: &str| {
        let record = ticketd_core::SyncRecord::parse(text).unwrap();
        workspace.apply_sync_record(&record).unwrap();
    };
    for (previous_id, previous_url, earlier_id, earlier_url, later_id, repository) in [
        // Two host confirmations for one unverified issue.
        (
            "@:5",
            "",
            "5",
            "https://github.com/acme/site/issues/42",
            "@example.test:5",
            "acme/site",
        ),
        // Two observations across transfers of an already-qualified issue.
        (
            "@example.test:500",
            ENTERPRISE,
            "@example.test:4",
            ENTERPRISE,
            "@example.test:9",
            "acme/moved",
        ),
    ] {
        let mut devices = devices();
        apply(
            &mut devices.workspaces[0],
            &issue(previous_id, previous_url, "open", "2026-01-03T00:00:00Z"),
        );
        devices.settle([0, 1, 2]);

        let earlier = issue(earlier_id, earlier_url, "open", "2026-01-03T00:00:00Z")
            .replace(
                "source_authority: \"external\"",
                "source_authority: \"local\"",
            )
            .replace(
                "source_authority_changed_at: \"2026-01-02T03:04:05.000Z\"",
                "source_authority_changed_at: \"2026-01-04T00:00:00.000Z\"",
            );
        apply(&mut devices.workspaces[0], &earlier);

        let later = issue(later_id, ENTERPRISE, "closed", "2026-01-05T00:00:00Z")
            .replace("acme/site", repository);
        apply(&mut devices.workspaces[1], &later);
        devices.sync(1);
        devices.sync(0);

        let written = devices.remote_text(RemoteKind::Ticket, ID).1;
        assert!(written.contains("\nformat: 3\n"), "{written}");
        assert!(
            written.contains(&format!("\nsource_external_id: \"{later_id}\"\n")),
            "{written}"
        );

        devices.settle([0, 1, 2]);
        for workspace in &devices.workspaces {
            assert_eq!(workspace.sync_conflicts().unwrap(), []);
            let source = workspace.show_ticket("T-ZZ7").unwrap().source.unwrap();
            assert_eq!(source.id, later_id);
            assert_eq!(source.url, ENTERPRISE.replace("acme/site", repository));
            assert_eq!(
                source.state.category,
                ticketd_core::source::StateCategory::Completed
            );
            assert_eq!(source.ownership, ticketd_core::source::Ownership::Local);
            assert_eq!(
                workspace.export().unwrap()["external_identities"][0]["repository"],
                format!("example.test/{repository}")
            );
        }
    }
}

/// F38: what two desktops each refreshed from the tracker is not a decision for
/// a person: the later refresh wins for the source fields as a whole.
#[test]
fn source_fields_refreshed_on_two_devices_take_the_later_refresh_without_review() {
    for order in [[0, 1, 2], [1, 0, 2]] {
        let mut devices = devices();
        let apply = |workspace: &mut Workspace, state: &str, updated: &str| {
            let record = ticketd_core::SyncRecord::parse(&sourced(state, updated)).unwrap();
            workspace.apply_sync_record(&record).unwrap();
        };
        apply(&mut devices.workspaces[0], "open", "2026-01-03T00:00:00Z");
        devices.settle([0, 1, 2]);
        apply(&mut devices.workspaces[0], "closed", "2026-01-04T00:00:00Z");
        apply(&mut devices.workspaces[1], "open", "2026-01-05T00:00:00Z");

        devices.settle(order);
        devices.assert_converged();
        for workspace in &devices.workspaces {
            assert_eq!(workspace.sync_conflicts().unwrap(), [], "{order:?}");
            let record = workspace
                .export_sync_record(SyncKind::Ticket, "3f2c9a1e-0000-4000-8000-000000000001")
                .unwrap();
            let field = |name: &str| record.fields.get(name).cloned();
            assert_eq!(
                field("source_updated_at"),
                Some(SyncValue::Text("2026-01-05T00:00:00Z".into()))
            );
            assert_eq!(
                field("source_state_category"),
                Some(SyncValue::Text("open".into()))
            );
            assert_eq!(
                field("source_state_name"),
                Some(SyncValue::Text("Open".into())),
                "{order:?}"
            );
        }
    }
}

/// F48: taking a ticket over is not part of a refresh. A refresh made on
/// another desktop before the two sync, however late, leaves the takeover in
/// place, and the takeover leaves that refresh in place.
#[test]
fn a_takeover_on_one_device_survives_a_later_refresh_on_another() {
    const ID: &str = "3f2c9a1e-0000-4000-8000-000000000001";
    for order in [[0, 1, 2], [1, 0, 2]] {
        let mut devices = devices();
        let apply = |workspace: &mut Workspace, text: String| {
            let record = ticketd_core::SyncRecord::parse(&text).unwrap();
            workspace.apply_sync_record(&record).unwrap();
        };
        let open = sourced("open", "2026-01-03T00:00:00Z");
        apply(&mut devices.workspaces[0], open.clone());
        devices.settle([0, 1, 2]);
        let taken = open
            .replace(
                "source_authority: \"external\"",
                "source_authority: \"local\"",
            )
            .replace(
                "source_authority_changed_at: \"2026-01-02T03:04:05.000Z\"",
                "source_authority_changed_at: \"2026-01-04T00:00:00.000Z\"",
            );
        apply(&mut devices.workspaces[0], taken);
        apply(
            &mut devices.workspaces[1],
            sourced("closed", "2026-01-05T00:00:00Z"),
        );

        devices.settle(order);
        devices.assert_converged();
        for workspace in &devices.workspaces {
            assert_eq!(workspace.sync_conflicts().unwrap(), [], "{order:?}");
            let record = workspace.export_sync_record(SyncKind::Ticket, ID).unwrap();
            let field = |name: &str| record.fields.get(name).cloned();
            let text = |value: &str| Some(SyncValue::Text(value.into()));
            assert_eq!(field("source_authority"), text("local"), "{order:?}");
            assert_eq!(
                field("source_authority_changed_at"),
                text("2026-01-04T00:00:00.000Z")
            );
            assert_eq!(
                field("source_state_category"),
                text("completed"),
                "{order:?}"
            );
            assert_eq!(field("source_updated_at"), text("2026-01-05T00:00:00Z"));
        }
    }
}

/// F41: a record's file is removed in the storage and written again, then the
/// first file comes back. It is another file than the one last synced, so its
/// older content must not replace newer edits without review.
/// The storage's identity of the file held for `key`.
fn stored_file(devices: &Devices, key: &RemoteKey) -> String {
    devices
        .remote
        .list(&devices.folder)
        .unwrap()
        .into_iter()
        .find(|file| file.key == *key)
        .unwrap()
        .file_id
}

#[test]
fn a_restored_older_file_for_a_record_goes_to_review_instead_of_reverting_edits() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    // A second record, so that losing the first is not an emptied folder.
    devices.shared_ticket("Other");
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    let key = RemoteKey::new(RemoteKind::Ticket, id.clone());
    let original = stored_file(&devices, &key);

    assert!(devices.remote.remove_file(&devices.folder, &key));
    devices.remote.set_now("2026-01-02T00:00:00Z");
    assert_eq!(devices.sync(0).uploaded, 1);
    assert_ne!(stored_file(&devices, &key), original);
    devices.workspaces[0]
        .change_ticket(&reference, title("Newer"))
        .unwrap();
    assert_eq!(devices.sync(0).uploaded, 1);
    assert!(devices.remote.restore_file(&devices.folder, &key));
    assert_eq!(stored_file(&devices, &key), original);

    let report = devices.sync(0);
    assert_eq!(report.conflicts, 1);
    assert_eq!(
        devices.workspaces[0].show_ticket(&reference).unwrap().title,
        "Newer"
    );
    let conflict = devices.workspaces[0]
        .sync_conflict(SyncKind::Ticket, &id)
        .unwrap();
    assert_eq!(conflict.fields.len(), 1);
    assert_eq!(conflict.fields[0].field, "title");
    assert_eq!(
        conflict.fields[0].remote,
        Some(SyncValue::Text("Login".into()))
    );
    // Repeated runs neither revert nor report it again.
    assert_eq!(devices.sync(0).conflicts, 0);
    devices.settle([1, 2, 0]);
    devices.assert_converged();
    for workspace in &devices.workspaces {
        assert_eq!(workspace.show_ticket(&reference).unwrap().title, "Newer");
    }
}

/// F50: the restored older file is unreadable at first. Skipping it must not
/// make it the file last synced, or its corrected content would later be merged
/// against the newer file's copy and revert the edit silently.
#[test]
fn a_restored_older_file_that_is_first_unreadable_still_goes_to_review_once_fixed() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    // A second record, so that losing the first is not an emptied folder.
    devices.shared_ticket("Other");
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    let key = RemoteKey::new(RemoteKind::Ticket, id.clone());
    let (_, old) = devices.remote_text(RemoteKind::Ticket, &id);

    assert!(devices.remote.remove_file(&devices.folder, &key));
    devices.remote.set_now("2026-01-02T00:00:00Z");
    devices.sync(0);
    devices.workspaces[0]
        .change_ticket(&reference, title("Newer"))
        .unwrap();
    devices.sync(0);
    assert!(devices.remote.restore_file(&devices.folder, &key));
    devices.hand_edit(RemoteKind::Ticket, &id, "---\nkind: ticket\ntitle: [oops\n");
    assert_eq!(devices.sync(0).skipped, 1);
    devices.hand_edit(RemoteKind::Ticket, &id, &format!("{old}\nRestored text.\n"));

    assert!(devices.sync(0).conflicts > 0);
    assert_eq!(
        devices.workspaces[0].show_ticket(&reference).unwrap().title,
        "Newer"
    );
}

/// F39: two desktops that track the same external source each import the same
/// issue before they sync. The ticket with the lower GUID keeps the source; the
/// other becomes a Duplicate of it, identically on every desktop.
#[test]
fn the_same_external_issue_imported_on_two_devices_converges_as_a_duplicate() {
    const KEEPER: &str = "3f2c9a1e-0000-4000-8000-000000000001";
    const OTHER: &str = "3f2c9a1e-0000-4000-8000-000000000002";
    for order in [[0, 1, 2], [1, 0, 2], [2, 1, 0]] {
        let mut devices = devices();
        let import = |workspace: &mut Workspace, id: &str, reference: &str| {
            let text = sourced("open", "2026-01-03T00:00:00Z")
                .replace(KEEPER, id)
                .replace("T-ZZ7", reference);
            let record = ticketd_core::SyncRecord::parse(&text).unwrap();
            workspace.apply_sync_record(&record).unwrap();
        };
        import(&mut devices.workspaces[0], KEEPER, "T-ZZ7");
        import(&mut devices.workspaces[1], OTHER, "T-YY8");

        for _ in 0..3 {
            for device in order {
                assert_eq!(devices.sync(device).skipped, 0, "{order:?}");
            }
        }
        devices.assert_converged();
        for workspace in &devices.workspaces {
            assert_eq!(workspace.sync_notices().unwrap(), [], "{order:?}");
            assert_eq!(workspace.sync_conflicts().unwrap(), [], "{order:?}");
            let field = |id: &str, name: &str| {
                let record = workspace.export_sync_record(SyncKind::Ticket, id).unwrap();
                record.fields.get(name).cloned()
            };
            let text = |value: &str| Some(SyncValue::Text(value.into()));
            assert_eq!(field(KEEPER, "source_external_id"), text("I_42"));
            assert_eq!(field(KEEPER, "status"), text("Todo"));
            assert_eq!(field(OTHER, "source_external_id"), None, "{order:?}");
            assert_eq!(field(OTHER, "source_provider"), None);
            assert_eq!(field(OTHER, "status"), text("Duplicate"));
            assert_eq!(field(OTHER, "duplicate_of"), text(KEEPER));
            assert_eq!(field(OTHER, "duplicate_restore"), text("Todo"));
        }
    }
}

const LOWER: &str = "3f2c9a1e-0000-4000-8000-000000000001";
const HIGHER: &str = "3f2c9a1e-0000-4000-8000-000000000002";

/// A ticket for external issue `I_42`, as a desktop holds it before any sync.
fn import_issue(workspace: &mut Workspace, id: &str, reference: &str, change: (&str, &str)) {
    let text = sourced("open", "2026-01-03T00:00:00Z")
        .replace(LOWER, id)
        .replace("T-ZZ7", reference)
        .replace(change.0, change.1);
    let record = ticketd_core::SyncRecord::parse(&text).unwrap();
    workspace.apply_sync_record(&record).unwrap();
}

fn field_of(workspace: &Workspace, id: &str, name: &str) -> Option<SyncValue> {
    let record = workspace.export_sync_record(SyncKind::Ticket, id).unwrap();
    record.fields.get(name).cloned()
}

fn text_value(value: &str) -> Option<SyncValue> {
    Some(SyncValue::Text(value.into()))
}

/// F53: the ticket that was published from this Workspace is the original, so
/// it keeps the source over a ticket another desktop imported for the same
/// issue, whichever GUID is lower.
#[test]
fn a_published_ticket_keeps_its_source_over_an_import_of_the_same_issue() {
    for order in [[0, 1, 2], [1, 0, 2], [2, 1, 0]] {
        let mut devices = devices();
        import_issue(&mut devices.workspaces[0], LOWER, "T-ZZ7", ("", ""));
        let published = (
            "source_origin: \"imported\"",
            "source_origin: \"published\"",
        );
        import_issue(&mut devices.workspaces[1], HIGHER, "T-YY8", published);

        devices.settle(order);
        devices.assert_converged();
        for workspace in &devices.workspaces {
            assert_eq!(workspace.sync_conflicts().unwrap(), [], "{order:?}");
            assert_eq!(
                field_of(workspace, HIGHER, "source_external_id"),
                text_value("I_42"),
                "{order:?}"
            );
            assert_eq!(field_of(workspace, HIGHER, "status"), text_value("Todo"));
            assert_eq!(field_of(workspace, LOWER, "source_external_id"), None);
            assert_eq!(
                field_of(workspace, LOWER, "duplicate_of"),
                text_value(HIGHER)
            );
        }
    }
}

/// F53: the ticket that keeps the source may be in Trash. It still keeps it,
/// and the other ticket becomes its Duplicate like any other.
#[test]
fn a_trashed_ticket_still_keeps_the_source_and_the_other_becomes_its_duplicate() {
    for order in [[0, 1, 2], [1, 0, 2]] {
        let mut devices = devices();
        let trashed = ("trashed: false", "trashed: true");
        import_issue(&mut devices.workspaces[0], LOWER, "T-ZZ7", trashed);
        import_issue(&mut devices.workspaces[1], HIGHER, "T-YY8", ("", ""));

        for _ in 0..3 {
            for device in order {
                assert_eq!(devices.sync(device).skipped, 0, "{order:?}");
            }
        }
        devices.assert_converged();
        for workspace in &devices.workspaces {
            assert_eq!(workspace.sync_notices().unwrap(), [], "{order:?}");
            assert_eq!(workspace.sync_conflicts().unwrap(), [], "{order:?}");
            assert_eq!(
                field_of(workspace, LOWER, "source_external_id"),
                text_value("I_42")
            );
            assert_eq!(
                field_of(workspace, LOWER, "trashed"),
                Some(SyncValue::Flag(true))
            );
            assert_eq!(
                field_of(workspace, HIGHER, "status"),
                text_value("Duplicate")
            );
            assert_eq!(
                field_of(workspace, HIGHER, "duplicate_of"),
                text_value(LOWER)
            );
        }
    }
}

/// F53: two desktops each make the same ticket a Duplicate while it has a
/// different status on each. The status to return to is settled the same way
/// on both and is nothing to ask a person about.
#[test]
fn a_duplicate_made_on_two_devices_from_different_statuses_needs_no_review() {
    let mut devices = devices();
    import_issue(&mut devices.workspaces[1], HIGHER, "T-YY8", ("", ""));
    devices.sync(1);
    devices.sync(2);
    devices.workspaces[2]
        .change_ticket(
            "T-YY8",
            TicketPatch {
                status: Some(Status::InProgress),
                ..Default::default()
            },
        )
        .unwrap();
    import_issue(&mut devices.workspaces[0], LOWER, "T-ZZ7", ("", ""));

    devices.settle([0, 1, 2]);
    devices.assert_converged();
    for workspace in &devices.workspaces {
        assert_eq!(workspace.sync_conflicts().unwrap(), []);
        assert_eq!(
            field_of(workspace, HIGHER, "status"),
            text_value("Duplicate")
        );
        assert_eq!(
            field_of(workspace, HIGHER, "duplicate_restore"),
            text_value("Todo")
        );
    }
}

/// F45: a file too large to be a record, or one whose header nests without
/// end, is skipped with the normal notice instead of being read into memory or
/// overflowing the stack.
#[test]
fn an_oversized_or_endlessly_nested_file_is_skipped_with_a_notice() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    let (_, good) = devices.remote_text(RemoteKind::Ticket, &id);
    let before = files(&devices.workspaces[1]);

    let nested = good.replace(
        "trashed: false",
        &format!("tags:\n  {}x\ntrashed: false", "- ".repeat(5000)),
    );
    devices.hand_edit(RemoteKind::Ticket, &id, &nested);
    assert_eq!(devices.sync(1).skipped, 1);
    let reason = |workspace: &Workspace| match &workspace.sync_notices().unwrap()[0].notice {
        SyncNoticeKind::UnreadableFile { reason, .. } => reason.clone(),
        other => panic!("unexpected notice {other:?}"),
    };
    assert!(
        reason(&devices.workspaces[1]).contains("nest"),
        "{}",
        reason(&devices.workspaces[1])
    );

    let huge = format!("{good}{}", "x".repeat(8 * 1024 * 1024));
    devices.hand_edit(RemoteKind::Ticket, &id, &huge);
    let calls = devices.remote.calls().len();
    assert_eq!(devices.sync(1).skipped, 1);
    assert!(!devices.remote.calls()[calls..].contains(&RemoteOp::Download));
    assert!(
        reason(&devices.workspaces[1]).contains("8 MiB"),
        "{}",
        reason(&devices.workspaces[1])
    );
    assert_eq!(files(&devices.workspaces[1]), before);
    assert_eq!(devices.sync(1).skipped, 0);
}

/// F49: a record too large for the other desktops to read is not written to
/// the storage. It stays here, waiting, with a notice that names it, until it
/// is short enough.
#[test]
fn a_record_larger_than_a_file_may_be_is_not_uploaded_and_is_reported() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    let (_, stored) = devices.remote_text(RemoteKind::Ticket, &id);
    let body = |text: String| TicketPatch {
        body: Some(text),
        ..Default::default()
    };
    devices.workspaces[0]
        .change_ticket(&reference, body("x".repeat(8 * 1024 * 1024)))
        .unwrap();

    for _ in 0..2 {
        let report = devices.sync(0);
        assert_eq!((report.uploaded, report.pending), (0, 1));
    }
    assert_eq!(devices.remote_text(RemoteKind::Ticket, &id).1, stored);
    let notices = devices.workspaces[0].sync_notices().unwrap();
    assert_eq!(notices.len(), 1);
    assert!(
        matches!(&notices[0].notice, SyncNoticeKind::OversizedRecord { path, reason } if path.contains(&reference) && reason.contains("8 MiB")),
        "{notices:?}"
    );
    let state = devices.workspaces[0].sync_status().unwrap().state;
    assert_eq!(state, SyncState::NeedsAttention);

    devices.workspaces[0]
        .change_ticket(&reference, body("Short again".into()))
        .unwrap();
    devices.settle([0, 1, 2]);
    devices.assert_converged();
    assert_eq!(devices.workspaces[0].sync_notices().unwrap(), []);
    assert_eq!(
        devices.workspaces[2].show_ticket(&reference).unwrap().body,
        "Short again"
    );
}

/// R1: a record that was too large and is put back as it last synced has
/// nothing to upload, and its notice goes all the same.
#[test]
fn the_notice_about_an_oversized_record_goes_when_the_record_is_put_back_as_synced() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    let body = |text: String| TicketPatch {
        body: Some(text),
        ..Default::default()
    };
    let synced = devices.workspaces[0].show_ticket(&reference).unwrap().body;
    devices.workspaces[0]
        .change_ticket(&reference, body("x".repeat(8 * 1024 * 1024)))
        .unwrap();
    devices.sync(0);
    assert_eq!(devices.workspaces[0].sync_notices().unwrap().len(), 1);

    devices.workspaces[0]
        .change_ticket(&reference, body(synced))
        .unwrap();
    let report = devices.sync(0);

    assert_eq!((report.uploaded, report.pending), (0, 0));
    assert_eq!(devices.workspaces[0].sync_notices().unwrap(), []);
}

#[test]
fn changes_arriving_through_sync_are_logged_as_workspace_events_by_sync() {
    use ticketd_core::{WorkspaceActor, WorkspaceEventType as Type};

    let mut devices = devices();
    let a = &mut devices.workspaces[0];
    let ticket = a.create_ticket("First").unwrap();
    let filled = TicketPatch {
        body: Some("Details".into()),
        status: Some(Status::InProgress),
        ..Default::default()
    };
    a.change_ticket(&ticket.reference, filled).unwrap();
    a.add_tag(&ticket.reference, "ui").unwrap();
    devices.sync(0);
    devices.sync(1);

    // A ticket that arrives complete is one created event, not created then updated.
    let kinds = |workspace: &Workspace, after: i64| {
        workspace
            .workspace_events_after(after, 100)
            .unwrap()
            .into_iter()
            .map(|event| {
                assert_eq!(event.ticket_id, ticket.id);
                (event.kind, event.actor, event.current)
            })
            .collect::<Vec<_>>()
    };
    let sync = WorkspaceActor::WorkspaceSync;
    assert_eq!(
        kinds(&devices.workspaces[1], 0),
        [
            (
                Type::TicketCreated,
                sync,
                Some(serde_json::json!({
                    "title": "First", "body": "Details", "status": "In progress",
                    "project_id": null, "plan_id": null,
                }))
            ),
            (
                Type::TicketTagAdded,
                sync,
                Some(serde_json::json!({"tag": "ui"}))
            ),
        ]
    );
    // Uploading logs nothing on the device that made the change.
    let head_a = devices.workspaces[0].workspace_event_head().unwrap();
    let head_b = devices.workspaces[1].workspace_event_head().unwrap();

    let a = &mut devices.workspaces[0];
    a.add_tag(&ticket.reference, "ready-for-triage").unwrap();
    let local = kinds(&devices.workspaces[0], head_a);
    devices.sync(0);
    devices.sync(1);

    assert_eq!(kinds(&devices.workspaces[0], head_a), local);
    assert_eq!(
        kinds(&devices.workspaces[1], head_b),
        [(
            Type::TicketTagAdded,
            sync,
            Some(serde_json::json!({"tag": "ready-for-triage"}))
        )]
    );
}

#[test]
fn a_tag_arriving_through_workspace_sync_starts_no_run_and_one_added_here_does() {
    use ticketd_core::{
        AutomationAgentSettings, AutomationDefinition, Step, StepAction, Trigger, WorkspaceActor,
    };

    let mut devices = devices();
    let [arriving, local] =
        ["Arriving", "Local"].map(|title| devices.workspaces[0].create_ticket(title).unwrap());
    devices.sync(0);
    devices.sync(1);
    let b = &mut devices.workspaces[1];
    let agent = b
        .create_automation_agent(AutomationAgentSettings::default())
        .unwrap();
    let automation = b
        .create_automation(AutomationDefinition {
            name: "Triage".into(),
            trigger: Some(Trigger::TagAdded {
                tag: "ready-for-triage".into(),
            }),
            conditions: Vec::new(),
            steps: vec![Step {
                id: "triage".into(),
                action: StepAction::RunAgent {
                    agent_id: Some(agent.id),
                    execution_folder: Some("/work/app".into()),
                    on_failure: None,
                },
            }],
        })
        .unwrap();
    b.set_automation_enabled(&automation.id, true).unwrap();

    // One tag is added on the other desktop and arrives; one is added here.
    devices.workspaces[0]
        .add_tag(&arriving.reference, "ready-for-triage")
        .unwrap();
    devices.sync(0);
    devices.sync(1);
    let b = &mut devices.workspaces[1];
    b.add_tag(&local.reference, "ready-for-triage").unwrap();

    b.queue_automation_runs().unwrap();
    // The other desktop made that change and reacts to it; this one reacts only to
    // its own. The arriving tag is read past, so it never starts a run later either.
    let started: Vec<_> = b
        .automation_runs(&automation.id)
        .unwrap()
        .into_iter()
        .map(|run| (run.ticket.unwrap().id, run.event.unwrap().actor))
        .collect();
    assert_eq!(started, [(local.id, WorkspaceActor::Person)]);
    assert_eq!(
        b.automation_cursor(&automation.id).unwrap(),
        Some(b.workspace_event_head().unwrap())
    );
    assert!(
        b.show_ticket(&arriving.reference)
            .unwrap()
            .tags
            .contains(&"ready-for-triage".to_owned())
    );
}
