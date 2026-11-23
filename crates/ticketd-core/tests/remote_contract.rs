//! One contract for every remote file storage: the in-memory fake and the
//! Google Drive adapter on the controlled transport must behave alike.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Test helpers fail the test.
use std::io::Cursor;

use ticketd_core::drive::DriveRemote;
use ticketd_core::sync::remote::*;

#[path = "support/drive_sim.rs"]
mod drive_sim;
use drive_sim::{DriveSim, Vault};

fn put(
    remote: &dyn RemoteStorage,
    folder: &str,
    key: &RemoteKey,
    name: &str,
    expected: Option<&str>,
    bytes: &[u8],
) -> Result<RemoteFile, RemoteError> {
    remote.write(folder, key, name, expected, &mut Cursor::new(bytes))
}

fn get(remote: &dyn RemoteStorage, folder: &str, key: &RemoteKey, version: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    remote.download(folder, key, version, &mut bytes).unwrap();
    bytes
}

fn new_folder(remote: &dyn RemoteStorage, name: &str) -> String {
    let folder = uuid::Uuid::new_v4().to_string();
    remote.ensure_folder(&folder, name).unwrap();
    folder
}

fn ticket() -> RemoteKey {
    RemoteKey::new(RemoteKind::Ticket, uuid::Uuid::new_v4().to_string())
}

fn folders_are_found_created_once_and_required(a: &dyn RemoteStorage, b: &dyn RemoteStorage) {
    let folder = uuid::Uuid::new_v4().to_string();
    assert_eq!(a.list(&folder), Err(RemoteError::FolderMissing));
    assert_eq!(
        put(a, &folder, &ticket(), "T-KQ1 A.md", None, b"a"),
        Err(RemoteError::FolderMissing)
    );
    a.ensure_folder(&folder, "ticketd Home").unwrap();
    b.ensure_folder(&folder, "ticketd Other name").unwrap();
    let found: Vec<RemoteFolder> = b
        .folders()
        .unwrap()
        .into_iter()
        .filter(|f| f.id == folder)
        .collect();
    assert_eq!(
        found,
        [RemoteFolder {
            id: folder.clone(),
            name: "ticketd Home".into()
        }]
    );
    assert_eq!(a.list(&folder), Ok(vec![]));
}

fn a_created_file_is_listed_and_downloaded_by_another_device(
    a: &dyn RemoteStorage,
    b: &dyn RemoteStorage,
) {
    let folder = new_folder(a, "Transfer");
    let key = ticket();
    let created = put(a, &folder, &key, "T-KQ1 Fix login.md", None, b"# Fix login").unwrap();
    assert_eq!(created.key, key);
    assert_eq!(created.name, "T-KQ1 Fix login.md");
    assert_eq!(created.size, 11);
    assert_eq!(b.list(&folder).unwrap(), std::slice::from_ref(&created));
    assert_eq!(get(b, &folder, &key, &created.version), b"# Fix login");
}

fn a_repeated_create_never_duplicates(a: &dyn RemoteStorage, b: &dyn RemoteStorage) {
    let folder = new_folder(a, "Idempotent create");
    let key = ticket();
    let created = put(a, &folder, &key, "T-KQ1.md", None, b"same").unwrap();
    assert_eq!(
        put(b, &folder, &key, "T-KQ1.md", None, b"same"),
        Ok(created.clone())
    );
    assert_eq!(
        put(b, &folder, &key, "T-KQ1.md", None, b"different"),
        Err(RemoteError::PreconditionFailed {
            current: Some(Box::new(created.clone()))
        })
    );
    assert_eq!(a.list(&folder).unwrap(), [created]);
}

fn an_update_applies_only_to_the_version_last_synced(a: &dyn RemoteStorage, b: &dyn RemoteStorage) {
    let folder = new_folder(a, "Precondition");
    let key = ticket();
    let first = put(a, &folder, &key, "T-KQ1 Old.md", None, b"one").unwrap();
    let second = put(
        a,
        &folder,
        &key,
        "T-KQ1 New.md",
        Some(&first.version),
        b"two",
    )
    .unwrap();
    assert_ne!(second.version, first.version);
    assert_eq!(second.name, "T-KQ1 New.md");
    assert_eq!(
        put(
            b,
            &folder,
            &key,
            "T-KQ1 B.md",
            Some(&first.version),
            b"three"
        ),
        Err(RemoteError::PreconditionFailed {
            current: Some(Box::new(second.clone()))
        })
    );
    // A write repeated after its response was lost has already been applied.
    assert_eq!(
        put(
            a,
            &folder,
            &key,
            "T-KQ1 New.md",
            Some(&first.version),
            b"two"
        ),
        Ok(second.clone())
    );
    assert_eq!(b.list(&folder).unwrap(), std::slice::from_ref(&second));
    assert_eq!(get(b, &folder, &key, &second.version), b"two");
}

fn a_missing_file_is_reported_not_recreated(a: &dyn RemoteStorage) {
    let folder = new_folder(a, "Missing");
    let key = ticket();
    assert_eq!(
        put(a, &folder, &key, "T-KQ1.md", Some("never-stored"), b"x"),
        Err(RemoteError::PreconditionFailed { current: None })
    );
    assert_eq!(
        a.download(&folder, &key, "never-stored", &mut Vec::new()),
        Err(RemoteError::NotFound)
    );
    assert_eq!(a.revisions(&folder, &key), Err(RemoteError::NotFound));
    assert_eq!(a.list(&folder), Ok(vec![]));
}

fn past_versions_stay_listed_and_downloadable(a: &dyn RemoteStorage, b: &dyn RemoteStorage) {
    let folder = new_folder(a, "Revisions");
    let key = RemoteKey::new(RemoteKind::Document, uuid::Uuid::new_v4().to_string());
    let first = put(a, &folder, &key, "Runbook.md", None, b"draft").unwrap();
    let second = put(
        a,
        &folder,
        &key,
        "Runbook.md",
        Some(&first.version),
        b"final text",
    )
    .unwrap();
    let revisions = b.revisions(&folder, &key).unwrap();
    assert_eq!(
        revisions
            .iter()
            .map(|r| (r.version.as_str(), r.size))
            .collect::<Vec<_>>(),
        [(first.version.as_str(), 5), (second.version.as_str(), 10)]
    );
    assert!(revisions.iter().all(|r| !r.modified.is_empty()));
    assert_eq!(get(b, &folder, &key, &first.version), b"draft");
    assert_eq!(
        b.download(&folder, &key, "no-such-version", &mut Vec::new()),
        Err(RemoteError::NotFound)
    );
}

fn kinds_separate_files_and_attachment_bytes_survive(a: &dyn RemoteStorage, b: &dyn RemoteStorage) {
    let folder = new_folder(a, "Kinds");
    let id = uuid::Uuid::new_v4().to_string();
    // Larger than two transfer chunks, and not valid UTF-8.
    let blob: Vec<u8> = (0..600_001u32).map(|n| (n % 251) as u8).collect();
    let mut expected = Vec::new();
    for kind in RemoteKind::ALL {
        let key = RemoteKey::new(kind, id.clone());
        let bytes = if kind == RemoteKind::Attachment {
            blob.clone()
        } else {
            kind.as_str().as_bytes().to_vec()
        };
        let file = put(a, &folder, &key, "same name", None, &bytes).unwrap();
        expected.push((file, bytes));
    }
    let empty = RemoteKey::new(RemoteKind::Attachment, uuid::Uuid::new_v4().to_string());
    expected.push((
        put(a, &folder, &empty, "empty.bin", None, b"").unwrap(),
        vec![],
    ));

    let mut listed = b.list(&folder).unwrap();
    listed.sort_by(|x, y| x.key.cmp(&y.key));
    let mut files: Vec<RemoteFile> = expected.iter().map(|(file, _)| file.clone()).collect();
    files.sort_by(|x, y| x.key.cmp(&y.key));
    assert_eq!(listed, files);
    for (file, bytes) in &expected {
        assert_eq!(file.size, bytes.len() as u64);
        assert!(get(b, &folder, &file.key, &file.version) == *bytes);
    }
}

fn unsafe_identifiers_are_refused(a: &dyn RemoteStorage) {
    let folder = new_folder(a, "Identifiers");
    let key = RemoteKey::new(RemoteKind::Ticket, "x' or name contains '");
    assert!(matches!(
        put(a, &folder, &key, "T.md", None, b"x"),
        Err(RemoteError::Other(_))
    ));
    assert!(matches!(a.list("../other"), Err(RemoteError::Other(_))));
}

/// `a` and `b` are two devices' handles on the same storage account.
fn contract(a: &dyn RemoteStorage, b: &dyn RemoteStorage, capabilities: RemoteCapabilities) {
    assert_eq!(a.capabilities(), capabilities);
    assert_eq!(b.capabilities(), capabilities);
    folders_are_found_created_once_and_required(a, b);
    a_created_file_is_listed_and_downloaded_by_another_device(a, b);
    a_repeated_create_never_duplicates(a, b);
    an_update_applies_only_to_the_version_last_synced(a, b);
    a_missing_file_is_reported_not_recreated(a);
    past_versions_stay_listed_and_downloadable(a, b);
    kinds_separate_files_and_attachment_bytes_survive(a, b);
    unsafe_identifiers_are_refused(a);
}

#[test]
fn the_fake_remote_meets_the_contract() {
    let a = FakeRemote::new();
    let b = a.clone();
    // The default fake behaves like Drive; tests switch it to conditional writes.
    contract(&a, &b, drive_capabilities());
    a.set_capabilities(RemoteCapabilities {
        conditional_writes: true,
        keeps_revisions: true,
    });
    assert!(b.capabilities().conditional_writes);
}

fn drive_capabilities() -> RemoteCapabilities {
    RemoteCapabilities {
        conditional_writes: false,
        keeps_revisions: true,
    }
}

#[test]
fn the_drive_adapter_meets_the_contract() {
    let sim = DriveSim::default();
    let connection = uuid::Uuid::new_v4().to_string();
    let a = DriveRemote::new(&connection, &Vault, &sim);
    let b = DriveRemote::new(&connection, &Vault, &sim);
    contract(&a, &b, drive_capabilities());
}

#[test]
fn the_fake_fails_the_chosen_call_and_can_lose_a_write_response() {
    let remote = FakeRemote::new();
    let folder = new_folder(&remote, "Faults");
    let key = ticket();
    remote.fail(RemoteOp::List, 2, RemoteError::Offline);
    assert_eq!(remote.list(&folder), Ok(vec![]));
    assert_eq!(remote.list(&folder), Err(RemoteError::Offline));
    assert_eq!(remote.list(&folder), Ok(vec![]));

    remote.fail(RemoteOp::Write, 1, RemoteError::StorageFull);
    assert_eq!(
        put(&remote, &folder, &key, "T.md", None, b"x"),
        Err(RemoteError::StorageFull)
    );
    assert_eq!(remote.list(&folder), Ok(vec![]));

    remote.drop_write(1, RemoteError::Offline);
    assert_eq!(
        put(&remote, &folder, &key, "T.md", None, b"x"),
        Err(RemoteError::Offline)
    );
    let stored = remote.list(&folder).unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(
        put(&remote, &folder, &key, "T.md", None, b"x"),
        Ok(stored[0].clone())
    );
    assert_eq!(remote.revisions(&folder, &key).unwrap().len(), 1);
    assert_eq!(remote.calls().last(), Some(&RemoteOp::Revisions));
}

#[test]
fn the_fake_reorders_and_thins_listings_and_loses_files_and_folders() {
    let remote = FakeRemote::new();
    let folder = new_folder(&remote, "Listings");
    let (first, second) = (ticket(), ticket());
    put(&remote, &folder, &first, "1.md", None, b"1").unwrap();
    put(&remote, &folder, &second, "2.md", None, b"2").unwrap();
    let ordered = remote.list(&folder).unwrap();
    remote.reverse_listings(true);
    let mut reversed = remote.list(&folder).unwrap();
    reversed.reverse();
    assert_eq!(reversed, ordered);

    remote.omit_from_next_listing(std::slice::from_ref(&first));
    let thinned = remote.list(&folder).unwrap();
    assert_eq!(thinned.len(), 1);
    assert_eq!(thinned[0].key, second);
    assert_eq!(remote.list(&folder).unwrap().len(), 2);

    remote.set_now("2026-11-11T08:00:00Z");
    let updated = put(
        &remote,
        &folder,
        &first,
        "1.md",
        Some(&ordered.iter().find(|f| f.key == first).unwrap().version),
        b"1b",
    )
    .unwrap();
    let revisions = remote.revisions(&folder, &first).unwrap();
    assert_eq!(revisions[1].modified, "2026-11-11T08:00:00Z");
    assert_eq!(revisions[1].version, updated.version);

    assert!(remote.remove_file(&folder, &first));
    assert_eq!(remote.list(&folder).unwrap().len(), 1);
    remote.remove_folder(&folder);
    assert_eq!(remote.list(&folder), Err(RemoteError::FolderMissing));
}
