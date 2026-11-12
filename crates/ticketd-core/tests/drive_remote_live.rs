//! Opt-in live check of the sync adapter against real Google Drive. Run it
//! through `tests/live/google-drive-sync.ps1`; it needs a saved connection in
//! this OS user's secure store. It creates one uniquely named folder with a
//! few synthetic files and never trashes, deletes or shares anything.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Test helpers fail the test.
use std::io::Cursor;

use ticketd_core::drive::{DriveRemote, GoogleTransport, PlatformCredentialStore};
use ticketd_core::sync::remote::*;

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

fn get(remote: &dyn RemoteStorage, folder: &str, file: &RemoteFile, version: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    remote
        .download(folder, &file.key, version, &mut bytes)
        .unwrap();
    bytes
}

#[test]
#[ignore = "writes to a real Google Drive; run tests/live/google-drive-sync.ps1"]
fn two_devices_exchange_files_through_a_disposable_drive_folder() {
    let connection = std::env::var("TICKETD_LIVE_DRIVE_CONNECTION")
        .expect("TICKETD_LIVE_DRIVE_CONNECTION names the saved Drive connection to use");
    let transport = GoogleTransport::default();
    // Two handles stand for two devices: they share nothing but the Drive account.
    let first = DriveRemote::new(&connection, &PlatformCredentialStore, &transport);
    let second = DriveRemote::new(&connection, &PlatformCredentialStore, &transport);
    let folder = uuid::Uuid::new_v4().to_string();
    let name = format!("ticketd live sync check {}", &folder[..8]);

    assert_eq!(first.list(&folder), Err(RemoteError::FolderMissing));
    first.ensure_folder(&folder, &name).unwrap();
    first.ensure_folder(&folder, &name).unwrap();
    let found = second.folders().unwrap();
    assert_eq!(found.iter().filter(|f| f.id == folder).count(), 1);
    println!("folder: created once and visible to the second device as '{name}'");

    let (_, changes_start) = first.changed_file_ids(None).unwrap();

    let ticket = RemoteKey::new(RemoteKind::Ticket, uuid::Uuid::new_v4().to_string());
    let created = put(
        &first,
        &folder,
        &ticket,
        "T-KQ1 Live check.md",
        None,
        b"# one\n",
    )
    .unwrap();
    assert_eq!(
        put(
            &first,
            &folder,
            &ticket,
            "T-KQ1 Live check.md",
            None,
            b"# one\n"
        ),
        Ok(created.clone())
    );
    assert_eq!(
        second.list(&folder).unwrap(),
        std::slice::from_ref(&created)
    );
    assert_eq!(
        get(&second, &folder, &created, &created.version),
        b"# one\n"
    );
    println!("create: listed and downloaded by the second device; repeating it added nothing");

    let updated = put(
        &second,
        &folder,
        &ticket,
        "T-KQ1 Live check edited.md",
        Some(&created.version),
        b"# two\n",
    )
    .unwrap();
    assert_ne!(updated.version, created.version);
    assert_eq!(
        put(
            &first,
            &folder,
            &ticket,
            "T-KQ1 stale.md",
            Some(&created.version),
            b"# stale\n"
        ),
        Err(RemoteError::PreconditionFailed {
            current: Some(Box::new(updated.clone()))
        })
    );
    assert_eq!(first.list(&folder).unwrap(), std::slice::from_ref(&updated));
    println!("update: applied at the synced version, refused at a stale one");

    let revisions = first.revisions(&folder, &ticket).unwrap();
    assert_eq!(
        revisions
            .iter()
            .map(|r| r.version.as_str())
            .collect::<Vec<_>>(),
        [created.version.as_str(), updated.version.as_str()]
    );
    assert_eq!(get(&first, &folder, &updated, &created.version), b"# one\n");
    println!("revisions: both kept by Drive, the first still downloadable");

    let blob: Vec<u8> = (0..600_001u32).map(|n| (n % 251) as u8).collect();
    let attachment = RemoteKey::new(RemoteKind::Attachment, uuid::Uuid::new_v4().to_string());
    let stored = put(&first, &folder, &attachment, "live-check.bin", None, &blob).unwrap();
    assert!(get(&second, &folder, &stored, &stored.version) == blob);
    assert_eq!(second.list(&folder).unwrap().len(), 2);
    println!("attachment: 600001 bytes uploaded in chunks and downloaded intact");

    // Undocumented under drive.file, so this is an observation, not an assertion.
    match first.changed_file_ids(Some(&changes_start)) {
        Ok((ids, _)) => println!(
            "changes.list under drive.file: answered, {} changed file ID(s) since the folder was created (a file was created, then updated, and an attachment created)",
            ids.len()
        ),
        Err(error) => println!("changes.list under drive.file: refused ({error})"),
    }
}
