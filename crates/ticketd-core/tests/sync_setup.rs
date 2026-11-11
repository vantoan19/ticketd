//! Sync setup, the device registry, Attachment transfer, recovery states and
//! the status model, through the shared-core interface against the fake storage.
#![allow(clippy::unwrap_used)] // Setup that fails must fail the test.

use std::io::Cursor;

use ticketd_core::{
    Error, TicketPatch, Workspace,
    sync::{
        AttachmentAvailabilityState, AttachmentDownload, RecordKind, SyncConnection, SyncDirection,
        SyncNoticeKind, SyncRecovery, SyncRecoveryAction, SyncState, SyncStatus,
        remote::{FakeRemote, RemoteError, RemoteKey, RemoteKind, RemoteOp, RemoteStorage},
    },
};

const BYTES: &[u8] = b"the bytes of the attached file";

struct Desks {
    directory: tempfile::TempDir,
    remote: FakeRemote,
}

fn desks() -> Desks {
    Desks {
        directory: tempfile::tempdir().unwrap(),
        remote: FakeRemote::new(),
    }
}

impl Desks {
    /// A Workspace signed in to the storage under a desktop name.
    fn desk(&self, name: &str) -> Workspace {
        let mut workspace = Workspace::open(self.directory.path().join(name)).unwrap();
        workspace
            .set_sync_settings(name, 60, AttachmentDownload::Automatic)
            .unwrap();
        workspace
            .sync_connect("connection-1", "person@example.com")
            .unwrap();
        workspace
    }

    /// A desk whose Workspace is uploaded to a folder of its own, holding one
    /// ticket with an Attachment that its description also links.
    fn uploaded(&self, name: &str) -> (Workspace, String, String) {
        let mut desk = self.desk(name);
        let reference = desk.create_ticket("Login").unwrap().reference;
        let attachment = desk
            .import_attachment_bytes("request-1", "notes.txt", BYTES, |_, _| true)
            .unwrap()
            .id;
        desk.set_ticket_attachment(&reference, &attachment, true)
            .unwrap();
        let link = format!("[notes]({})", desk.attachment_uri(&attachment).unwrap());
        desk.change_ticket(
            &reference,
            TicketPatch {
                body: Some(link),
                ..Default::default()
            },
        )
        .unwrap();
        desk.sync_upload_workspace(&self.remote, "ticketd Home")
            .unwrap();
        desk.sync_now(&self.remote).unwrap();
        (desk, reference, attachment)
    }

    /// Another desk that replaced its Workspace with the one in the storage.
    fn joined(&self, name: &str, mode: AttachmentDownload) -> Workspace {
        let mut desk = self.desk(name);
        desk.set_sync_settings(name, 60, mode).unwrap();
        let folder = self.folder();
        desk.sync_download_workspace(&self.remote, &folder)
            .unwrap()
            .0
    }

    fn folder(&self) -> String {
        self.remote.folders().unwrap()[0].id.clone()
    }

    fn file(&self, key: &RemoteKey) -> (String, Vec<u8>) {
        let folder = self.folder();
        let file = self
            .remote
            .list(&folder)
            .unwrap()
            .into_iter()
            .find(|file| file.key == *key)
            .unwrap();
        let mut bytes = Vec::new();
        self.remote
            .download(&folder, key, &file.version, &mut bytes)
            .unwrap();
        (file.version, bytes)
    }
}

fn titles(workspace: &Workspace) -> Vec<String> {
    workspace
        .list_tickets()
        .unwrap()
        .into_iter()
        .map(|ticket| ticket.title)
        .collect()
}

#[test]
fn a_workspace_is_uploaded_to_its_own_folder_and_another_desk_replaces_its_own_with_it() {
    let desks = desks();
    let a = desks.desk("Desk A");
    let choosing = a.sync_status().unwrap();
    assert_eq!(choosing.connection, SyncConnection::Choosing);
    assert_eq!(choosing.account.as_deref(), Some("person@example.com"));
    assert_eq!(choosing.state, SyncState::SavedLocally);
    drop(a);

    let (a, reference, attachment) = desks.uploaded("Desk A");
    let status = a.sync_status().unwrap();
    assert_eq!(status.connection, SyncConnection::Connected);
    assert_eq!(status.folder.unwrap().name, "ticketd Home");
    assert_eq!(status.state, SyncState::Uploaded);
    assert!(status.last_synced_at.is_some());
    assert_eq!((status.pending_uploads, status.first_sync), (vec![], None));

    // The other desk has work of its own, and sees what the storage holds.
    let mut b = desks.desk("Desk B");
    b.create_ticket("Only on desk B").unwrap();
    let options = b.sync_setup_options(&desks.remote).unwrap();
    assert_eq!((options.local.tickets, options.existing.len()), (1, 1));
    let existing = &options.existing[0];
    assert_eq!(existing.folder_name, "ticketd Home");
    assert_eq!(
        (
            existing.counts.tickets,
            existing.counts.attachments,
            existing.devices
        ),
        (1, 1, 1)
    );
    assert_eq!(existing.last_synced_by.as_deref(), Some("Desk A"));
    assert!(existing.last_synced_at.is_some());

    let (mut b, safety) = b
        .sync_download_workspace(&desks.remote, &existing.folder_id)
        .unwrap();
    // Nothing is merged: its own work is in the safety backup only.
    assert!(safety.is_file());
    assert_eq!(titles(&b), Vec::<String>::new());
    let status = b.sync_status().unwrap();
    assert_eq!(status.connection, SyncConnection::Connected);
    assert_eq!(status.account.as_deref(), Some("person@example.com"));
    assert_eq!(
        status.first_sync.unwrap().direction,
        SyncDirection::Download
    );
    assert_eq!(b.sync_settings().unwrap().desktop_name, "Desk B");

    let status = b.sync_now(&desks.remote).unwrap();
    assert_eq!(
        (status.state, status.first_sync),
        (SyncState::Uploaded, None)
    );
    assert_eq!(titles(&b), ["Login"]);
    // Both desks started with the same device code; the one joining took another.
    assert_ne!(b.device_code().unwrap(), a.device_code().unwrap());
    assert_eq!(
        a.sync_setup_options(&desks.remote).unwrap().existing[0].devices,
        2
    );

    // The Attachment arrived with its bytes, attached and linked as on desk A.
    let attached = b.ticket_attachments(&reference).unwrap();
    assert_eq!(attached.len(), 1);
    assert_eq!(
        (attached[0].id.as_str(), attached[0].display_name.as_str()),
        (attachment.as_str(), "notes.txt")
    );
    assert_eq!(
        std::fs::read(b.attachment_open_path(&attachment).unwrap()).unwrap(),
        BYTES
    );
    let uri = a.attachment_uri(&attachment).unwrap();
    assert_eq!(b.resolve_attachment_uri(&uri).unwrap().id, attachment);
    assert!(b.show_ticket(&reference).unwrap().body.contains(&uri));
    assert_eq!(b.sync_notices().unwrap(), []);
    assert_eq!(b.sync_now(&desks.remote).unwrap().pending_uploads, []);

    // Disconnecting forgets the folder and nothing else.
    let status = b.sync_disconnect().unwrap();
    assert_eq!(status.connection, SyncConnection::NotConnected);
    assert_eq!(titles(&b), ["Login"]);
    assert_eq!(desks.remote.folders().unwrap().len(), 1);
    assert!(matches!(b.sync_now(&desks.remote), Err(Error::Sync(_))));
}

#[test]
fn a_saved_change_is_pending_until_the_next_run_uploads_it() {
    let desks = desks();
    let (mut a, reference, _) = desks.uploaded("Desk A");

    let id = a
        .change_ticket(
            &reference,
            TicketPatch {
                title: Some("Sign in".into()),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
    let extra = a
        .import_attachment_bytes("request-2", "more.txt", b"more", |_, _| true)
        .unwrap()
        .id;

    let status = a.sync_status().unwrap();
    assert_eq!(status.state, SyncState::UploadPending);
    let pending: Vec<_> = status
        .pending_uploads
        .iter()
        .map(|item| {
            (
                item.kind,
                item.id.as_str(),
                item.reference.as_deref(),
                item.title.as_str(),
            )
        })
        .collect();
    assert_eq!(
        pending,
        [
            (
                RecordKind::Ticket,
                id.as_str(),
                Some(reference.as_str()),
                "Sign in"
            ),
            (RecordKind::Attachment, extra.as_str(), None, "more.txt"),
        ]
    );

    let status = a.sync_now(&desks.remote).unwrap();
    assert_eq!(
        (status.state, status.pending_uploads),
        (SyncState::Uploaded, vec![])
    );
    // The ticket's file carries its readable name in the storage.
    let listed = desks.remote.list(&desks.folder()).unwrap();
    assert!(
        listed
            .iter()
            .any(|file| file.name == format!("{reference} Sign in.md"))
    );
}

#[test]
fn settings_keep_a_name_and_a_poll_interval_of_thirty_seconds_or_more() {
    let desks = desks();
    let mut a = Workspace::open(desks.directory.path().join("a")).unwrap();
    let settings = a.sync_settings().unwrap();
    assert!(!settings.desktop_name.is_empty());
    assert_eq!(
        (settings.poll_interval_secs, settings.attachment_download),
        (60, AttachmentDownload::Automatic)
    );
    assert_eq!(settings.device_code, a.device_code().unwrap());

    assert!(matches!(
        a.set_sync_settings("Studio", 29, AttachmentDownload::OnOpen),
        Err(Error::Sync(_))
    ));
    assert!(matches!(
        a.set_sync_settings("  ", 30, AttachmentDownload::OnOpen),
        Err(Error::Sync(_))
    ));
    let settings = a
        .set_sync_settings("Studio", 30, AttachmentDownload::OnOpen)
        .unwrap();
    assert_eq!(
        (
            settings.desktop_name.as_str(),
            settings.poll_interval_secs,
            settings.attachment_download
        ),
        ("Studio", 30, AttachmentDownload::OnOpen)
    );
}

#[test]
fn two_desks_writing_the_device_registry_at_once_both_stay_in_it() {
    let desks = desks();
    let (mut a, _, _) = desks.uploaded("Desk A");
    let mut b = desks.joined("Desk B", AttachmentDownload::Automatic);
    // Desk B's listing predates desk A's registry, so its write meets a file
    // it did not know of.
    desks
        .remote
        .omit_from_next_listing(&[RemoteKey::new(RemoteKind::Devices, "devices")]);
    b.sync_now(&desks.remote).unwrap();

    let (_, registry) = desks.file(&RemoteKey::new(RemoteKind::Devices, "devices"));
    let registry = String::from_utf8(registry).unwrap();
    assert!(
        registry.contains("Desk A") && registry.contains("Desk B"),
        "{registry}"
    );

    // A renamed desk is renamed in the registry by its next run.
    a.set_sync_settings("Studio", 60, AttachmentDownload::Automatic)
        .unwrap();
    a.create_ticket("Another").unwrap();
    a.sync_now(&desks.remote).unwrap();
    let existing = a.sync_setup_options(&desks.remote).unwrap().existing;
    assert_eq!(
        (existing[0].devices, existing[0].last_synced_by.as_deref()),
        (2, Some("Studio"))
    );
}

#[test]
fn an_attachment_is_downloaded_on_demand_when_downloads_are_not_automatic() {
    let desks = desks();
    let (_a, reference, attachment) = desks.uploaded("Desk A");
    let mut b = desks.joined("Desk B", AttachmentDownload::OnOpen);

    let status = b.sync_now(&desks.remote).unwrap();
    // Not downloading is the chosen resting state, not pending work.
    assert_eq!(status.state, SyncState::Uploaded);
    assert_eq!(status.attachment_downloads.count, 0);
    assert_eq!(b.ticket_attachments(&reference).unwrap().len(), 1);
    let availability = |workspace: &Workspace| {
        workspace
            .attachment_availability(&[attachment.clone(), "unknown".into()])
            .unwrap()
            .into_iter()
            .map(|found| (found.id, found.state))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        availability(&b),
        [(
            attachment.clone(),
            AttachmentAvailabilityState::NotDownloaded
        )]
    );
    assert!(b.attachment_open_path(&attachment).is_err());
    // A backup of a Workspace that does not hold every file is still a backup.
    b.backup(desks.directory.path().join("backup.sqlite3"))
        .unwrap();

    b.download_attachment(&desks.remote, &attachment).unwrap();

    assert_eq!(
        availability(&b),
        [(attachment.clone(), AttachmentAvailabilityState::Downloaded)]
    );
    assert_eq!(
        std::fs::read(b.attachment_open_path(&attachment).unwrap()).unwrap(),
        BYTES
    );
    // Nothing is fetched or uploaded twice.
    let before = desks.remote.calls().len();
    b.download_attachment(&desks.remote, &attachment).unwrap();
    assert_eq!(desks.remote.calls().len(), before);
    b.sync_now(&desks.remote).unwrap();
    let writes = |calls: &[RemoteOp]| calls.iter().filter(|op| **op == RemoteOp::Write).count();
    assert_eq!(writes(&desks.remote.calls()[before..]), 0);
}

#[test]
fn downloaded_bytes_that_are_not_the_uploaded_ones_are_refused() {
    let desks = desks();
    let (_a, _, attachment) = desks.uploaded("Desk A");
    // The storage hands out other bytes than the manifest describes.
    let manifest = RemoteKey::new(RemoteKind::Devices, "attachments");
    let (version, described) = desks.file(&manifest);
    let described = String::from_utf8(described).unwrap();
    let (_, hash) = described.split_once("\"sha256\": \"").unwrap();
    let tampered = described.replace(&hash[..64], &"0".repeat(64));
    desks
        .remote
        .write(
            &desks.folder(),
            &manifest,
            "attachments.json",
            Some(&version),
            &mut Cursor::new(tampered.as_bytes()),
        )
        .unwrap();
    let mut b = desks.joined("Desk B", AttachmentDownload::Automatic);

    // The run itself succeeds; the one file is reported and left out.
    let status = b.sync_now(&desks.remote).unwrap();

    assert_eq!(status.state, SyncState::NeedsAttention);
    assert_eq!(status.attachment_downloads.count, 1);
    assert_eq!(
        b.attachment_availability(std::slice::from_ref(&attachment))
            .unwrap()[0]
            .state,
        AttachmentAvailabilityState::NotDownloaded
    );
    assert!(b.attachment_open_path(&attachment).is_err());
    let notices = b.sync_notices().unwrap();
    assert!(matches!(
        &notices[..],
        [notice] if matches!(&notice.notice, SyncNoticeKind::UnreadableFile { path, .. } if path == "attachments/notes.txt")
    ));
    // The same bad bytes are not fetched again by every run, only when asked for.
    let before = desks.remote.calls().len();
    b.sync_now(&desks.remote).unwrap();
    assert!(!desks.remote.calls()[before..].contains(&RemoteOp::Download));
    assert!(matches!(
        b.download_attachment(&desks.remote, &attachment),
        Err(Error::Attachment(_))
    ));
    assert_eq!(b.sync_notices().unwrap().len(), 1);
}

fn recovered(status: &SyncStatus) -> (Option<SyncRecovery>, SyncState) {
    (status.recovery, status.state)
}

#[test]
fn a_storage_failure_becomes_a_recovery_state_that_keeps_local_work_until_a_run_succeeds() {
    let desks = desks();
    let (mut a, reference, _) = desks.uploaded("Desk A");
    for (error, recovery, state, action) in [
        (
            RemoteError::Unauthorized,
            SyncRecovery::AuthorizationExpired,
            SyncState::NeedsAttention,
            SyncRecoveryAction::Reconnect,
        ),
        (
            RemoteError::StorageFull,
            SyncRecovery::StorageFull,
            SyncState::NeedsAttention,
            SyncRecoveryAction::Retry,
        ),
        (
            RemoteError::Offline,
            SyncRecovery::Offline,
            SyncState::SavedLocally,
            SyncRecoveryAction::Retry,
        ),
        (
            RemoteError::RateLimited { retry_after: None },
            SyncRecovery::RateLimited,
            SyncState::SavedLocally,
            SyncRecoveryAction::Retry,
        ),
    ] {
        let title = format!("Saved during {recovery:?}");
        a.change_ticket(
            &reference,
            TicketPatch {
                title: Some(title.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        // The failure strikes at the upload, after the run has begun.
        desks.remote.fail(RemoteOp::Write, 1, error);

        let status = a.sync_now(&desks.remote).unwrap();

        assert_eq!(recovered(&status), (Some(recovery), state));
        assert_eq!(recovery.action(), action);
        assert_eq!(status.pending_uploads.len(), 1);
        assert_eq!(a.show_ticket(&reference).unwrap().title, title);
        // The state is what a later launch finds too.
        assert_eq!(a.sync_status().unwrap().recovery, Some(recovery));

        let status = a.sync_recover(&desks.remote).unwrap();
        assert_eq!(recovered(&status), (None, SyncState::Uploaded));
        assert_eq!(status.pending_uploads, []);
    }
}

#[test]
fn a_missing_folder_or_an_emptied_one_is_uploaded_again_and_never_read_as_deletions() {
    let desks = desks();
    let (mut a, reference, attachment) = desks.uploaded("Desk A");
    let folder = desks.folder();
    let records = |remote: &FakeRemote| {
        remote
            .list(&folder)
            .unwrap()
            .into_iter()
            .filter(|file| file.key.kind == RemoteKind::Ticket)
            .collect::<Vec<_>>()
    };

    // Every record file is gone although the folder is there.
    for file in records(&desks.remote) {
        assert!(desks.remote.remove_file(&folder, &file.key));
    }
    let status = a.sync_now(&desks.remote).unwrap();
    assert_eq!(
        recovered(&status),
        (Some(SyncRecovery::FolderMissing), SyncState::NeedsAttention)
    );
    assert_eq!(
        SyncRecovery::FolderMissing.action(),
        SyncRecoveryAction::Reupload
    );
    assert_eq!(titles(&a), ["Login"]);
    let status = a.sync_recover(&desks.remote).unwrap();
    assert_eq!(recovered(&status), (None, SyncState::Uploaded));
    assert_eq!(records(&desks.remote).len(), 1);

    // The whole folder is gone.
    desks.remote.remove_folder(&folder);
    let status = a.sync_now(&desks.remote).unwrap();
    assert_eq!(
        recovered(&status),
        (Some(SyncRecovery::FolderMissing), SyncState::NeedsAttention)
    );
    assert_eq!(titles(&a), ["Login"]);
    assert_eq!(a.ticket_attachments(&reference).unwrap().len(), 1);
    let status = a.sync_recover(&desks.remote).unwrap();
    assert_eq!(recovered(&status), (None, SyncState::Uploaded));
    assert_eq!(records(&desks.remote).len(), 1);

    // Another desk gets all of it from the folder that was made again.
    let mut b = desks.joined("Desk B", AttachmentDownload::Automatic);
    b.sync_now(&desks.remote).unwrap();
    assert_eq!(titles(&b), ["Login"]);
    assert_eq!(
        std::fs::read(b.attachment_open_path(&attachment).unwrap()).unwrap(),
        BYTES
    );
}

#[test]
fn a_conflict_needs_attention_and_names_the_record_to_review() {
    let desks = desks();
    let (mut a, reference, _) = desks.uploaded("Desk A");
    let mut b = desks.joined("Desk B", AttachmentDownload::Automatic);
    b.sync_now(&desks.remote).unwrap();
    let retitle = |workspace: &mut Workspace, title: &str| {
        workspace
            .change_ticket(
                &reference,
                TicketPatch {
                    title: Some(title.into()),
                    ..Default::default()
                },
            )
            .unwrap();
    };
    retitle(&mut a, "Sign in");
    retitle(&mut b, "Log on");
    a.sync_now(&desks.remote).unwrap();

    let status = b.sync_now(&desks.remote).unwrap();

    assert_eq!(recovered(&status), (None, SyncState::NeedsAttention));
    let review: Vec<_> = status
        .needs_review
        .iter()
        .map(|item| (item.kind, item.reference.as_deref(), item.title.as_str()))
        .collect();
    assert_eq!(
        review,
        [(RecordKind::Ticket, Some(reference.as_str()), "Log on")]
    );
}

/// The fake storage, looking at a Workspace from a second connection each
/// time Attachment bytes are being fetched.
struct Watching {
    remote: FakeRemote,
    workspace: std::path::PathBuf,
    attachment: String,
    seen: std::sync::Mutex<Vec<AttachmentAvailabilityState>>,
}

impl RemoteStorage for Watching {
    fn folders(&self) -> Result<Vec<ticketd_core::sync::remote::RemoteFolder>, RemoteError> {
        self.remote.folders()
    }

    fn ensure_folder(&self, folder: &str, name: &str) -> Result<(), RemoteError> {
        self.remote.ensure_folder(folder, name)
    }

    fn list(
        &self,
        folder: &str,
    ) -> Result<Vec<ticketd_core::sync::remote::RemoteFile>, RemoteError> {
        self.remote.list(folder)
    }

    fn download(
        &self,
        folder: &str,
        key: &RemoteKey,
        version: &str,
        output: &mut dyn std::io::Write,
    ) -> Result<(), RemoteError> {
        if key.kind == RemoteKind::Attachment {
            let other = Workspace::open(&self.workspace).unwrap();
            let found = other
                .attachment_availability(std::slice::from_ref(&self.attachment))
                .unwrap();
            self.seen.lock().unwrap().push(found[0].state);
        }
        self.remote.download(folder, key, version, output)
    }

    fn write(
        &self,
        folder: &str,
        key: &RemoteKey,
        name: &str,
        expected: Option<&str>,
        content: &mut dyn ticketd_core::sync::remote::RemoteContent,
    ) -> Result<ticketd_core::sync::remote::RemoteFile, RemoteError> {
        self.remote.write(folder, key, name, expected, content)
    }

    fn revisions(
        &self,
        folder: &str,
        key: &RemoteKey,
    ) -> Result<Vec<ticketd_core::sync::remote::RemoteRevision>, RemoteError> {
        self.remote.revisions(folder, key)
    }
}

#[test]
fn an_attachment_shows_as_downloading_while_its_bytes_arrive_and_not_downloaded_if_they_stop() {
    let desks = desks();
    let (_a, _, attachment) = desks.uploaded("Desk A");
    let mut b = desks.joined("Desk B", AttachmentDownload::OnOpen);
    b.sync_now(&desks.remote).unwrap();
    let watching = Watching {
        remote: desks.remote.clone(),
        workspace: desks.directory.path().join("Desk B"),
        attachment: attachment.clone(),
        seen: Default::default(),
    };
    let state = |workspace: &Workspace| {
        workspace
            .attachment_availability(std::slice::from_ref(&attachment))
            .unwrap()[0]
            .state
    };

    // The connection drops mid-download: the file is not half there.
    desks
        .remote
        .fail(RemoteOp::Download, 1, RemoteError::Offline);
    assert!(matches!(
        b.download_attachment(&watching, &attachment),
        Err(Error::Remote(RemoteError::Offline))
    ));
    assert_eq!(state(&b), AttachmentAvailabilityState::NotDownloaded);

    b.download_attachment(&watching, &attachment).unwrap();

    assert_eq!(
        *watching.seen.lock().unwrap(),
        [AttachmentAvailabilityState::Downloading; 2]
    );
    assert_eq!(state(&b), AttachmentAvailabilityState::Downloaded);
}
