//! Joining is the easy path: before the person chooses Start or Join, setup only reads the
//! storage. A computer with tickets of its own, next to a Workspace already in the storage,
//! is the split moment; nothing may be written to the storage until the choice is made.
//! Google Drive and S3 run on their simulated services, never on a real account.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Setup that fails must fail the test.

use ticketd_core::Workspace;
use ticketd_core::drive::DriveRemote;
use ticketd_core::s3::S3Remote;
use ticketd_core::sync::remote::{FakeRemote, RemoteOp, RemoteStorage};
use ticketd_core::sync::{AttachmentDownload, S3Binding, SyncConnection};

#[path = "support/drive_sim.rs"]
mod drive_sim;
#[path = "support/s3_sim.rs"]
mod s3_sim;
#[path = "support/sync_desks.rs"]
mod sync_desks;

use drive_sim::{DriveSim, Vault};
use s3_sim::{BUCKET, FakeCredentials, S3Sim, target};
use sync_desks::desks;

const CONNECTION: &str = "6a0b8b0e-93a5-4d6c-9a43-0d3f5f1f2c11";
const PROBE: &str = "ticketd/.ticketd-bucket-check";

fn is_read(op: &RemoteOp) -> bool {
    matches!(op, RemoteOp::Folders | RemoteOp::List | RemoteOp::Download)
}

#[test]
fn reading_a_storage_that_holds_a_workspace_writes_nothing_even_with_tickets_here() {
    let desks = desks();
    let (_a, _, _) = desks.uploaded("Desk A");
    let folder = desks.folder();
    let before = desks.remote.stored_versions(&folder);
    let calls = desks.remote.calls().len();

    // The split moment: this computer has a ticket of its own.
    let mut b = desks.desk("Desk B");
    b.create_ticket("Made here first").unwrap();
    let options = b.sync_setup_options(&desks.remote).unwrap();

    assert_eq!((options.local.tickets, options.existing.len()), (1, 1));
    assert_eq!(options.existing[0].counts.tickets, 1);
    assert_eq!(
        options.existing[0].last_synced_by.as_deref(),
        Some("Desk A")
    );
    let reads = desks.remote.calls().split_off(calls);
    assert!(!reads.is_empty() && reads.iter().all(is_read), "{reads:?}");
    assert_eq!(desks.remote.stored_versions(&folder), before);
    // Nothing was bound either: the choice is still to be made.
    assert_eq!(
        b.sync_status().unwrap().connection,
        SyncConnection::Choosing
    );
}

#[test]
fn reading_an_empty_storage_creates_no_folder() {
    let desks = desks();
    let mut b = desks.desk("Desk B");
    b.create_ticket("Made here first").unwrap();

    let options = b.sync_setup_options(&desks.remote).unwrap();

    assert!(options.existing.is_empty());
    assert!(desks.remote.calls().iter().all(is_read));
    assert!(desks.remote.folders().unwrap().is_empty());
}

#[test]
fn a_replace_saves_this_computers_workspace_before_it_is_replaced() {
    let desks = desks();
    let (_a, _, _) = desks.uploaded("Desk A");
    let mut b = desks.desk("Desk B");
    b.set_sync_settings("Desk B", 60, AttachmentDownload::Automatic)
        .unwrap();
    b.create_ticket("Made here first").unwrap();
    let folder = b.sync_setup_options(&desks.remote).unwrap().existing[0]
        .folder_id
        .clone();

    let (joined, safety) = b.sync_download_workspace(&desks.remote, &folder).unwrap();

    let saved = Workspace::open(&safety).unwrap();
    let titles = |workspace: &Workspace| -> Vec<String> {
        workspace
            .list_tickets()
            .unwrap()
            .into_iter()
            .map(|ticket| ticket.title)
            .collect()
    };
    assert_eq!(titles(&saved), ["Made here first"]);
    assert!(!titles(&joined).contains(&"Made here first".to_owned()));
}

fn drive_remote(sim: &DriveSim) -> DriveRemote<'_> {
    DriveRemote::new(CONNECTION, &Vault, sim).with_pause(|_| panic!("this scenario must not wait"))
}

fn drive_desk(name: &str) -> (tempfile::TempDir, Workspace) {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(directory.path().join(name)).unwrap();
    workspace
        .set_sync_settings(name, 60, AttachmentDownload::Automatic)
        .unwrap();
    workspace
        .sync_connect(CONNECTION, "person@example.com")
        .unwrap();
    (directory, workspace)
}

/// What changed the storage: anything but a read, leaving out the sign-in's own token refresh.
fn writes(requests: &[(String, String)]) -> Vec<&(String, String)> {
    requests
        .iter()
        .filter(|(method, url)| method != "GET" && !url.contains("oauth2.googleapis.com"))
        .collect()
}

#[test]
fn google_drive_is_only_read_before_the_choice() {
    let sim = DriveSim::default();
    let remote = drive_remote(&sim);
    let (_a_dir, mut a) = drive_desk("Desk A");
    a.create_ticket("From the first computer").unwrap();
    a.sync_upload_workspace(&remote, "ticketd Home").unwrap();
    a.sync_now(&remote).unwrap();

    let (_b_dir, mut b) = drive_desk("Desk B");
    b.create_ticket("Made here first").unwrap();
    let items = sim.items();
    let seen = sim.requests().len();

    let options = b.sync_setup_options(&remote).unwrap();

    assert_eq!((options.local.tickets, options.existing.len()), (1, 1));
    assert_eq!(options.existing[0].counts.tickets, 1);
    let requests = sim.requests().split_off(seen);
    assert!(!requests.is_empty());
    assert_eq!(writes(&requests), Vec::<&(String, String)>::new());
    assert_eq!(sim.items(), items);
}

#[test]
fn google_drive_with_no_workspace_gets_no_folder_from_the_reading() {
    let sim = DriveSim::default();
    let remote = drive_remote(&sim);
    let (_dir, mut desk) = drive_desk("Desk B");
    desk.create_ticket("Made here first").unwrap();

    let options = desk.sync_setup_options(&remote).unwrap();

    assert!(options.existing.is_empty());
    assert_eq!(writes(&sim.requests()), Vec::<&(String, String)>::new());
    assert!(sim.items().is_empty());
}

fn s3_desk() -> (tempfile::TempDir, Workspace) {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(directory.path().join("workspace.sqlite3")).unwrap();
    workspace
        .sync_connect_s3(
            &S3Binding {
                bucket: BUCKET.into(),
                prefix: "ticketd/".into(),
                profile: "work".into(),
                aws_cli_path: None,
                endpoint: Some(String::new()),
            },
            "arn:aws:iam::123456789012:user/me",
        )
        .unwrap();
    (directory, workspace)
}

fn s3_remote<'a>(sim: &'a S3Sim, credentials: &'a FakeCredentials) -> S3Remote<'a> {
    S3Remote::new(target(), "ticketd/", credentials, sim)
        .unwrap()
        .with_pause(|_| {})
}

#[test]
fn s3_is_only_read_before_the_choice_apart_from_its_check_object() {
    let sim = S3Sim::default();
    let credentials = FakeCredentials::default();
    let (_a_dir, mut a) = s3_desk();
    a.create_ticket("From the first computer").unwrap();
    a.sync_upload_workspace(&s3_remote(&sim, &credentials), "Home")
        .unwrap();
    a.sync_now(&s3_remote(&sim, &credentials)).unwrap();

    let (_b_dir, mut b) = s3_desk();
    b.create_ticket("Made here first").unwrap();
    let keys = sim.keys();
    let versions: Vec<_> = keys.iter().map(|key| sim.versions(key)).collect();
    let seen = sim.requests().len();

    let options = b
        .sync_setup_options(&s3_remote(&sim, &credentials))
        .unwrap();

    assert_eq!((options.local.tickets, options.existing.len()), (1, 1));
    assert_eq!(sim.keys(), keys);
    assert_eq!(
        keys.iter().map(|key| sim.versions(key)).collect::<Vec<_>>(),
        versions
    );
    let requests = sim.requests().split_off(seen);
    assert!(!requests.is_empty());
    // The bucket check asks the check object again; no other object is touched.
    assert!(
        requests
            .iter()
            .filter(|(method, _)| !matches!(method.as_str(), "GET" | "HEAD"))
            .all(|(_, url)| url.ends_with(".ticketd-bucket-check")),
        "{requests:?}"
    );
}

#[test]
fn an_empty_bucket_is_left_with_only_the_check_object_by_the_reading() {
    let sim = S3Sim::default();
    let credentials = FakeCredentials::default();
    let (_dir, mut desk) = s3_desk();
    desk.create_ticket("Made here first").unwrap();

    let options = desk
        .sync_setup_options(&s3_remote(&sim, &credentials))
        .unwrap();

    assert!(options.existing.is_empty());
    // The check's own object is never a Workspace file; no Workspace folder was made.
    assert_eq!(sim.keys(), [PROBE]);
}
