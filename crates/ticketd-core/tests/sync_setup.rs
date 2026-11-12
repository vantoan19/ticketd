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

fn retitle(workspace: &mut Workspace, reference: &str, title: &str) {
    workspace
        .change_ticket(
            reference,
            TicketPatch {
                title: Some(title.into()),
                ..Default::default()
            },
        )
        .unwrap();
}

fn unreadable(workspace: &Workspace) -> Vec<String> {
    workspace
        .sync_notices()
        .unwrap()
        .into_iter()
        .map(|notice| match notice.notice {
            SyncNoticeKind::UnreadableFile { path, .. } => path,
            other => format!("{other:?}"),
        })
        .collect()
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
    // Given up on, so it no longer counts as a download still to come (F35).
    assert_eq!(status.attachment_downloads.count, 0);
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

/// The fake storage, doing something of the test's each time Attachment
/// bytes are being fetched.
struct Hooked<'a> {
    remote: FakeRemote,
    during_download: Box<dyn Fn() + Send + Sync + 'a>,
    /// Called while the folder is being listed, which is after a run read
    /// what this Workspace stores about itself.
    during_listing: Option<Box<dyn Fn() + Send + Sync + 'a>>,
    /// Called when half the bytes have been handed over; says whether the
    /// rest follows.
    halfway: Option<Box<dyn Fn() -> bool + Send + Sync + 'a>>,
}

impl RemoteStorage for Hooked<'_> {
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
        if let Some(during_listing) = &self.during_listing {
            during_listing();
        }
        self.remote.list(folder)
    }

    fn download(
        &self,
        folder: &str,
        key: &RemoteKey,
        version: &str,
        output: &mut dyn std::io::Write,
    ) -> Result<(), RemoteError> {
        if key.kind != RemoteKind::Attachment {
            return self.remote.download(folder, key, version, output);
        }
        (self.during_download)();
        let Some(halfway) = &self.halfway else {
            return self.remote.download(folder, key, version, output);
        };
        let mut bytes = Vec::new();
        self.remote.download(folder, key, version, &mut bytes)?;
        let (first, rest) = bytes.split_at(bytes.len() / 2);
        output.write_all(first).unwrap();
        if halfway() {
            output.write_all(rest).unwrap();
        }
        Ok(())
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
    // A second connection looks at the Workspace while the bytes arrive.
    let seen = std::sync::Mutex::new(Vec::new());
    let watching = Hooked {
        remote: desks.remote.clone(),
        during_download: Box::new(|| {
            let other = Workspace::open(desks.directory.path().join("Desk B")).unwrap();
            let found = other
                .attachment_availability(std::slice::from_ref(&attachment))
                .unwrap();
            seen.lock().unwrap().push(found[0].state);
        }),
        halfway: None,
        during_listing: None,
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
        *seen.lock().unwrap(),
        [AttachmentAvailabilityState::Downloading; 2]
    );
    assert_eq!(state(&b), AttachmentAvailabilityState::Downloaded);
}

#[test]
fn the_host_reads_its_sync_destination_and_unread_count_without_a_status() {
    let desks = desks();
    let a = desks.desk("Desk A");
    assert_eq!(a.sync_binding().unwrap(), None);
    drop(a);

    let (mut a, reference, _) = desks.uploaded("Desk A");
    let binding = a.sync_binding().unwrap().unwrap();
    assert_eq!(
        (
            binding.folder_id,
            binding.connection_id.as_deref(),
            binding.device_name.as_str(),
            binding.poll_secs
        ),
        (desks.folder(), Some("connection-1"), "Desk A", 60)
    );

    // One record in conflict (however many fields) and one notice.
    let mut b = desks.joined("Desk B", AttachmentDownload::Automatic);
    b.sync_now(&desks.remote).unwrap();
    for (desk, title) in [(&mut a, "Sign in"), (&mut b, "Log on")] {
        desk.change_ticket(
            &reference,
            TicketPatch {
                title: Some(title.into()),
                body: Some(title.into()),
                ..Default::default()
            },
        )
        .unwrap();
    }
    a.sync_now(&desks.remote).unwrap();
    assert_eq!(b.sync_unread_count().unwrap(), 0);
    let stray = RemoteKey::new(RemoteKind::Ticket, "0c8f3a51-6f0e-4a0b-9d55-2f1f6f3f8a10");
    desks
        .remote
        .write(
            &desks.folder(),
            &stray,
            "stray.md",
            None,
            &mut Cursor::new(b"not a ticket"),
        )
        .unwrap();
    b.sync_now(&desks.remote).unwrap();

    assert_eq!(b.sync_unread_count().unwrap(), 2);
    let conflict = b.sync_conflicts().unwrap().remove(0).id;
    b.set_sync_read(&[conflict], true).unwrap();
    assert_eq!(b.sync_unread_count().unwrap(), 1);
}

#[test]
fn a_failure_with_no_state_of_its_own_needs_attention_until_a_run_succeeds() {
    let desks = desks();
    let (mut a, _, _) = desks.uploaded("Desk A");
    a.create_ticket("Saved meanwhile").unwrap();
    desks.remote.fail(
        RemoteOp::List,
        1,
        RemoteError::Other("the storage answered nonsense".into()),
    );

    let status = a.sync_now(&desks.remote).unwrap();

    assert_eq!(
        recovered(&status),
        (Some(SyncRecovery::Error), SyncState::NeedsAttention)
    );
    assert!(
        status
            .recovery_message
            .as_deref()
            .unwrap()
            .contains("the storage answered nonsense")
    );
    assert_eq!(SyncRecovery::Error.action(), SyncRecoveryAction::Retry);
    assert_eq!(status.pending_uploads.len(), 1);
    // What the desktop receives.
    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(json["recovery"], "error");
    assert!(json["recovery_message"].is_string());
    // A later launch finds it too.
    assert_eq!(a.sync_status().unwrap(), status);

    let status = a.sync_recover(&desks.remote).unwrap();
    assert_eq!(recovered(&status), (None, SyncState::Uploaded));
    assert_eq!(status.recovery_message, None);
}

#[test]
fn an_attachment_whose_bytes_are_gone_here_is_reported_and_holds_nothing_up() {
    let desks = desks();
    let (mut a, reference, _) = desks.uploaded("Desk A");
    let lost = a
        .import_attachment_bytes("request-2", "lost.txt", b"lost", |_, _| true)
        .unwrap()
        .id;
    let root = desks.directory.path().join("Desk A.attachments");
    std::fs::remove_dir_all(root.join(&lost)).unwrap();
    retitle(&mut a, &reference, "Sign in");

    let status = a.sync_now(&desks.remote).unwrap();

    // The run went through: the ticket is uploaded, the file is named once.
    assert_eq!(recovered(&status), (None, SyncState::NeedsAttention));
    assert_eq!((status.pending_uploads, status.pending_total), (vec![], 0));
    assert!(status.last_synced_at.is_some());
    assert_eq!(unreadable(&a), ["attachments/lost.txt"]);
    let listed = desks.remote.list(&desks.folder()).unwrap();
    assert!(
        listed
            .iter()
            .any(|file| file.name == format!("{reference} Sign in.md"))
    );
    a.sync_now(&desks.remote).unwrap();
    assert_eq!(unreadable(&a).len(), 1);
}

#[test]
fn an_attachment_that_cannot_be_saved_here_is_reported_and_records_still_sync() {
    let desks = desks();
    let (_a, _, attachment) = desks.uploaded("Desk A");
    let mut b = desks.joined("Desk B", AttachmentDownload::Automatic);
    // Something is in the way of where this Attachment's bytes go.
    let root = desks.directory.path().join("Desk B.attachments");
    std::fs::create_dir_all(root.join(&attachment).join("in the way")).unwrap();
    let state = |workspace: &Workspace| {
        workspace
            .attachment_availability(std::slice::from_ref(&attachment))
            .unwrap()[0]
            .state
    };

    let status = b.sync_now(&desks.remote).unwrap();

    assert_eq!(recovered(&status), (None, SyncState::NeedsAttention));
    assert!(status.last_synced_at.is_some());
    assert_eq!(titles(&b), ["Login"]);
    assert_eq!(unreadable(&b), ["attachments/notes.txt"]);
    assert_eq!(state(&b), AttachmentAvailabilityState::NotDownloaded);

    // With the way clear, the next run fetches it and withdraws the notice.
    std::fs::remove_dir_all(root.join(&attachment)).unwrap();
    b.sync_now(&desks.remote).unwrap();
    assert_eq!(state(&b), AttachmentAvailabilityState::Downloaded);
    assert_eq!(b.sync_notices().unwrap(), []);
}

#[test]
fn one_attachment_is_fetched_once_when_a_run_and_an_open_ask_for_it_together() {
    let desks = desks();
    let (_a, _, attachment) = desks.uploaded("Desk A");
    let mut b = desks.joined("Desk B", AttachmentDownload::OnOpen);
    b.sync_now(&desks.remote).unwrap();
    b.set_sync_settings("Desk B", 60, AttachmentDownload::Automatic)
        .unwrap();
    let path = desks.directory.path().join("Desk B");
    let downloads = |remote: &FakeRemote| {
        remote
            .calls()
            .into_iter()
            .filter(|op| *op == RemoteOp::Download)
            .count()
    };
    let before = downloads(&desks.remote);

    // While the person's open is fetching the bytes, a scheduled run starts on
    // another connection, and a second open waits on a third.
    let waiting = std::sync::Mutex::new(None);
    let racing = Hooked {
        remote: desks.remote.clone(),
        during_download: Box::new(|| {
            let scheduled = Workspace::open(&path)
                .unwrap()
                .sync_now(&desks.remote)
                .unwrap();
            assert_eq!(scheduled.recovery, None);
            let (path, remote, id) = (path.clone(), desks.remote.clone(), attachment.clone());
            *waiting.lock().unwrap() = Some(std::thread::spawn(move || {
                Workspace::open(path)
                    .unwrap()
                    .download_attachment(&remote, &id)
            }));
            // Lets the second open find the download under way; it must pass either way.
            std::thread::sleep(std::time::Duration::from_millis(200));
        }),
        halfway: None,
        during_listing: None,
    };
    b.download_attachment(&racing, &attachment).unwrap();
    let second = waiting.lock().unwrap().take().unwrap().join().unwrap();

    second.unwrap();
    assert_eq!(downloads(&desks.remote) - before, 1);
    assert_eq!(
        std::fs::read(b.attachment_open_path(&attachment).unwrap()).unwrap(),
        BYTES
    );
    assert_eq!(b.sync_notices().unwrap(), []);
}

#[test]
fn a_download_cut_off_by_the_app_closing_is_taken_up_after_the_launch_reset() {
    let desks = desks();
    let (_a, _, attachment) = desks.uploaded("Desk A");
    let mut b = desks.joined("Desk B", AttachmentDownload::OnOpen);
    b.sync_now(&desks.remote).unwrap();
    b.set_sync_settings("Desk B", 60, AttachmentDownload::Automatic)
        .unwrap();
    // What a download leaves when the app stops in the middle of it.
    rusqlite::Connection::open(desks.directory.path().join("Desk B"))
        .unwrap()
        .execute("UPDATE sync_attachments SET state = 'downloading'", [])
        .unwrap();
    let state = |workspace: &Workspace| {
        workspace
            .attachment_availability(std::slice::from_ref(&attachment))
            .unwrap()[0]
            .state
    };

    // A run leaves a download alone that another connection may own.
    b.sync_now(&desks.remote).unwrap();
    assert_eq!(state(&b), AttachmentAvailabilityState::Downloading);

    b.reset_interrupted_downloads().unwrap();
    b.sync_now(&desks.remote).unwrap();
    assert_eq!(state(&b), AttachmentAvailabilityState::Downloaded);
}

#[test]
fn renaming_an_attachment_that_is_not_downloaded_here_reaches_the_other_desks() {
    let desks = desks();
    let (mut a, reference, attachment) = desks.uploaded("Desk A");
    let mut b = desks.joined("Desk B", AttachmentDownload::OnOpen);
    b.sync_now(&desks.remote).unwrap();

    b.rename_attachment(&attachment, "meeting notes.txt")
        .unwrap();
    b.sync_now(&desks.remote).unwrap();
    a.sync_now(&desks.remote).unwrap();

    for desk in [&a, &b] {
        assert_eq!(
            desk.ticket_attachments(&reference).unwrap()[0].display_name,
            "meeting notes.txt"
        );
    }
    assert_eq!(b.dirty_records().unwrap(), []);
}

#[test]
fn restoring_a_backup_disconnects_sync_until_upload_or_download_is_chosen_again() {
    let desks = desks();
    let (mut a, _, _) = desks.uploaded("Desk A");
    let path = desks.directory.path().join("Desk A");
    let backup = desks.directory.path().join("backup.sqlite3");
    a.backup(&backup).unwrap();
    a.create_ticket("After the backup").unwrap();
    a.sync_now(&desks.remote).unwrap();
    drop(a);

    Workspace::restore(&path, &backup).unwrap();
    let mut a = Workspace::open(&path).unwrap();

    // Signed in still, but no folder: a run cannot quietly bring back what
    // the restore went back on.
    let status = a.sync_status().unwrap();
    assert_eq!(
        (status.connection, status.folder),
        (SyncConnection::Choosing, None)
    );
    assert_eq!(a.sync_binding().unwrap(), None);
    assert!(matches!(a.sync_now(&desks.remote), Err(Error::Sync(_))));
    assert_eq!(titles(&a), ["Login"]);

    // Choosing to upload merges with the folder as a first sync does.
    a.sync_upload_workspace(&desks.remote, "ticketd Home")
        .unwrap();
    let status = a.sync_now(&desks.remote).unwrap();
    assert_eq!(recovered(&status), (None, SyncState::Uploaded));
    let mut restored = titles(&a);
    restored.sort();
    assert_eq!(restored, ["After the backup", "Login"]);
}

#[test]
fn a_run_that_changes_nothing_leaves_the_change_token_and_a_long_queue_is_paged() {
    let desks = desks();
    let (mut a, _, _) = desks.uploaded("Desk A");
    a.sync_now(&desks.remote).unwrap();
    let token = a.change_token().unwrap();

    a.sync_now(&desks.remote).unwrap();
    assert_eq!(a.change_token().unwrap(), token);

    for number in 0..60 {
        a.create_ticket(&format!("Ticket {number}")).unwrap();
    }
    let status = a.sync_status().unwrap();
    assert_eq!(status.state, SyncState::UploadPending);
    assert_eq!(
        (status.pending_uploads.len(), status.pending_total),
        (50, 60)
    );
    assert_eq!(status.pending_uploads[0].title, "Ticket 0");
}

#[test]
fn a_device_code_given_up_stays_in_the_registry_and_is_not_taken_by_a_desk_joining() {
    let desks = desks();
    let (mut a, _, _) = desks.uploaded("Desk A");
    let registry = RemoteKey::new(RemoteKind::Devices, "devices");
    let first = a.device_code().unwrap();
    a.renew_device_code().unwrap();
    a.sync_now(&desks.remote).unwrap();

    let (version, stored) = desks.file(&registry);
    let stored: serde_json::Value = serde_json::from_slice(&stored).unwrap();
    assert_eq!(stored["retired"], serde_json::json!([first]));

    // A desk joining with a code that was given up takes another.
    let mut b = desks.joined("Desk B", AttachmentDownload::Automatic);
    let joining = b.device_code().unwrap();
    let mut edited = stored.clone();
    edited["retired"] = serde_json::json!([first, joining]);
    desks
        .remote
        .write(
            &desks.folder(),
            &registry,
            "devices.json",
            Some(&version),
            &mut Cursor::new(serde_json::to_vec(&edited).unwrap()),
        )
        .unwrap();
    b.sync_now(&desks.remote).unwrap();

    assert_ne!(b.device_code().unwrap(), joining);
    assert_ne!(b.device_code().unwrap(), first);
}

#[test]
fn a_shared_file_from_a_newer_ticketd_stops_the_run_and_is_not_rewritten() {
    let desks = desks();
    let (mut a, _, _) = desks.uploaded("Desk A");
    let registry = RemoteKey::new(RemoteKind::Devices, "devices");
    let (version, stored) = desks.file(&registry);
    let mut newer: serde_json::Value = serde_json::from_slice(&stored).unwrap();
    assert_eq!(newer["format"], 1);
    // An entry this version does not know survives a rewrite by this version.
    newer["settings"] = serde_json::json!({ "shared": true });
    let write = |value: &serde_json::Value, expected: &str| {
        desks
            .remote
            .write(
                &desks.folder(),
                &registry,
                "devices.json",
                Some(expected),
                &mut Cursor::new(serde_json::to_vec(value).unwrap()),
            )
            .unwrap()
            .version
    };
    let version = write(&newer, &version);
    a.set_sync_settings("Studio", 60, AttachmentDownload::Automatic)
        .unwrap();
    a.sync_now(&desks.remote).unwrap();
    let (rewritten, stored) = desks.file(&registry);
    assert_ne!(rewritten, version);
    let stored: serde_json::Value = serde_json::from_slice(&stored).unwrap();
    assert_eq!(stored["settings"]["shared"], true);

    // A higher format is not this version's to rewrite at all.
    let mut newer = stored;
    newer["format"] = 2.into();
    let version = write(&newer, &rewritten);
    a.set_sync_settings("Den", 60, AttachmentDownload::Automatic)
        .unwrap();
    let status = a.sync_now(&desks.remote).unwrap();

    assert_eq!(
        recovered(&status),
        (Some(SyncRecovery::Error), SyncState::NeedsAttention)
    );
    assert!(status.recovery_message.unwrap().contains("newer ticketd"));
    assert_eq!(desks.file(&registry).0, version);
}

#[test]
fn an_attachment_upload_whose_answer_is_lost_repeats_without_a_second_copy() {
    let desks = desks();
    let (mut a, reference, _) = desks.uploaded("Desk A");
    let extra = a
        .import_attachment_bytes("request-2", "more.txt", b"more", |_, _| true)
        .unwrap()
        .id;
    a.set_ticket_attachment(&reference, &extra, true).unwrap();
    let key = RemoteKey::new(RemoteKind::Attachment, extra.clone());

    // The bytes reach the storage, the answer does not; the next run stops
    // before it starts.
    desks.remote.drop_write(1, RemoteError::Offline);
    let status = a.sync_now(&desks.remote).unwrap();
    assert_eq!(
        recovered(&status),
        (Some(SyncRecovery::Offline), SyncState::SavedLocally)
    );
    assert!(status.pending_uploads.iter().any(|item| item.id == extra));
    desks.remote.fail(
        RemoteOp::List,
        1,
        RemoteError::RateLimited { retry_after: None },
    );
    a.sync_now(&desks.remote).unwrap();

    let status = a.sync_now(&desks.remote).unwrap();

    assert_eq!(recovered(&status), (None, SyncState::Uploaded));
    assert_eq!(
        desks.remote.revisions(&desks.folder(), &key).unwrap().len(),
        1
    );
    let mut b = desks.joined("Desk B", AttachmentDownload::Automatic);
    b.sync_now(&desks.remote).unwrap();
    assert_eq!(b.ticket_attachments(&reference).unwrap().len(), 2);
    assert_eq!(
        std::fs::read(b.attachment_open_path(&extra).unwrap()).unwrap(),
        b"more"
    );
}

fn registered(desks: &Desks) -> serde_json::Value {
    let (_, stored) = desks.file(&RemoteKey::new(RemoteKind::Devices, "devices"));
    serde_json::from_slice(&stored).unwrap()
}

#[test]
fn a_workspace_file_copied_to_another_desktop_joins_as_a_desktop_of_its_own() {
    let desks = desks();
    let mut a = desks.desk("Desk A");
    a.create_ticket("Login").unwrap();
    a.sync_upload_workspace(&desks.remote, "ticketd Home")
        .unwrap();
    a.sync_now(&desks.remote).unwrap();
    drop(a);
    let path = |name: &str| desks.directory.path().join(name);
    std::fs::copy(path("Desk A"), path("Desk C")).unwrap();
    let mut a = Workspace::open(path("Desk A")).unwrap();
    let mut copy = Workspace::open(path("Desk C")).unwrap();
    let shared = a.device_code().unwrap();
    assert_eq!(copy.device_code().unwrap(), shared);
    // The app is launched on the copy.
    copy.start_sync_session().unwrap();

    // Whichever of the two runs after the other has synced is the one that
    // finds out and gives way.
    copy.sync_now(&desks.remote).unwrap();
    a.sync_now(&desks.remote).unwrap();
    copy.sync_now(&desks.remote).unwrap();

    let codes = [a.device_code().unwrap(), copy.device_code().unwrap()];
    assert_ne!(codes[0], codes[1]);
    assert!(codes.contains(&shared), "{codes:?}");
    let registry = registered(&desks);
    assert_eq!(registry["devices"].as_object().unwrap().len(), 2);
    // The code both held is still in use, so it is not given up.
    assert_eq!(registry.get("retired"), None);

    let from_a = a.create_ticket("From A").unwrap().reference;
    let from_copy = copy.create_ticket("From the copy").unwrap().reference;
    assert_ne!(from_a, from_copy);
    a.sync_now(&desks.remote).unwrap();
    for desk in [&mut copy, &mut a] {
        let status = desk.sync_now(&desks.remote).unwrap();
        assert_eq!(status.state, SyncState::Uploaded);
    }
    for desk in [&a, &copy] {
        let mut all = titles(desk);
        all.sort();
        assert_eq!(all, ["From A", "From the copy", "Login"]);
        assert_eq!(desk.show_ticket("T-KQ1").unwrap().title, "Login");
    }
    // Neither changes again once they are apart.
    assert_eq!(
        codes,
        [a.device_code().unwrap(), copy.device_code().unwrap()]
    );
    assert_eq!(registered(&desks)["devices"].as_object().unwrap().len(), 2);
}

#[test]
fn a_desktop_that_synced_before_run_tokens_existed_keeps_its_identity() {
    let desks = desks();
    let mut a = desks.desk("Desk A");
    a.create_ticket("Login").unwrap();
    a.sync_upload_workspace(&desks.remote, "ticketd Home")
        .unwrap();
    a.sync_now(&desks.remote).unwrap();
    let code = a.device_code().unwrap();

    // What an earlier ticketd left: no run token here or in the registry.
    rusqlite::Connection::open(desks.directory.path().join("Desk A"))
        .unwrap()
        .execute(
            "UPDATE sync_state SET run_token = NULL, run_previous = NULL, run_due = 1",
            [],
        )
        .unwrap();
    let key = RemoteKey::new(RemoteKind::Devices, "devices");
    let (version, _) = desks.file(&key);
    let mut earlier = registered(&desks);
    for device in earlier["devices"].as_object_mut().unwrap().values_mut() {
        device.as_object_mut().unwrap().remove("run");
    }
    desks
        .remote
        .write(
            &desks.folder(),
            &key,
            "devices.json",
            Some(&version),
            &mut Cursor::new(serde_json::to_vec(&earlier).unwrap()),
        )
        .unwrap();
    a.sync_now(&desks.remote).unwrap();
    a.sync_now(&desks.remote).unwrap();

    assert_eq!(a.device_code().unwrap(), code);
    let registry = registered(&desks);
    assert_eq!(registry["devices"].as_object().unwrap().len(), 1);
}

#[test]
fn a_record_held_back_by_a_newer_format_file_is_not_a_pending_upload_and_is_put_back_if_the_file_goes()
 {
    let desks = desks();
    let (mut a, reference, _) = desks.uploaded("Desk A");
    let key = RemoteKey::new(RemoteKind::Ticket, a.show_ticket(&reference).unwrap().id);
    let (version, synced) = desks.file(&key);
    let newer = String::from_utf8(synced)
        .unwrap()
        .replacen("format: 1\n", "format: 2\n", 1);
    desks
        .remote
        .write(
            &desks.folder(),
            &key,
            "Login.md",
            Some(&version),
            &mut Cursor::new(newer.as_bytes()),
        )
        .unwrap();
    // A second file, so the folder is not taken for an emptied one later.
    a.create_ticket("Other").unwrap();
    a.sync_now(&desks.remote).unwrap();
    retitle(&mut a, &reference, "Changed here");

    let status = a.sync_now(&desks.remote).unwrap();

    // Nothing this desktop can send: it is told as a file it cannot read.
    assert_eq!((status.pending_uploads.len(), status.pending_total), (0, 0));
    assert_eq!(status.state, SyncState::NeedsAttention);
    assert_eq!(unreadable(&a).len(), 1);
    assert_eq!(desks.file(&key).1, newer.as_bytes());

    // With the file gone there is nothing left to protect.
    desks.remote.remove_file(&desks.folder(), &key);
    let status = a.sync_now(&desks.remote).unwrap();
    assert_eq!(status.pending_total, 0);
    let restored = String::from_utf8(desks.file(&key).1).unwrap();
    assert!(restored.contains("Changed here"), "{restored}");
}

fn availability_of(workspace: &Workspace, attachment: &str) -> AttachmentAvailabilityState {
    workspace
        .attachment_availability(&[attachment.to_owned()])
        .unwrap()[0]
        .state
}

#[test]
fn a_passing_storage_failure_during_an_attachment_download_fails_the_run_and_leaves_no_notice() {
    let desks = desks();
    let (_a, _, attachment) = desks.uploaded("Desk A");
    let mut b = desks.joined("Desk B", AttachmentDownload::OnOpen);
    b.sync_now(&desks.remote).unwrap();
    b.set_sync_settings("Desk B", 60, AttachmentDownload::Automatic)
        .unwrap();

    // The storage answers with a failure of its own.
    desks.remote.fail(
        RemoteOp::Download,
        1,
        RemoteError::Other("the storage answered 503".into()),
    );
    let status = b.sync_now(&desks.remote).unwrap();
    assert_eq!(
        recovered(&status),
        (Some(SyncRecovery::Error), SyncState::NeedsAttention)
    );

    // The transfer ends before all the bytes arrived.
    let cut = Hooked {
        remote: desks.remote.clone(),
        during_download: Box::new(|| {}),
        halfway: Some(Box::new(|| false)),
        during_listing: None,
    };
    let status = b.sync_now(&cut).unwrap();
    assert_eq!(
        recovered(&status),
        (Some(SyncRecovery::Error), SyncState::NeedsAttention)
    );
    assert_eq!(
        availability_of(&b, &attachment),
        AttachmentAvailabilityState::NotDownloaded
    );

    // Neither is a fault of the file: the next run fetches it, and nothing is left to read.
    let status = b.sync_now(&desks.remote).unwrap();
    assert_eq!(recovered(&status), (None, SyncState::Uploaded));
    assert_eq!(
        availability_of(&b, &attachment),
        AttachmentAvailabilityState::Downloaded
    );
    assert_eq!(b.sync_notices().unwrap(), []);
}

#[test]
fn an_attachment_folder_that_cannot_be_made_here_is_reported() {
    let desks = desks();
    let (_a, _, attachment) = desks.uploaded("Desk A");
    let mut b = desks.joined("Desk B", AttachmentDownload::Automatic);
    // A file sits where this Workspace keeps its Attachments.
    let root = desks.directory.path().join("Desk B.attachments");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::write(&root, "in the way").unwrap();

    let status = b.sync_now(&desks.remote).unwrap();

    assert_eq!(recovered(&status), (None, SyncState::NeedsAttention));
    assert_eq!(unreadable(&b), ["attachments/notes.txt"]);

    std::fs::remove_file(&root).unwrap();
    b.sync_now(&desks.remote).unwrap();
    assert_eq!(
        availability_of(&b, &attachment),
        AttachmentAvailabilityState::Downloaded
    );
}

#[test]
fn a_download_under_way_in_a_backup_or_at_disconnect_does_not_stay_under_way() {
    let desks = desks();
    let (_a, _, attachment) = desks.uploaded("Desk A");
    let mut b = desks.joined("Desk B", AttachmentDownload::OnOpen);
    b.sync_now(&desks.remote).unwrap();
    let path = desks.directory.path().join("Desk B");
    let under_way = || {
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute("UPDATE sync_attachments SET state = 'downloading'", [])
            .unwrap();
    };

    under_way();
    b.sync_disconnect().unwrap();
    assert_eq!(
        availability_of(&b, &attachment),
        AttachmentAvailabilityState::NotDownloaded
    );

    under_way();
    let backup = desks.directory.path().join("backup.sqlite3");
    b.backup(&backup).unwrap();
    drop(b);
    Workspace::restore(&path, &backup).unwrap();
    let b = Workspace::open(&path).unwrap();
    assert_eq!(
        availability_of(&b, &attachment),
        AttachmentAvailabilityState::NotDownloaded
    );
}

#[test]
fn a_slow_download_shows_it_is_moving_well_before_a_megabyte_arrived() {
    let desks = desks();
    let mut a = desks.desk("Desk A");
    let reference = a.create_ticket("Login").unwrap().reference;
    let large = vec![7_u8; 200 * 1024];
    let attachment = a
        .import_attachment_bytes("request-1", "large.bin", &large, |_, _| true)
        .unwrap()
        .id;
    a.set_ticket_attachment(&reference, &attachment, true)
        .unwrap();
    a.sync_upload_workspace(&desks.remote, "ticketd Home")
        .unwrap();
    a.sync_now(&desks.remote).unwrap();
    let mut b = desks.joined("Desk B", AttachmentDownload::OnOpen);
    b.sync_now(&desks.remote).unwrap();

    // What an open waiting on another connection goes by.
    let seen = std::sync::Mutex::new(None);
    let slow = Hooked {
        remote: desks.remote.clone(),
        during_download: Box::new(|| {}),
        during_listing: None,
        halfway: Some(Box::new(|| {
            let other = Workspace::open(desks.directory.path().join("Desk B")).unwrap();
            let found = other
                .attachment_availability(std::slice::from_ref(&attachment))
                .unwrap();
            *seen.lock().unwrap() = found[0].progress;
            true
        })),
    };
    b.download_attachment(&slow, &attachment).unwrap();

    let progress = seen.lock().unwrap().unwrap();
    assert!((1..=50).contains(&progress), "{progress}");
}

#[test]
fn tickets_made_on_both_copies_before_the_copy_is_detected_are_reported_not_merged() {
    let desks = desks();
    let mut a = desks.desk("Desk A");
    a.create_ticket("Login").unwrap();
    a.sync_upload_workspace(&desks.remote, "ticketd Home")
        .unwrap();
    a.sync_now(&desks.remote).unwrap();
    drop(a);
    let path = |name: &str| desks.directory.path().join(name);
    std::fs::copy(path("Desk A"), path("Desk C")).unwrap();
    let mut a = Workspace::open(path("Desk A")).unwrap();
    let mut copy = Workspace::open(path("Desk C")).unwrap();
    copy.start_sync_session().unwrap();
    let from_a = a.create_ticket("From A").unwrap().reference;
    let from_copy = copy.create_ticket("From the copy").unwrap().reference;
    assert_eq!(from_a, from_copy);

    a.sync_now(&desks.remote).unwrap();
    copy.sync_now(&desks.remote).unwrap();
    a.sync_now(&desks.remote).unwrap();

    assert_eq!(a.show_ticket(&from_a).unwrap().title, "From A");
    assert_eq!(copy.show_ticket(&from_a).unwrap().title, "From the copy");
    for desk in [&a, &copy] {
        assert_eq!(titles(desk).len(), 2);
        assert_eq!(unreadable(desk).len(), 1);
    }
    assert_ne!(a.device_code().unwrap(), copy.device_code().unwrap());
}

#[test]
fn runs_with_nothing_to_send_write_nothing_after_the_first_of_an_app_session() {
    let desks = desks();
    let (mut a, _, _) = desks.uploaded("Desk A");
    let writes = |desks: &Desks| {
        desks
            .remote
            .calls()
            .into_iter()
            .filter(|op| *op == RemoteOp::Write)
            .count()
    };

    let before = writes(&desks);
    for _ in 0..3 {
        a.sync_now(&desks.remote).unwrap();
    }
    assert_eq!(writes(&desks), before);

    // The next launch writes this desk's run token once.
    let token = registered(&desks)["devices"].clone();
    a.start_sync_session().unwrap();
    for _ in 0..3 {
        a.sync_now(&desks.remote).unwrap();
    }
    assert_eq!(writes(&desks), before + 1);
    assert_ne!(registered(&desks)["devices"], token);
}

fn identity(desks: &Desks, desk: &Workspace) -> (Vec<String>, String) {
    let devices = registered(desks)["devices"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    (devices, desk.device_code().unwrap())
}

#[test]
fn a_run_token_write_that_fails_or_whose_answer_is_lost_does_not_make_a_desktop_a_copy() {
    let desks = desks();
    let (mut a, _, _) = desks.uploaded("Desk A");
    let before = identity(&desks, &a);
    assert_eq!(before.0.len(), 1);

    // The write arrives, its answer does not.
    a.start_sync_session().unwrap();
    desks.remote.drop_write(1, RemoteError::Offline);
    let status = a.sync_now(&desks.remote).unwrap();
    assert_eq!(status.recovery, Some(SyncRecovery::Offline));
    assert_eq!(a.sync_now(&desks.remote).unwrap().recovery, None);
    assert_eq!(identity(&desks, &a), before);

    // The write does not arrive.
    a.start_sync_session().unwrap();
    desks.remote.fail(RemoteOp::Write, 1, RemoteError::Offline);
    let status = a.sync_now(&desks.remote).unwrap();
    assert_eq!(status.recovery, Some(SyncRecovery::Offline));
    assert_eq!(a.sync_now(&desks.remote).unwrap().recovery, None);
    assert_eq!(a.sync_now(&desks.remote).unwrap().recovery, None);
    assert_eq!(identity(&desks, &a), before);
}

#[test]
fn two_processes_on_one_workspace_file_starting_together_stay_one_desktop() {
    let desks = desks();
    let (mut a, _, _) = desks.uploaded("Desk A");
    let before = identity(&desks, &a);
    a.start_sync_session().unwrap();
    // A second process runs its first sync between this run reading what the
    // Workspace stores and reading the registry.
    let once = std::sync::atomic::AtomicBool::new(false);
    let overlapping = Hooked {
        remote: desks.remote.clone(),
        during_download: Box::new(|| {}),
        halfway: None,
        during_listing: Some(Box::new(|| {
            if !once.swap(true, std::sync::atomic::Ordering::SeqCst) {
                let mut other = Workspace::open(desks.directory.path().join("Desk A")).unwrap();
                assert_eq!(other.sync_now(&desks.remote).unwrap().recovery, None);
            }
        })),
    };

    assert_eq!(a.sync_now(&overlapping).unwrap().recovery, None);
    assert_eq!(a.sync_now(&desks.remote).unwrap().recovery, None);

    assert_eq!(identity(&desks, &a), before);
}

#[test]
fn an_attachment_download_that_keeps_failing_becomes_a_notice_and_runs_succeed_again() {
    let desks = desks();
    let (_a, _, attachment) = desks.uploaded("Desk A");
    let mut b = desks.joined("Desk B", AttachmentDownload::OnOpen);
    b.sync_now(&desks.remote).unwrap();
    b.set_sync_settings("Desk B", 60, AttachmentDownload::Automatic)
        .unwrap();
    let refuse = || {
        desks.remote.fail(
            RemoteOp::Download,
            1,
            RemoteError::Other("the storage refuses this file".into()),
        );
    };

    // The first failures may pass, so they fail the run, naming the Attachment.
    for _ in 0..2 {
        refuse();
        let status = b.sync_now(&desks.remote).unwrap();
        assert_eq!(status.recovery, Some(SyncRecovery::Error));
        let message = status.recovery_message.unwrap();
        assert!(message.contains("notes.txt"), "{message}");
        assert_eq!(b.sync_notices().unwrap(), []);
    }

    // The third is this one file's trouble: told once, and the run succeeds.
    refuse();
    let status = b.sync_now(&desks.remote).unwrap();
    assert_eq!(recovered(&status), (None, SyncState::NeedsAttention));
    assert!(status.last_synced_at.is_some());
    assert_eq!(unreadable(&b), ["attachments/notes.txt"]);

    // Runs leave it alone from here on.
    let before = desks.remote.calls().len();
    let status = b.sync_now(&desks.remote).unwrap();
    assert_eq!(status.recovery, None);
    assert_eq!(status.attachment_downloads.count, 0);
    assert!(!desks.remote.calls()[before..].contains(&RemoteOp::Download));

    // Asking for it still tries, and a success is a success.
    b.download_attachment(&desks.remote, &attachment).unwrap();
    assert_eq!(
        availability_of(&b, &attachment),
        AttachmentAvailabilityState::Downloaded
    );
    // Its failure is no longer true, so the notice is withdrawn (F35).
    assert_eq!(b.sync_notices().unwrap(), []);
}

/// F40: format 61 was in use before `sync_attachments.attempts` joined it, so a
/// Workspace at 61 can lack the column. Format 62 adds it.
#[test]
fn a_format_61_workspace_without_download_attempts_gains_the_column() {
    let desks = desks();
    let (desk, _, _) = desks.uploaded("a");
    drop(desk);
    let path = desks.directory.path().join("a");
    let fixture = rusqlite::Connection::open(&path).unwrap();
    fixture
        .execute_batch(
            "ALTER TABLE sync_attachments DROP COLUMN attempts; PRAGMA user_version = 61;",
        )
        .unwrap();
    drop(fixture);

    let mut desk = Workspace::open(&path).unwrap();
    desk.sync_now(&desks.remote).unwrap();
    drop(desk);
    let migrated = rusqlite::Connection::open(&path).unwrap();
    let attempts: i64 = migrated
        .query_row(
            "SELECT COALESCE(SUM(attempts), 0) FROM sync_attachments",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(attempts, 0);
}

/// F42: bytes that arrive but cannot be saved on this device (a full disk,
/// something in the way) must not be fetched again by every run.
#[test]
fn an_attachment_that_cannot_be_saved_here_is_not_downloaded_again_by_every_run() {
    let desks = desks();
    let (_a, _, attachment) = desks.uploaded("Desk A");
    let mut b = desks.joined("Desk B", AttachmentDownload::OnOpen);
    b.sync_now(&desks.remote).unwrap();
    // Something else sits where the Attachment's files go.
    let taken = desks
        .directory
        .path()
        .join("Desk B.attachments")
        .join(&attachment);
    std::fs::create_dir_all(taken.join("in the way")).unwrap();
    b.set_sync_settings("Desk B", 60, AttachmentDownload::Automatic)
        .unwrap();
    let downloads = |b: &mut Workspace| {
        let before = desks.remote.calls().len();
        let status = b.sync_now(&desks.remote).unwrap();
        let fetched = desks.remote.calls()[before..]
            .iter()
            .filter(|op| **op == RemoteOp::Download)
            .count();
        (fetched, status)
    };

    let tried: usize = (0..5).map(|_| downloads(&mut b).0).sum();
    assert_eq!(tried, 3);
    let (fetched, status) = downloads(&mut b);
    assert_eq!(fetched, 0);
    assert_eq!(status.attachment_downloads.count, 0);
    assert_eq!(unreadable(&b), ["attachments/notes.txt"]);

    // With the way clear, asking for it fetches it and withdraws the notice.
    std::fs::remove_dir_all(&taken).unwrap();
    b.download_attachment(&desks.remote, &attachment).unwrap();
    assert_eq!(
        availability_of(&b, &attachment),
        AttachmentAvailabilityState::Downloaded
    );
    assert_eq!(b.sync_notices().unwrap(), []);
}
