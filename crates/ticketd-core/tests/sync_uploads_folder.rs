//! Files kept in Google Drive live in an Uploads folder inside the Workspace's sync folder.
//! Workspace sync treats that folder as the person's own files: it never reads it as
//! Workspace files, and replacing the Workspace or disconnecting never touches it.
//! Google Drive runs on its simulated service, never on a real account.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Setup that fails must fail the test.

use serde_json::{Value, json};
use ticketd_core::drive::{DriveRemote, DriveUploadDestination, GoogleDrive};
use ticketd_core::sync::AttachmentDownload;
use ticketd_core::{AttachmentUploadDestination, Workspace};

#[path = "support/drive_sim.rs"]
mod drive_sim;

use drive_sim::{DriveSim, Vault};

const CONNECTION: &str = "6a0b8b0e-93a5-4d6c-9a43-0d3f5f1f2c11";
const ACCOUNT: &str = "person@example.com";
const OTHER: &str = "7b1c9c1f-0f5e-4c2a-8d57-0a7c1f2b9d33";
const FOLDER: &str = "application/vnd.google-apps.folder";

fn remote(sim: &DriveSim) -> DriveRemote<'_> {
    DriveRemote::new(CONNECTION, &Vault, sim).with_pause(|_| panic!("this scenario must not wait"))
}

fn desk(name: &str) -> (tempfile::TempDir, Workspace) {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(directory.path().join(name)).unwrap();
    workspace
        .set_sync_settings(name, 60, AttachmentDownload::Automatic)
        .unwrap();
    workspace.sync_connect(CONNECTION, ACCOUNT).unwrap();
    (directory, workspace)
}

fn named(sim: &DriveSim, name: &str) -> Vec<Value> {
    sim.items()
        .into_iter()
        .filter(|item| item["name"] == name)
        .collect()
}

/// A Workspace uploaded and synced once from the first computer.
fn synced(sim: &DriveSim) -> (tempfile::TempDir, Workspace, String) {
    let (directory, mut a) = desk("Desk A");
    a.create_ticket("From the first computer").unwrap();
    a.sync_upload_workspace(&remote(sim), "ticketd Home")
        .unwrap();
    a.sync_now(&remote(sim)).unwrap();
    let root = named(sim, "ticketd Home")[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (directory, a, root)
}

/// What a person's own file in the Uploads folder looks like to Drive, and a file there
/// that carries the marks of a Workspace record (a copy dragged in from the sync folder).
fn add_files_to(sim: &DriveSim, uploads: &str) {
    sim.insert(
        json!({"id": "upload-1", "name": "design.png", "mimeType": "application/octet-stream",
            "parents": [uploads], "appProperties": {"ticketdUpload": "attachment-1"}}),
        b"picture",
    );
    sim.insert(
        json!({"id": "upload-2", "name": "T-KQ43 Fix login.md", "mimeType": "text/markdown",
            "parents": [uploads],
            "appProperties": {"ticketdKind": "ticket", "ticketdId": "3f2c9a1e-5b7d-4c1a-9e2f-0a1b2c3d4e5f"}}),
        b"not a record here",
    );
}

#[test]
fn uploads_go_to_a_folder_inside_the_sync_folder() {
    let sim = DriveSim::default();
    let (_dir, mut a, root) = synced(&sim);

    let destination = a.use_sync_uploads_folder(&remote(&sim)).unwrap();

    let uploads = named(&sim, "Uploads");
    assert_eq!(uploads.len(), 1);
    assert_eq!(uploads[0]["mimeType"], FOLDER);
    assert_eq!(uploads[0]["parents"], json!([root]));
    let folder_id = uploads[0]["id"].as_str().unwrap();
    let AttachmentUploadDestination::GoogleDrive {
        destination,
        folder_name,
        account,
        sync_folder,
    } = destination
    else {
        panic!("uploads go to Google Drive");
    };
    assert_eq!(destination.connection_id, CONNECTION);
    assert_eq!(destination.folder_id, folder_id);
    assert_eq!(folder_name, "Uploads");
    assert_eq!(account.as_deref(), Some(ACCOUNT));
    assert_eq!(
        sync_folder,
        Some(a.sync_status().unwrap().folder.unwrap().id)
    );
    // The next upload starts there, and asking again adds no second folder.
    assert!(matches!(
        a.begin_attachment_upload("first", None).unwrap(),
        AttachmentUploadDestination::GoogleDrive { destination: chosen, .. } if chosen.folder_id == folder_id
    ));
    a.use_sync_uploads_folder(&remote(&sim)).unwrap();
    assert_eq!(named(&sim, "Uploads").len(), 1);
}

#[test]
fn uploads_need_sync_on_google_drive() {
    let sim = DriveSim::default();
    let (_dir, mut a) = desk("Desk A");
    // Signed in, no folder chosen yet.
    let error = a.use_sync_uploads_folder(&remote(&sim)).unwrap_err();
    assert!(error.to_string().contains("Workspace sync"), "{error}");
    assert!(
        error.to_string().contains("Settings › Workspace sync"),
        "{error}"
    );
    assert!(sim.items().is_empty());
}

#[test]
fn sync_never_reads_the_uploads_folder_as_workspace_files() {
    let sim = DriveSim::default();
    let (_a_dir, mut a, _) = synced(&sim);
    a.use_sync_uploads_folder(&remote(&sim)).unwrap();
    let uploads = named(&sim, "Uploads")[0]["id"].as_str().unwrap().to_owned();
    add_files_to(&sim, &uploads);

    // Another computer reads the storage, joins and syncs.
    let (_b_dir, b) = desk("Desk B");
    let options = b.sync_setup_options(&remote(&sim)).unwrap();
    assert_eq!(options.existing.len(), 1);
    assert_eq!(options.existing[0].counts.tickets, 1);
    assert_eq!(options.existing[0].counts.attachments, 0);
    let (mut b, _safety) = b
        .sync_download_workspace(&remote(&sim), &options.existing[0].folder_id)
        .unwrap();
    b.sync_now(&remote(&sim)).unwrap();
    a.sync_now(&remote(&sim)).unwrap();

    for workspace in [&a, &b] {
        let titles: Vec<_> = workspace
            .list_tickets()
            .unwrap()
            .into_iter()
            .map(|ticket| ticket.title)
            .collect();
        assert_eq!(titles, ["From the first computer"]);
    }
    // The files in Uploads were not written, replaced or renamed by any run.
    let kept = |sim: &DriveSim, id: &str| sim.items().into_iter().find(|i| i["id"] == id).unwrap();
    assert_eq!(kept(&sim, "upload-2")["name"], "T-KQ43 Fix login.md");
    assert_eq!(kept(&sim, "upload-1")["parents"], json!([uploads]));
}

#[test]
fn replacing_and_disconnecting_leave_the_uploads_folder_untouched() {
    let sim = DriveSim::default();
    let (_a_dir, mut a, _) = synced(&sim);
    a.use_sync_uploads_folder(&remote(&sim)).unwrap();
    let uploads = named(&sim, "Uploads")[0]["id"].as_str().unwrap().to_owned();
    add_files_to(&sim, &uploads);
    let touching = |sim: &DriveSim, from: usize| -> Vec<(String, String)> {
        sim.requests()
            .split_off(from)
            .into_iter()
            .filter(|(method, url)| method != "GET" && !url.contains("oauth2.googleapis.com"))
            .collect()
    };
    let in_uploads = |sim: &DriveSim| -> Vec<Value> {
        sim.items()
            .into_iter()
            .filter(|item| item["id"] == uploads.as_str() || item["parents"] == json!([uploads]))
            .collect()
    };
    let before = in_uploads(&sim);
    assert_eq!(before.len(), 3);

    // Another computer replaces its Workspace with this one: the storage is only read.
    let (_b_dir, b) = desk("Desk B");
    let folder = b.sync_setup_options(&remote(&sim)).unwrap().existing[0]
        .folder_id
        .clone();
    let seen = sim.requests().len();
    let (mut b, _safety) = b.sync_download_workspace(&remote(&sim), &folder).unwrap();
    b.sync_now(&remote(&sim)).unwrap();
    assert_eq!(in_uploads(&sim), before);

    // Disconnecting changes nothing in the storage, and so does connecting again.
    let seen_disconnect = sim.requests().len();
    a.sync_disconnect().unwrap();
    assert!(touching(&sim, seen_disconnect).is_empty());
    a.sync_connect(CONNECTION, ACCOUNT).unwrap();
    a.sync_reconnect(&remote(&sim)).unwrap();
    a.sync_now(&remote(&sim)).unwrap();
    assert_eq!(in_uploads(&sim), before);
    // No request after the Uploads folder existed wrote to it or to what it holds.
    let writes: Vec<_> = touching(&sim, seen)
        .into_iter()
        .filter(|(_, url)| url.contains(&uploads) || url.contains("upload-"))
        .collect();
    assert!(writes.is_empty(), "{writes:?}");
}

/// A folder of the person's own in Drive, chosen for Files before sync was set up.
fn chosen_folder(sim: &DriveSim, workspace: &mut Workspace) {
    sim.insert(
        json!({"id": "team-files", "name": "Team files", "mimeType": FOLDER, "parents": [],
            "appProperties": {}}),
        b"",
    );
    let provider = GoogleDrive::new(CONNECTION, &Vault, sim);
    workspace
        .set_drive_upload_destination_for(
            &DriveUploadDestination {
                connection_id: CONNECTION.into(),
                folder_id: "team-files".into(),
                resource_key: None,
            },
            Some(ACCOUNT),
            &provider,
        )
        .unwrap();
}

#[test]
fn a_drive_folder_chosen_before_sync_gives_way_to_the_uploads_folder() {
    let sim = DriveSim::default();
    let (_dir, mut a, _) = synced(&sim);
    chosen_folder(&sim, &mut a);

    assert!(a.follow_sync_uploads(&remote(&sim)).unwrap());
    let uploads = named(&sim, "Uploads")[0]["id"].as_str().unwrap().to_owned();
    assert!(matches!(
        a.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::GoogleDrive { destination, .. } if destination.folder_id == uploads
    ));
    // Once there, nothing moves again; and files on this computer stay on this computer.
    assert!(!a.follow_sync_uploads(&remote(&sim)).unwrap());
    a.set_local_upload_destination().unwrap();
    assert!(!a.follow_sync_uploads(&remote(&sim)).unwrap());
    assert_eq!(
        a.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::Local
    );
}

#[test]
fn files_and_sync_share_one_google_account() {
    let sim = DriveSim::default();
    let (_dir, mut a, _) = synced(&sim);
    let signed_in = a.google_sign_in().unwrap().unwrap();
    assert_eq!(
        (
            signed_in.connection_id.as_str(),
            signed_in.account.as_deref()
        ),
        (CONNECTION, Some(ACCOUNT))
    );

    // A folder in another account than the one sync uses is refused.
    let provider = GoogleDrive::new(OTHER, &Vault, &sim);
    let error = a
        .set_drive_upload_destination_for(
            &DriveUploadDestination {
                connection_id: OTHER.into(),
                folder_id: "elsewhere".into(),
                resource_key: None,
            },
            None,
            &provider,
        )
        .unwrap_err();
    assert!(
        error.to_string().contains("another Google account"),
        "{error}"
    );

    // Switching account signs sync out of its folder and waits for the new account's choice;
    // a Drive folder of the old account is not carried over.
    a.use_sync_uploads_folder(&remote(&sim)).unwrap();
    a.switch_google_account(OTHER, "other@example.com").unwrap();
    let status = a.sync_status().unwrap();
    assert_eq!(
        status.connection,
        ticketd_core::sync::SyncConnection::Choosing
    );
    assert_eq!(status.account.as_deref(), Some("other@example.com"));
    assert_eq!(status.connection_id.as_deref(), Some(OTHER));
    assert_eq!(
        a.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::Local
    );
    assert_eq!(a.google_sign_in().unwrap().unwrap().connection_id, OTHER);
}

#[test]
fn the_same_account_again_changes_nothing_but_the_address() {
    let sim = DriveSim::default();
    let (_dir, mut a, _) = synced(&sim);
    a.use_sync_uploads_folder(&remote(&sim)).unwrap();
    let before = a.attachment_upload_destination().unwrap();

    a.switch_google_account(CONNECTION, ACCOUNT).unwrap();

    let status = a.sync_status().unwrap();
    assert_eq!(
        status.connection,
        ticketd_core::sync::SyncConnection::Connected
    );
    assert_eq!(a.attachment_upload_destination().unwrap(), before);
}

#[test]
fn files_remember_their_account_for_sync_to_use_without_a_second_consent() {
    let sim = DriveSim::default();
    let directory = tempfile::tempdir().unwrap();
    let mut files_only = Workspace::open(directory.path().join("Desk")).unwrap();
    assert_eq!(files_only.google_sign_in().unwrap(), None);
    chosen_folder(&sim, &mut files_only);

    let known = files_only.google_sign_in().unwrap().unwrap();
    assert_eq!(known.connection_id, CONNECTION);
    assert_eq!(known.account.as_deref(), Some(ACCOUNT));
    // Sync signs in with it: the same connection, shown with the same address.
    let status = files_only
        .sync_connect(&known.connection_id, known.account.as_deref().unwrap())
        .unwrap();
    assert_eq!(status.connection_id.as_deref(), Some(CONNECTION));
    assert_eq!(status.account.as_deref(), Some(ACCOUNT));
}

/// Joining a Workspace through Replace starts from an empty Workspace, so a Drive folder
/// chosen on this computer before is not carried over: new files stay on this computer
/// until Drive is chosen again. There is nothing to move, so following the sync folder
/// afterwards (which the desktop does at the end of every join) makes no call to Drive.
#[test]
fn joining_through_replace_leaves_uploads_on_this_computer_and_asks_drive_nothing() {
    let sim = DriveSim::default();
    let (_dir, _a, _) = synced(&sim);
    let (_b_dir, mut b) = desk("Desk B");
    chosen_folder(&sim, &mut b);
    let folder = b.sync_setup_options(&remote(&sim)).unwrap().existing[0]
        .folder_id
        .clone();
    let (mut b, _safety) = b.sync_download_workspace(&remote(&sim), &folder).unwrap();
    assert_eq!(
        b.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::Local
    );

    let seen = sim.requests().len();
    assert!(!b.follow_sync_uploads(&remote(&sim)).unwrap());
    assert_eq!(sim.requests().len(), seen);
}
