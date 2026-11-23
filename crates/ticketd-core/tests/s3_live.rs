//! The S3 adapter against a real S3-compatible server (MinIO in CI). The simulator tests in
//! `s3_remote.rs` prove how the adapter reacts to what it is told S3 does; these check that a
//! real server does it: conditional writes, version identity and delete markers, paging past
//! the server's own page size, ranged reads and the headers that carry names and hashes.
//! Opt-in through `TICKETD_S3_TEST_ENDPOINT` (see `support/s3_live.rs`), and every test is
//! named `live_…` so CI's `cargo test -- live_` runs them. Put new live tests here, such as the
//! multipart upload of a large attachment.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Test helpers fail the test.
use std::io::Cursor;
use std::sync::Mutex;

use ticketd_core::s3::*;
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

/// Sends through the production transport, lets the test fail the requests it picks (the
/// connection is gone) and remembers every request's method and URL.
struct Flaky<'a> {
    inner: &'a UreqS3Transport,
    fail_when: Mutex<Option<String>>,
    seen: Mutex<Vec<String>>,
}

impl<'a> Flaky<'a> {
    fn over(inner: &'a UreqS3Transport) -> Self {
        Self {
            inner,
            fail_when: Mutex::new(None),
            seen: Mutex::new(vec![]),
        }
    }

    /// Fails every request whose URL has `text` in it, until `None`.
    fn fail(&self, text: Option<&str>) {
        *self.fail_when.lock().unwrap() = text.map(str::to_owned);
    }

    /// How many requests of `method` had `text` in their URL.
    fn count(&self, method: &str, text: &str) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|seen| seen.starts_with(method) && seen.contains(text))
            .count()
    }
}

impl S3Transport for Flaky<'_> {
    fn send(&self, request: S3Request) -> Result<S3Response, S3TransportError> {
        self.seen
            .lock()
            .unwrap()
            .push(format!("{} {}", request.method, request.url));
        let down = self
            .fail_when
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|text| request.url.contains(text.as_str()));
        if down {
            return Err(S3TransportError::Offline);
        }
        self.inner.send(request)
    }
}

/// An Attachment one byte over the single-part limit, so it goes up in parts.
fn big() -> Vec<u8> {
    (0..=SINGLE_PART_LIMIT as u32)
        .map(|n| (n.wrapping_mul(31) % 251) as u8)
        .collect()
}

fn attachment() -> RemoteKey {
    RemoteKey::new(RemoteKind::Attachment, uuid::Uuid::new_v4().to_string())
}

const PARTS: u64 = 5 * 1024 * 1024;

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

// ---- multipart uploads ------------------------------------------------------------------

#[test]
fn live_a_file_over_the_limit_uploads_in_parts_and_downloads_intact() {
    let Some(live) = live() else { return };
    let remote = live.remote().with_part_size(PARTS);
    let (folder, key, bytes) = (folder(&remote), attachment(), big());
    let file = put(&remote, &folder, &key, None, &bytes).unwrap();
    assert_eq!(file.size, bytes.len() as u64);
    assert!(get(&remote, &folder, &key, &file.version) == bytes);

    let name = format!("{}{folder}/attachments/{}", live.prefix, key.id);
    let head = live.head(&name);
    // Made by a multipart upload (its ETag ends in the number of parts), with ticketd's hash.
    assert!(
        head.header("etag")
            .unwrap()
            .trim_end_matches('"')
            .ends_with("-4")
    );
    assert!(head.header("x-amz-meta-ticketd-sha256").is_some());
    assert_eq!(live.pending_uploads(&name), 0);
    assert_eq!(remote.list(&folder).unwrap(), [file]);
}

#[test]
fn live_an_upload_cut_short_resumes_with_only_the_missing_parts() {
    let Some(live) = live() else { return };
    let flaky = Flaky::over(&live.transport);
    let remote = S3Remote::new(live.target(), &live.prefix, &live.credentials, &flaky)
        .unwrap()
        .with_part_size(PARTS);
    let (folder, key, bytes) = (folder(&remote), attachment(), big());
    let name = format!("{}{folder}/attachments/{}", live.prefix, key.id);

    // The connection goes during part 3.
    flaky.fail(Some("partNumber=3"));
    assert_eq!(
        put(&remote, &folder, &key, None, &bytes),
        Err(RemoteError::Offline)
    );
    assert_eq!(live.pending_uploads(&name), 1);
    assert_eq!(remote.list(&folder), Ok(vec![]));

    // The app starts again with a new adapter and nothing kept from before.
    flaky.fail(None);
    let again = S3Remote::new(live.target(), &live.prefix, &live.credentials, &flaky)
        .unwrap()
        .with_part_size(PARTS);
    let file = put(&again, &folder, &key, None, &bytes).unwrap();
    for sent_once in ["partNumber=1&", "partNumber=2&", "partNumber=4&"] {
        assert_eq!(flaky.count("PUT", sent_once), 1, "{sent_once}");
    }
    assert_eq!(
        flaky.count("POST", "?uploads"),
        1,
        "the same upload was finished"
    );
    assert_eq!(live.pending_uploads(&name), 0);
    assert!(get(&again, &folder, &key, &file.version) == bytes);
}

#[test]
fn live_a_second_desktop_uploading_the_same_attachment_adds_no_version_and_leaves_no_upload() {
    let Some(live) = live() else { return };
    let a = live.remote().with_part_size(PARTS);
    let b = live.remote().with_part_size(PARTS);
    let (folder, key, bytes) = (folder(&a), attachment(), big());
    let name = format!("{}{folder}/attachments/{}", live.prefix, key.id);
    let first = put(&a, &folder, &key, None, &bytes).unwrap();

    // The second one's completion is refused (`If-None-Match: *`), and it finds the same bytes.
    assert_eq!(put(&b, &folder, &key, None, &bytes), Ok(first));
    assert_eq!(b.revisions(&folder, &key).unwrap().len(), 1);
    assert_eq!(live.pending_uploads(&name), 0, "its upload was aborted");

    // Other bytes under the same key are a conflict, and leave nothing behind either.
    let mut other = bytes.clone();
    other[7] ^= 0xff;
    assert!(matches!(
        put(&b, &folder, &key, None, &other),
        Err(RemoteError::PreconditionFailed { current: Some(_) })
    ));
    assert_eq!(live.pending_uploads(&name), 0);
    assert_eq!(a.revisions(&folder, &key).unwrap().len(), 1);
}
