//! Desktops as the app sets them up: signed in to one fake storage account
//! and bound to a Workspace folder by an upload or a download, then run only
//! through `Workspace::sync_now`. Shared by the sync test suites.
#![allow(dead_code, clippy::unwrap_used)] // Each suite uses some of it; setup that fails must fail the test.

use std::sync::atomic::{AtomicUsize, Ordering};

use std::collections::BTreeMap;

use ticketd_core::{
    TicketPatch, Workspace,
    sync::{
        AttachmentDownload, SyncStatus,
        remote::{FakeRemote, RemoteKey, RemoteKind, RemoteStorage},
    },
};

pub const BYTES: &[u8] = b"the bytes of the attached file";

pub struct Desks {
    pub directory: tempfile::TempDir,
    pub remote: FakeRemote,
}

pub fn desks() -> Desks {
    Desks {
        directory: tempfile::tempdir().unwrap(),
        remote: FakeRemote::new(),
    }
}

impl Desks {
    /// A Workspace signed in to the storage under a desktop name.
    pub fn desk(&self, name: &str) -> Workspace {
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
    pub fn uploaded(&self, name: &str) -> (Workspace, String, String) {
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
    pub fn joined(&self, name: &str, mode: AttachmentDownload) -> Workspace {
        let mut desk = self.desk(name);
        desk.set_sync_settings(name, 60, mode).unwrap();
        let folder = self.folder();
        desk.sync_download_workspace(&self.remote, &folder)
            .unwrap()
            .0
    }

    /// A new handle on the Workspace file of `name`, as when the app is
    /// launched again (or runs in a second process). Sync begins its app
    /// session once for each path a process runs it on, so the handle is made
    /// under a hard link of the file that no run has used.
    pub fn launched_again(&self, name: &str) -> Workspace {
        static LAUNCHES: AtomicUsize = AtomicUsize::new(0);
        let launch = LAUNCHES.fetch_add(1, Ordering::SeqCst);
        let alias = self
            .directory
            .path()
            .join(format!("{name} (launch {launch})"));
        std::fs::hard_link(self.directory.path().join(name), &alias).unwrap();
        Workspace::open(alias).unwrap()
    }

    pub fn folder(&self) -> String {
        self.remote.folders().unwrap()[0].id.clone()
    }

    pub fn file(&self, key: &RemoteKey) -> (String, Vec<u8>) {
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

/// Several desktops syncing one storage folder: the first uploaded its
/// Workspace, the others replaced theirs with it. Each has their own device
/// code and has run once, as the app does at launch.
pub struct Devices {
    pub desks: Desks,
    pub remote: FakeRemote,
    /// The Workspace folder of the storage they all sync with.
    pub folder: String,
    pub names: Vec<String>,
    pub workspaces: Vec<Workspace>,
}

/// What one run of a desktop did, as far as its status and the storage show.
pub struct Run {
    pub status: SyncStatus,
    /// Record files that are new in the storage or have a new version there.
    pub uploaded: usize,
    /// Notices about files that could not be read or were too large, new in this run.
    pub skipped: usize,
    /// Fields newly waiting for review.
    pub conflicts: usize,
    /// Records still waiting to upload after the run.
    pub pending: usize,
}

fn review_fields(workspace: &Workspace) -> usize {
    workspace
        .sync_conflicts()
        .unwrap()
        .iter()
        .map(|conflict| conflict.fields.len())
        .sum()
}

impl Devices {
    pub fn new(names: &[&str]) -> Self {
        let desks = desks();
        let mut first = desks.desk(names[0]);
        first.sync_upload_workspace(&desks.remote, "Test").unwrap();
        let mut workspaces = vec![first];
        for name in &names[1..] {
            workspaces.push(desks.joined(name, AttachmentDownload::Automatic));
        }
        for index in 1..workspaces.len() {
            while workspaces[..index].iter().any(|other| {
                other.device_code().unwrap() == workspaces[index].device_code().unwrap()
            }) {
                workspaces[index].renew_device_code().unwrap();
            }
        }
        let mut devices = Self {
            remote: desks.remote.clone(),
            folder: desks.folder(),
            desks,
            names: names.iter().map(|name| (*name).to_owned()).collect(),
            workspaces,
        };
        for device in 0..names.len() {
            devices.sync(device);
        }
        devices
    }

    /// The version of each record file in the storage, looked at without a call.
    pub fn versions(&self) -> BTreeMap<RemoteKey, String> {
        self.remote
            .stored_versions(&self.folder)
            .into_iter()
            .filter(|(key, _)| !matches!(key.kind, RemoteKind::Devices | RemoteKind::Attachment))
            .collect()
    }

    /// One run, which must not end in a recovery state.
    pub fn sync(&mut self, device: usize) -> Run {
        let run = self.try_sync(device);
        assert_eq!(run.status.recovery, None, "{}", self.names[device]);
        run
    }

    /// One run, whatever its outcome.
    pub fn try_sync(&mut self, device: usize) -> Run {
        let before = (
            self.versions(),
            self.workspaces[device].sync_notices().unwrap().len(),
            review_fields(&self.workspaces[device]),
        );
        let status = self.workspaces[device].sync_now(&self.remote).unwrap();
        assert!(!status.run_in_progress, "{}", self.names[device]);
        let after = self.versions();
        let workspace = &self.workspaces[device];
        Run {
            uploaded: after
                .iter()
                .filter(|(key, version)| before.0.get(*key) != Some(*version))
                .count(),
            skipped: workspace
                .sync_notices()
                .unwrap()
                .len()
                .saturating_sub(before.1),
            conflicts: review_fields(workspace).saturating_sub(before.2),
            pending: status.pending_total as usize,
            status,
        }
    }
}
