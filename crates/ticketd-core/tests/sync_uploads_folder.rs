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
    chosen_folder_in(sim, workspace, CONNECTION);
}

/// [`chosen_folder`], in the Google account signed in as `connection`.
fn chosen_folder_in(sim: &DriveSim, workspace: &mut Workspace, connection: &str) {
    sim.insert(
        json!({"id": "team-files", "name": "Team files", "mimeType": FOLDER, "parents": [],
            "appProperties": {}}),
        b"",
    );
    let provider = GoogleDrive::new(connection, &Vault, sim);
    workspace
        .set_drive_upload_destination_for(
            &DriveUploadDestination {
                connection_id: connection.into(),
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

/// Signing in again to recover sync must come back as the account sync is signed in with:
/// another account would leave sync and Files on two accounts, with the sync folder out of
/// the new account's reach.
#[test]
fn signing_in_again_as_another_account_is_refused_and_leaves_both_on_the_first() {
    let sim = DriveSim::default();
    let (_dir, mut a, _) = synced(&sim);
    a.use_sync_uploads_folder(&remote(&sim)).unwrap();
    let before = a.attachment_upload_destination().unwrap();
    let status_before = a.sync_status().unwrap();

    let error = a.sync_connect(OTHER, "other@example.com").unwrap_err();

    assert!(
        error.to_string().contains("another Google account"),
        "{error}"
    );
    assert_eq!(a.sync_status().unwrap(), status_before);
    assert_eq!(a.attachment_upload_destination().unwrap(), before);
    assert_eq!(
        a.google_sign_in().unwrap().unwrap().connection_id,
        CONNECTION
    );

    // The same account again is what recovery needs; only the address shown may change.
    let status = a.sync_connect(CONNECTION, "renamed@example.com").unwrap();
    assert_eq!(status.connection_id.as_deref(), Some(CONNECTION));
    assert_eq!(status.account.as_deref(), Some("renamed@example.com"));
    assert_eq!(status.folder, status_before.folder);
}

/// A folder chosen for Files holds the Google account Workspace sync must use too, also
/// when sync is not signed in (yet, or any more).
#[test]
fn sync_will_not_sign_in_as_another_account_than_the_files_folder_uses() {
    let sim = DriveSim::default();
    let directory = tempfile::tempdir().unwrap();
    let mut files_only = Workspace::open(directory.path().join("Desk")).unwrap();
    chosen_folder(&sim, &mut files_only);

    let error = files_only
        .sync_connect(OTHER, "other@example.com")
        .unwrap_err();

    assert!(
        error.to_string().contains("another Google account"),
        "{error}"
    );
    assert_eq!(files_only.sync_status().unwrap().connection_id, None);
    files_only.sync_connect(CONNECTION, ACCOUNT).unwrap();
}

/// A backup made with its Files folder in `connection`'s account, in a folder of its own.
fn backup_with_files_in(connection: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let mut other = Workspace::open(directory.path().join("Elsewhere")).unwrap();
    chosen_folder_in(&DriveSim::default(), &mut other, connection);
    let backup = directory.path().join("backup.sqlite3");
    other.backup(&backup).unwrap();
    (directory, backup)
}

/// A restore keeps this computer's Google sign-in, so a Files folder the backup holds in
/// another account would leave Files and sync on two accounts: it goes back to this
/// computer, as when the account is switched. A folder in the kept account stays.
#[test]
fn a_restore_keeps_files_and_sync_on_this_computers_one_google_account() {
    let sim = DriveSim::default();
    let (directory, a, _) = synced(&sim);
    let path = directory.path().join("Desk A");
    drop(a);

    let (_kept, elsewhere) = backup_with_files_in(OTHER);
    Workspace::restore(&path, &elsewhere).unwrap();
    let mut a = Workspace::open(&path).unwrap();
    assert_eq!(
        a.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::Local
    );
    let signed_in = a.google_sign_in().unwrap().unwrap();
    assert_eq!(
        (
            signed_in.connection_id.as_str(),
            signed_in.account.as_deref()
        ),
        (CONNECTION, Some(ACCOUNT))
    );
    // Sync's setup is not blocked by a Files folder on the other account.
    a.sync_connect(CONNECTION, ACCOUNT).unwrap();
    drop(a);

    let (_same, here) = backup_with_files_in(CONNECTION);
    Workspace::restore(&path, &here).unwrap();
    let a = Workspace::open(&path).unwrap();
    assert!(matches!(
        a.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::GoogleDrive { destination, .. } if destination.connection_id == CONNECTION
    ));
}

/// Without a sign-in of sync's, the backup's Files folder is the only sign-in there is.
#[test]
fn a_restore_onto_a_computer_without_sync_sign_in_keeps_the_backups_drive_folder() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("Desk");
    drop(Workspace::open(&path).unwrap());
    let (_kept, elsewhere) = backup_with_files_in(OTHER);

    Workspace::restore(&path, &elsewhere).unwrap();
    let a = Workspace::open(&path).unwrap();

    assert!(matches!(
        a.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::GoogleDrive { destination, .. } if destination.connection_id == OTHER
    ));
}

/// A computer whose only Google sign-in is its Files folder (no sync) keeps that account
/// through a restore, as one with sync signed in does.
#[test]
fn a_restore_keeps_the_one_google_account_of_a_computer_that_only_keeps_files_in_drive() {
    let sim = DriveSim::default();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("Desk");
    let mut files_only = Workspace::open(&path).unwrap();
    chosen_folder(&sim, &mut files_only);
    drop(files_only);

    let (_kept, elsewhere) = backup_with_files_in(OTHER);
    Workspace::restore(&path, &elsewhere).unwrap();
    let mut a = Workspace::open(&path).unwrap();
    // The computer's own Files folder stays, so its Google account is not forgotten.
    assert!(matches!(
        a.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::GoogleDrive { destination, .. }
            if destination.connection_id == CONNECTION && destination.folder_id == "team-files"
    ));
    assert_eq!(
        a.google_sign_in().unwrap().unwrap().connection_id,
        CONNECTION
    );
    // Sync can still sign in with this computer's account.
    a.sync_connect(CONNECTION, ACCOUNT).unwrap();
    drop(a);

    let mut files_only = Workspace::open(&path).unwrap();
    chosen_folder(&sim, &mut files_only);
    drop(files_only);
    let (_same, here) = backup_with_files_in(CONNECTION);
    Workspace::restore(&path, &here).unwrap();
    let a = Workspace::open(&path).unwrap();
    assert!(matches!(
        a.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::GoogleDrive { destination, .. } if destination.connection_id == CONNECTION
    ));
}

/// The same, when the backup keeps Files on the computer it was made on: the computer's own
/// Google account is not forgotten either.
#[test]
fn a_restore_of_a_backup_with_files_on_this_computer_keeps_the_files_only_google_account() {
    let sim = DriveSim::default();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("Desk");
    let mut files_only = Workspace::open(&path).unwrap();
    chosen_folder(&sim, &mut files_only);
    drop(files_only);

    let backups = tempfile::tempdir().unwrap();
    let backup = backups.path().join("backup.sqlite3");
    Workspace::open(backups.path().join("Elsewhere"))
        .unwrap()
        .backup(&backup)
        .unwrap();
    Workspace::restore(&path, &backup).unwrap();

    let a = Workspace::open(&path).unwrap();
    assert!(matches!(
        a.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::GoogleDrive { destination, .. }
            if destination.connection_id == CONNECTION && destination.folder_id == "team-files"
    ));
    assert_eq!(
        a.google_sign_in().unwrap().unwrap().connection_id,
        CONNECTION
    );
}

/// Another handle on the same Workspace file signing in to Google while a Files folder is
/// being checked with Drive: the folder is refused when it is saved, not accepted on the
/// strength of a check made before.
struct SignsInDuringCheck<'a> {
    other_handle: std::cell::RefCell<&'a mut Workspace>,
}

impl ticketd_core::drive::DriveUploadProvider for SignsInDuringCheck<'_> {
    fn folder(
        &self,
        id: &str,
        _: Option<&str>,
    ) -> Result<ticketd_core::drive::DriveFolder, ticketd_core::drive::DriveError> {
        self.other_handle
            .borrow_mut()
            .sync_connect(CONNECTION, ACCOUNT)
            .unwrap();
        Ok(ticketd_core::drive::DriveFolder {
            id: id.into(),
            name: "Team files".into(),
            can_add_children: true,
        })
    }
    fn reserve_file_id(&self) -> Result<String, ticketd_core::drive::DriveError> {
        unreachable!("a folder check uploads nothing")
    }
    fn uploaded_file(
        &self,
        _: &str,
    ) -> Result<Option<ticketd_core::drive::DriveUploadedFile>, ticketd_core::drive::DriveError>
    {
        unreachable!("a folder check uploads nothing")
    }
    fn upload_blob(
        &self,
        _: &ticketd_core::drive::DriveUploadOperation,
        _: &mut dyn std::io::Read,
        _: &mut dyn FnMut(u64, u64) -> bool,
    ) -> Result<(), ticketd_core::drive::DriveError> {
        unreachable!("a folder check uploads nothing")
    }
}

#[test]
fn a_files_folder_is_checked_against_sync_again_when_it_is_saved() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("Desk");
    let mut files = Workspace::open(&path).unwrap();
    let mut sync = Workspace::open(&path).unwrap();
    let provider = SignsInDuringCheck {
        other_handle: std::cell::RefCell::new(&mut sync),
    };

    let error = files
        .set_drive_upload_destination_for(
            &DriveUploadDestination {
                connection_id: OTHER.into(),
                folder_id: "team-files".into(),
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
    assert_eq!(
        files.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::Local
    );
    assert_eq!(
        files.google_sign_in().unwrap().unwrap().connection_id,
        CONNECTION
    );
}

/// Another handle on the same Workspace file switching Google account while the Uploads
/// folder is being found: the folder belongs to the account it was found with.
struct SwitchesAccountDuringLookup<'a> {
    other_handle: std::cell::RefCell<&'a mut Workspace>,
}

impl ticketd_core::drive::SyncUploadsFolder for SwitchesAccountDuringLookup<'_> {
    fn uploads_folder(
        &self,
        _: &str,
    ) -> Result<ticketd_core::drive::DriveFolder, ticketd_core::sync::remote::RemoteError> {
        self.other_handle
            .borrow_mut()
            .switch_google_account(OTHER, "other@example.com")
            .unwrap();
        Ok(ticketd_core::drive::DriveFolder {
            id: "uploads-folder".into(),
            name: "Uploads".into(),
            can_add_children: true,
        })
    }
}

#[test]
fn the_uploads_folder_is_not_saved_for_an_account_sync_left_while_it_was_looked_up() {
    let sim = DriveSim::default();
    let (directory, mut a, _) = synced(&sim);
    let mut other_handle = Workspace::open(directory.path().join("Desk A")).unwrap();
    let provider = SwitchesAccountDuringLookup {
        other_handle: std::cell::RefCell::new(&mut other_handle),
    };

    let error = a.use_sync_uploads_folder(&provider).unwrap_err();

    assert!(
        error.to_string().contains("another Google account"),
        "{error}"
    );
    assert_eq!(
        a.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::Local
    );
    assert_eq!(a.google_sign_in().unwrap().unwrap().connection_id, OTHER);
}

/// Another handle on the same Workspace file moving sync to another folder on the same
/// Google connection while the Uploads folder is being found: the Uploads folder found is
/// the old folder's.
struct MovesSyncFolderDuringLookup {
    workspace_file: std::path::PathBuf,
}

impl ticketd_core::drive::SyncUploadsFolder for MovesSyncFolderDuringLookup {
    fn uploads_folder(
        &self,
        _: &str,
    ) -> Result<ticketd_core::drive::DriveFolder, ticketd_core::sync::remote::RemoteError> {
        rusqlite::Connection::open(&self.workspace_file)
            .unwrap()
            .execute(
                "UPDATE sync_state SET folder = 'another-sync-folder', folder_name = 'ticketd Elsewhere'",
                [],
            )
            .unwrap();
        Ok(ticketd_core::drive::DriveFolder {
            id: "uploads-folder".into(),
            name: "Uploads".into(),
            can_add_children: true,
        })
    }
}

#[test]
fn the_uploads_folder_is_not_saved_for_a_sync_folder_sync_left_while_it_was_looked_up() {
    let sim = DriveSim::default();
    let (directory, mut a, _) = synced(&sim);
    let provider = MovesSyncFolderDuringLookup {
        workspace_file: directory.path().join("Desk A"),
    };

    let error = a.use_sync_uploads_folder(&provider).unwrap_err();

    assert!(error.to_string().contains("another folder"), "{error}");
    assert_eq!(
        a.attachment_upload_destination().unwrap(),
        AttachmentUploadDestination::Local
    );
    let now = a.sync_binding().unwrap().unwrap();
    assert_eq!(now.folder_id, "another-sync-folder");
    assert_eq!(now.connection_id.as_deref(), Some(CONNECTION));
}
