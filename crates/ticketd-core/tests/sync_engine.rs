//! Sync runs of three temporary Workspaces against one fake storage account,
//! through the shared-core interface.
#![allow(clippy::unwrap_used)] // Setup and sync runs that fail must fail the test.

use std::io::Cursor;

use ticketd_core::{
    ActivityFeedEntry, Error, RecordKind, Status, SyncKind, SyncValue, TicketPatch, Workspace,
    sync::{
        SyncChoice, SyncNoticeKind, SyncResolution,
        remote::{FakeRemote, RemoteError, RemoteKey, RemoteKind, RemoteOp, RemoteStorage},
    },
};

const FOLDER: &str = "workspace";
const NAMES: [&str; 3] = ["Desk A", "Desk B", "Desk C"];

struct Devices {
    _directory: tempfile::TempDir,
    remote: FakeRemote,
    workspaces: Vec<Workspace>,
}

/// Three Workspaces with their own device codes, sharing one storage folder.
fn devices() -> Devices {
    let directory = tempfile::tempdir().unwrap();
    let remote = FakeRemote::new();
    remote.ensure_folder(FOLDER, "Test").unwrap();
    let mut workspaces: Vec<Workspace> = Vec::new();
    for name in ["a", "b", "c"] {
        let mut workspace = Workspace::open(directory.path().join(name)).unwrap();
        while workspaces
            .iter()
            .any(|other| other.device_code().unwrap() == workspace.device_code().unwrap())
        {
            workspace.renew_device_code().unwrap();
        }
        workspaces.push(workspace);
    }
    Devices {
        _directory: directory,
        remote,
        workspaces,
    }
}

impl Devices {
    fn sync(&mut self, device: usize) -> ticketd_core::sync::SyncReport {
        self.workspaces[device]
            .sync(&self.remote, FOLDER, NAMES[device])
            .unwrap()
    }

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
                NAMES[device]
            );
            let report = self.sync(device);
            assert_eq!(
                (report.uploaded, report.pending),
                (0, 0),
                "{}",
                NAMES[device]
            );
            assert_eq!(
                files(&self.workspaces[device]),
                expected,
                "{}",
                NAMES[device]
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
            .list(FOLDER)
            .unwrap()
            .into_iter()
            .find(|file| file.key == key)
            .unwrap();
        let mut bytes = Vec::new();
        self.remote
            .download(FOLDER, &key, &file.version, &mut bytes)
            .unwrap();
        (file.name, String::from_utf8(bytes).unwrap())
    }

    /// Put a file into the storage the way a person editing it there would.
    fn hand_edit(&self, kind: RemoteKind, id: &str, text: &str) {
        let key = RemoteKey::new(kind, id);
        let version = self
            .remote
            .list(FOLDER)
            .unwrap()
            .into_iter()
            .find(|file| file.key == key)
            .map(|file| file.version);
        self.remote
            .write(
                FOLDER,
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

const ORDERS: [[usize; 3]; 3] = [[0, 1, 2], [2, 1, 0], [1, 2, 0]];

#[test]
fn records_made_on_one_device_arrive_on_the_others_and_are_not_uploaded_again() {
    let mut devices = devices();
    let a = &mut devices.workspaces[0];
    a.create_project("Project", "C:/work/project").unwrap();
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
        assert_eq!(
            (report.downloaded, report.uploaded, report.pending),
            (5, 0, 0)
        );
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
    devices.workspaces[1]
        .resolve_sync_conflict(
            SyncKind::Ticket,
            &id,
            &[SyncResolution {
                field: "title".into(),
                choice: SyncChoice::Remote,
            }],
        )
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
            &[SyncResolution {
                field: "title".into(),
                choice: SyncChoice::Local
            }]
        ),
        Err(Error::NotFound(_))
    ));

    a.resolve_sync_conflict(
        SyncKind::Document,
        &document.id,
        &[SyncResolution {
            field: "body".into(),
            choice: SyncChoice::Edited("Both texts".into()),
        }],
    )
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
        // The devices that met the loop say which dependency went, once.
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
            assert!(notices.len() <= 1);
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
        assert!(noticed >= 1);
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
    // A device that held the loop says so in the Activity of both tickets.
    let mut recorded = 0;
    for workspace in &devices.workspaces {
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
                assert!(feed.iter().any(|entry| matches!(entry, ActivityFeedEntry::Automatic { event, .. } if event.kind == "sync_parent_removed" && &event.from_value == other && event.to_value == relation)));
                recorded += 1;
            }
        }
    }
    assert!(recorded >= 2);
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
    assert_eq!(devices.workspaces[2].sync_notices().unwrap().len(), 2);
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
    let failed = devices.workspaces[0].sync(&devices.remote, FOLDER, NAMES[0]);
    assert!(matches!(failed, Err(Error::Remote(RemoteError::Offline))));
    assert_eq!(devices.workspaces[0].dirty_records().unwrap().len(), 2);
    devices.remote.fail(
        RemoteOp::Write,
        0,
        RemoteError::RateLimited { retry_after: None },
    );
    assert!(
        devices.workspaces[0]
            .sync(&devices.remote, FOLDER, NAMES[0])
            .is_err()
    );
    let report = devices.sync(0);
    assert_eq!(report.pending, 0);
    assert_eq!(devices.remote.list(FOLDER).unwrap().len(), 2);

    // A download that fails part-way is simply run again.
    devices
        .remote
        .fail(RemoteOp::Download, 1, RemoteError::Offline);
    assert!(
        devices.workspaces[1]
            .sync(&devices.remote, FOLDER, NAMES[1])
            .is_err()
    );
    devices
        .remote
        .fail(RemoteOp::List, 0, RemoteError::Unauthorized);
    assert!(matches!(
        devices.workspaces[1].sync(&devices.remote, FOLDER, NAMES[1]),
        Err(Error::Remote(RemoteError::Unauthorized))
    ));
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
fn a_missing_or_emptied_storage_never_removes_local_content() {
    let mut devices = devices();
    let reference = devices.shared_ticket("Login");
    let id = devices.workspaces[0].show_ticket(&reference).unwrap().id;
    let before = files(&devices.workspaces[1]);

    // The file disappears from the storage: nothing is removed here, and the
    // run that notices puts it back without waiting for a local change.
    let (_, stored) = devices.remote_text(RemoteKind::Ticket, &id);
    assert!(
        devices
            .remote
            .remove_file(FOLDER, &RemoteKey::new(RemoteKind::Ticket, id.clone()))
    );
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
            .revisions(FOLDER, &RemoteKey::new(RemoteKind::Ticket, id.clone()))
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
    assert_eq!(
        devices.workspaces[0].show_ticket(&reference).unwrap().title,
        "Still here"
    );

    // The whole folder is gone: the run reports it and local content stays.
    let before = files(&devices.workspaces[2]);
    devices.remote.remove_folder(FOLDER);
    assert!(matches!(
        devices.workspaces[2].sync(&devices.remote, FOLDER, NAMES[2]),
        Err(Error::Remote(RemoteError::FolderMissing))
    ));
    assert_eq!(files(&devices.workspaces[2]), before);
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
    assert_eq!(
        name,
        format!("{} Set up  the  server.md", blocker.reference)
    );
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
    // A higher format number, and a field this version does not know.
    for (from, to) in [
        ("format: 1\n", "format: 2\n"),
        ("ref:", "mood: \"happy\"\nref:"),
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

        assert_eq!((report.uploaded, report.pending), (0, 1), "{to}");
        assert_eq!(devices.remote_text(RemoteKind::Ticket, &id).1, newer);
        let notices = devices.workspaces[1].sync_notices().unwrap();
        assert!(
            matches!(&notices[..], [notice] if matches!(notice.notice, SyncNoticeKind::UnreadableFile { .. })),
            "{notices:?}"
        );

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
    rusqlite::Connection::open(devices._directory.path().join("b"))
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

    devices.workspaces[1]
        .resolve_sync_conflict(
            SyncKind::Ticket,
            &id,
            &[SyncResolution {
                field: "parent".into(),
                choice: SyncChoice::Remote,
            }],
        )
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
