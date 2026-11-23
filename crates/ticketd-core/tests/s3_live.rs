//! The S3 adapter against a real S3-compatible server (MinIO in CI). The simulator tests in
//! `s3_remote.rs` prove how the adapter reacts to what it is told S3 does; these check that a
//! real server does it: conditional writes, version identity and delete markers, paging past
//! the server's own page size, ranged reads and the headers that carry names and hashes.
//! Opt-in through `TICKETD_S3_TEST_ENDPOINT` (see `support/s3_live.rs`), and every test is
//! named `live_…` so CI's `cargo test -- live_` runs them. Put new live tests here, such as the
//! multipart upload of a large attachment.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Test helpers fail the test.
use std::io::Cursor;

use ticketd_core::sync::remote::*;

#[path = "support/s3_live.rs"]
mod s3_live;
use s3_live::live;

fn ticket() -> RemoteKey {
    RemoteKey::new(RemoteKind::Ticket, uuid::Uuid::new_v4().to_string())
}

fn object(live: &s3_live::Live, folder: &str, key: &RemoteKey) -> String {
    format!("{}{folder}/tickets/{}.md", live.prefix, key.id)
}

fn put(
    remote: &dyn RemoteStorage,
    folder: &str,
    key: &RemoteKey,
    expected: Option<&str>,
    bytes: &[u8],
) -> Result<RemoteFile, RemoteError> {
    remote.write(
        folder,
        key,
        "T-KQ1 Title.md",
        expected,
        &mut Cursor::new(bytes),
    )
}

fn get(remote: &dyn RemoteStorage, folder: &str, key: &RemoteKey, version: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    remote.download(folder, key, version, &mut bytes).unwrap();
    bytes
}

fn folder(remote: &dyn RemoteStorage) -> String {
    let folder = uuid::Uuid::new_v4().to_string();
    remote.ensure_folder(&folder, "Live").unwrap();
    folder
}

#[test]
fn live_a_stale_update_is_refused_with_the_current_file_and_replaces_nothing() {
    let Some(live) = live() else { return };
    let (mine, theirs) = (live.remote(), live.remote());
    let (folder, key) = (folder(&mine), ticket());
    let first = put(&mine, &folder, &key, None, b"one").unwrap();
    // Another device writes after this one has read the file and before its PutObject.
    let second = put(&theirs, &folder, &key, Some(&first.version), b"theirs").unwrap();

    let refused = put(&mine, &folder, &key, Some(&first.version), b"mine").unwrap_err();
    let RemoteError::PreconditionFailed {
        current: Some(current),
    } = refused
    else {
        panic!("expected a precondition error with the current file, got {refused:?}");
    };
    assert_eq!(*current, second);
    assert_eq!(get(&mine, &folder, &key, &current.version), b"theirs");
    assert_eq!(mine.revisions(&folder, &key).unwrap().len(), 2);
}

#[test]
fn live_a_write_of_equal_content_makes_no_new_version() {
    let Some(live) = live() else { return };
    let (remote, key) = (live.remote(), ticket());
    let folder = folder(&remote);
    let first = put(&remote, &folder, &key, None, b"same").unwrap();
    assert_eq!(
        put(&remote, &folder, &key, Some(&first.version), b"same"),
        Ok(first)
    );
    assert_eq!(remote.revisions(&folder, &key).unwrap().len(), 1);
}

#[test]
fn live_an_object_uploaded_by_hand_is_read_normally_and_hashed_from_its_bytes() {
    let Some(live) = live() else { return };
    let (remote, key) = (live.remote(), ticket());
    let folder = folder(&remote);
    let name = object(&live, &folder, &key);
    let version = live.put_foreign(&name, b"by hand");
    assert!(
        live.head(&name)
            .header("x-amz-meta-ticketd-sha256")
            .is_none()
    );

    let listed = remote.list(&folder).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        (listed[0].version.as_str(), listed[0].size),
        (version.as_str(), 7)
    );
    assert_eq!(get(&remote, &folder, &key, &version), b"by hand");

    // Equal bytes are recognised without metadata: nothing new is written.
    assert_eq!(
        put(&remote, &folder, &key, Some(&version), b"by hand"),
        Ok(listed[0].clone())
    );
    assert_eq!(remote.revisions(&folder, &key).unwrap().len(), 1);

    // Other bytes replace it, and from then on it carries ticketd's metadata.
    let updated = put(&remote, &folder, &key, Some(&version), b"edited").unwrap();
    assert_ne!(updated.version, version);
    assert!(
        live.head(&name)
            .header("x-amz-meta-ticketd-sha256")
            .is_some()
    );
}

#[test]
fn live_a_non_ascii_name_survives_in_content_disposition() {
    let Some(live) = live() else { return };
    let (remote, key) = (live.remote(), ticket());
    let folder = folder(&remote);
    let title = "T-KQ9 Zażółć gęślą jaźń ✓ 日本語 & more.md";
    let file = remote
        .write(&folder, &key, title, None, &mut Cursor::new(b"x"))
        .unwrap();
    let head = live.head(&object(&live, &folder, &key));
    let encoded = head
        .header("content-disposition")
        .unwrap()
        .strip_prefix("attachment; filename*=UTF-8''")
        .unwrap();
    assert_eq!(
        percent_encoding::percent_decode_str(encoded)
            .decode_utf8()
            .unwrap(),
        title
    );
    assert_eq!(remote.list(&folder).unwrap(), [file]);
}

#[test]
fn live_a_large_file_is_written_whole_and_read_in_ranges() {
    let Some(live) = live() else { return };
    let (remote, folder) = (live.remote(), folder(&live.remote()));
    let key = RemoteKey::new(RemoteKind::Attachment, uuid::Uuid::new_v4().to_string());
    let bytes: Vec<u8> = (0..9_000_000u32).map(|n| (n % 253) as u8).collect();
    let file = put(&remote, &folder, &key, None, &bytes).unwrap();
    assert_eq!(file.size, 9_000_000);
    assert!(get(&remote, &folder, &key, &file.version) == bytes);
    // The same bytes again are recognised from the stored object, not uploaded twice.
    assert_eq!(
        put(&remote, &folder, &key, Some(&file.version), &bytes),
        Ok(file)
    );
    assert_eq!(remote.revisions(&folder, &key).unwrap().len(), 1);
}

#[test]
fn live_deleting_and_writing_again_is_another_file_and_removing_the_marker_restores_the_first() {
    let Some(live) = live() else { return };
    let (remote, key) = (live.remote(), ticket());
    let folder = folder(&remote);
    let name = object(&live, &folder, &key);
    let first = put(&remote, &folder, &key, None, b"one").unwrap();

    // A person deletes it in the bucket. The file is missing, not deleted for sync.
    let marker = live.delete(&name);
    assert_eq!(remote.list(&folder), Ok(vec![]));
    assert_eq!(remote.revisions(&folder, &key), Err(RemoteError::NotFound));
    assert_eq!(
        put(&remote, &folder, &key, Some(&first.version), b"two"),
        Err(RemoteError::PreconditionFailed { current: None })
    );

    // Written again, it is a new file made later than the first.
    let again = put(&remote, &folder, &key, None, b"three").unwrap();
    assert_eq!(again.file_id, marker);
    assert_ne!(again.file_id, first.file_id);
    let later = |a: &str, b: &str| {
        chrono::DateTime::parse_from_rfc3339(a).unwrap()
            > chrono::DateTime::parse_from_rfc3339(b).unwrap()
    };
    assert!(later(&again.created, &first.created));
    assert_eq!(remote.list(&folder).unwrap(), std::slice::from_ref(&again));
    assert_eq!(remote.revisions(&folder, &key).unwrap().len(), 1);

    // The marker removed, the earlier file's identity is back, with both versions.
    live.remove_version(&name, &marker);
    let restored = remote.list(&folder).unwrap();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].file_id, first.file_id);
    assert_eq!(restored[0].created, first.created);
    assert_eq!(restored[0].version, again.version);
    assert_eq!(remote.revisions(&folder, &key).unwrap().len(), 2);
}

#[test]
fn live_listings_continue_past_the_servers_page_of_a_thousand_versions() {
    let Some(live) = live() else { return };
    let (remote, folder) = (live.remote(), folder(&live.remote()));
    // 600 files of two versions each is 1,200 versions, so a page ends in the middle of a
    // file's versions. Some are then deleted in the bucket, whose markers are listed too.
    let mut expected = Vec::new();
    for _ in 0..600 {
        let key = ticket();
        let name = object(&live, &folder, &key);
        live.put_foreign(&name, b"first");
        let latest = live.put_foreign(&name, b"second");
        expected.push((key, name, latest));
    }
    for (_, name, _) in expected.iter().step_by(7) {
        live.delete(name);
    }
    let mut kept: Vec<(String, String)> = expected
        .iter()
        .enumerate()
        .filter(|(n, _)| n % 7 != 0)
        .map(|(_, (key, _, latest))| (key.id.clone(), latest.clone()))
        .collect();
    kept.sort();

    let mut listed: Vec<(String, String)> = remote
        .list(&folder)
        .unwrap()
        .into_iter()
        .map(|file| (file.key.id, file.version))
        .collect();
    listed.sort();
    assert_eq!(listed, kept);

    // The versions of one file that straddles the first page, oldest first.
    let (key, _, latest) = &expected[1];
    let revisions = remote.revisions(&folder, key).unwrap();
    assert_eq!(revisions.len(), 2);
    assert_eq!(&revisions[1].version, latest);
}

#[test]
fn live_folders_are_found_by_their_marker_and_only_those() {
    let Some(live) = live() else { return };
    let remote = live.remote();
    let mut ids: Vec<String> = (0..3).map(|_| folder(&remote)).collect();
    ids.sort();
    // Somebody else's data under the same prefix, and a prefix that is not a folder id.
    live.put_foreign(&format!("{}stranger/readme.txt", live.prefix), b"hi");
    live.put_foreign(&format!("{}not a folder id/readme.txt", live.prefix), b"hi");
    let found: Vec<String> = remote
        .folders()
        .unwrap()
        .into_iter()
        .map(|f| f.id)
        .collect();
    assert_eq!(found, ids);
}
