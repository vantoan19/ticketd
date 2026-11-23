//! The S3 adapter's own behavior on the simulated bucket: what S3 answers to a conditional
//! write, how file identity follows delete markers, paging, and how failures map onto sync's
//! recovery states. What every storage shares is in `remote_contract.rs`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Test helpers fail the test.
use std::io::Cursor;
use std::sync::Mutex;
use std::time::Duration;

use ticketd_core::s3::*;
use ticketd_core::sync::remote::*;

#[path = "support/s3_sim.rs"]
mod s3_sim;
use s3_sim::{BUCKET, FakeCredentials, Fault, S3Sim, target};

/// A bucket, the credentials of one desktop, and the waits its adapter asked for.
struct Bench {
    sim: S3Sim,
    credentials: FakeCredentials,
    pauses: Mutex<Vec<Duration>>,
}

impl Bench {
    fn new() -> Self {
        Self::with_credentials(FakeCredentials::default())
    }

    fn with_credentials(credentials: FakeCredentials) -> Self {
        Self {
            sim: S3Sim::default(),
            credentials,
            pauses: Mutex::new(vec![]),
        }
    }

    fn remote(&self) -> S3Remote<'_> {
        S3Remote::new(target(), "ticketd/", &self.credentials, &self.sim)
            .unwrap()
            .with_pause(|wait| self.pauses.lock().unwrap().push(wait))
    }

    fn pauses(&self) -> Vec<Duration> {
        self.pauses.lock().unwrap().clone()
    }

    /// A Workspace folder that exists in the bucket.
    fn folder(&self) -> String {
        let folder = uuid::Uuid::new_v4().to_string();
        self.remote().ensure_folder(&folder, "Home").unwrap();
        folder
    }
}

fn ticket() -> RemoteKey {
    RemoteKey::new(RemoteKind::Ticket, uuid::Uuid::new_v4().to_string())
}

fn object(folder: &str, key: &RemoteKey) -> String {
    let sub = match key.kind {
        RemoteKind::Ticket => "tickets",
        RemoteKind::Attachment => "attachments",
        other => panic!("not used here: {other:?}"),
    };
    let ext = if key.kind == RemoteKind::Attachment {
        ""
    } else {
        ".md"
    };
    format!("ticketd/{folder}/{sub}/{}{ext}", key.id)
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

#[test]
fn s3_declares_conditional_writes_and_kept_revisions() {
    let bench = Bench::new();
    assert_eq!(
        bench.remote().capabilities(),
        RemoteCapabilities {
            conditional_writes: true,
            keeps_revisions: true
        }
    );
}

#[test]
fn the_aws_cli_credentials_are_a_credential_source() {
    fn source<T: CredentialSource>() {}
    source::<ProfileCredentials>();
}

// ---- conditional writes ---------------------------------------------------------------

#[test]
fn a_create_and_an_update_are_conditional_on_the_object() {
    let bench = Bench::new();
    let folder = bench.folder();
    let spy = Spy::over(&bench.sim);
    let remote = S3Remote::new(target(), "ticketd/", &bench.credentials, &spy).unwrap();
    let key = ticket();

    let first = put(&remote, &folder, &key, None, b"one").unwrap();
    let create = spy.puts();
    assert_eq!(create.len(), 1);
    assert_eq!(header(&create[0], "if-none-match"), Some("*"));
    assert_eq!(header(&create[0], "if-match"), None);

    put(&remote, &folder, &key, Some(&first.version), b"two").unwrap();
    let update = &spy.puts()[1];
    // The update names the ETag of the version it replaces: S3 cannot condition on a VersionId.
    let etag_of_one = format!("\"{:.32}\"", sha256_hex(b"one"));
    assert_eq!(header(update, "if-match"), Some(etag_of_one.as_str()));
    assert_eq!(header(update, "if-none-match"), None);
    // Single-part writes send S3 the checksum to verify, and keep ticketd's own in metadata.
    assert!(header(update, "x-amz-checksum-sha256").is_some());
    assert_eq!(
        header(update, "x-amz-meta-ticketd-sha256"),
        Some(sha256_hex(b"two").as_str())
    );
}

#[test]
fn a_write_that_s3_refuses_as_changed_shows_the_current_file_and_replaces_nothing() {
    let bench = Bench::new();
    let (remote, folder, key) = (bench.remote(), bench.folder(), ticket());
    let first = put(&remote, &folder, &key, None, b"one").unwrap();
    // Another device writes after this one has read the file and before its PutObject.
    bench.sim.interleave(&key.id, b"theirs");

    let refused = put(&remote, &folder, &key, Some(&first.version), b"mine").unwrap_err();
    let RemoteError::PreconditionFailed {
        current: Some(current),
    } = refused
    else {
        panic!("expected a precondition error with the current file, got {refused:?}");
    };
    assert_eq!(current.size, 6);
    assert_eq!(get(&remote, &folder, &key, &current.version), b"theirs");
    assert_eq!(
        bench.sim.object(&object(&folder, &key)).unwrap().bytes,
        b"theirs"
    );
}

#[test]
fn a_file_that_went_missing_before_the_update_is_reported_missing() {
    let bench = Bench::new();
    let (remote, folder, key) = (bench.remote(), bench.folder(), ticket());
    let first = put(&remote, &folder, &key, None, b"one").unwrap();
    // S3 answers 404, not 412, to If-Match when the object is gone.
    bench
        .sim
        .fault(Fault::new("PUT", "tickets", 404, "NoSuchKey"));
    assert_eq!(
        put(&remote, &folder, &key, Some(&first.version), b"two"),
        Err(RemoteError::PreconditionFailed { current: None })
    );
}

#[test]
fn a_conditional_request_conflict_is_retried() {
    let bench = Bench::new();
    let (remote, folder, key) = (bench.remote(), bench.folder(), ticket());
    let mut fault = Fault::new("PUT", "tickets", 409, "ConditionalRequestConflict");
    fault.times = 2;
    bench.sim.fault(fault);
    let file = put(&remote, &folder, &key, None, b"one").unwrap();
    assert_eq!(get(&remote, &folder, &key, &file.version), b"one");
    assert_eq!(bench.sim.count("PUT", "tickets"), 3);
    assert_eq!(bench.pauses().len(), 2);

    let key = ticket();
    let mut fault = Fault::new("PUT", "tickets", 409, "ConditionalRequestConflict");
    fault.times = 100;
    bench.sim.fault(fault);
    assert!(matches!(
        put(&remote, &folder, &key, None, b"one"),
        Err(RemoteError::Other(_))
    ));
}

#[test]
fn a_write_whose_answer_was_lost_is_not_written_twice() {
    let bench = Bench::new();
    let (remote, folder, key) = (bench.remote(), bench.folder(), ticket());
    let mut lost = Fault::new("PUT", "tickets", 503, "SlowDown");
    lost.after_applying = true;
    bench.sim.fault(lost);
    // S3 stored the file and then said SlowDown. The repeat is refused as a second create,
    // and the adapter finds its own bytes stored.
    let file = put(&remote, &folder, &key, None, b"one").unwrap();
    assert_eq!(bench.sim.versions(&object(&folder, &key)).len(), 1);
    assert_eq!(remote.list(&folder).unwrap(), [file]);
}

#[test]
fn a_write_of_equal_content_makes_no_new_version() {
    let bench = Bench::new();
    let (remote, folder, key) = (bench.remote(), bench.folder(), ticket());
    let first = put(&remote, &folder, &key, None, b"same").unwrap();
    let before = bench.sim.count("PUT", "tickets");
    assert_eq!(
        put(&remote, &folder, &key, Some(&first.version), b"same"),
        Ok(first.clone())
    );
    assert_eq!(put(&remote, &folder, &key, None, b"same"), Ok(first));
    assert_eq!(bench.sim.count("PUT", "tickets"), before);
    assert_eq!(bench.sim.versions(&object(&folder, &key)).len(), 1);
}

#[test]
fn an_object_uploaded_by_hand_is_read_normally_and_hashed_from_its_bytes() {
    let bench = Bench::new();
    let (remote, folder, key) = (bench.remote(), bench.folder(), ticket());
    let name = object(&folder, &key);
    let version = bench.sim.put_foreign(&name, b"by hand");
    assert!(bench.sim.object(&name).unwrap().metadata.is_empty());

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
    assert_eq!(bench.sim.versions(&name).len(), 1);

    // Other bytes replace it, and from then on it carries ticketd's metadata.
    let updated = put(&remote, &folder, &key, Some(&version), b"edited").unwrap();
    assert_ne!(updated.version, version);
    let stored = bench.sim.object(&name).unwrap();
    assert!(stored.metadata.iter().any(|(name, value)| {
        name == "x-amz-meta-ticketd-sha256" && *value == sha256_hex(b"edited")
    }));
}

#[test]
fn a_download_that_does_not_match_its_recorded_checksum_is_refused() {
    let bench = Bench::new();
    let (remote, folder, key) = (bench.remote(), bench.folder(), ticket());
    let file = put(&remote, &folder, &key, None, b"honest bytes").unwrap();
    bench.sim.corrupt(&object(&folder, &key));
    let mut output = Vec::new();
    assert!(matches!(
        remote.download(&folder, &key, &file.version, &mut output),
        Err(RemoteError::Other(message)) if message.contains("checksum")
    ));
}

#[test]
fn a_large_file_is_read_in_ranges() {
    let bench = Bench::new();
    let (remote, folder) = (bench.remote(), bench.folder());
    let key = RemoteKey::new(RemoteKind::Attachment, uuid::Uuid::new_v4().to_string());
    let bytes: Vec<u8> = (0..9_000_000u32).map(|n| (n % 253) as u8).collect();
    let file = put(&remote, &folder, &key, None, &bytes).unwrap();
    assert!(get(&remote, &folder, &key, &file.version) == bytes);
    let reads = bench
        .sim
        .requests()
        .iter()
        .filter(|(m, url)| m == "GET" && url.contains("attachments") && url.contains("versionId"))
        .count();
    // One range for the check of the content already stored, none for the write; two for the download.
    assert_eq!(reads, 2);
}

// ---- uploads in parts -------------------------------------------------------------------

const MIB: usize = 1024 * 1024;
/// The smallest part S3 takes, so a file just over the single-part limit is four parts.
const SMALL_PARTS: u64 = 5 * 1024 * 1024;

fn attachment() -> RemoteKey {
    RemoteKey::new(RemoteKind::Attachment, uuid::Uuid::new_v4().to_string())
}

/// Bytes with no repeating part, so a part uploaded in the wrong place is noticed.
fn noise(len: usize) -> Vec<u8> {
    let mut x: u64 = 0x2545_f491_4f6c_dd1d;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

fn over_the_limit() -> Vec<u8> {
    noise(SINGLE_PART_LIMIT as usize + MIB)
}

fn parted(bench: &Bench) -> S3Remote<'_> {
    bench.remote().with_part_size(SMALL_PARTS)
}

#[test]
fn a_file_over_the_limit_uploads_in_parts_and_downloads_intact() {
    let bench = Bench::new();
    let (folder, key, bytes) = (bench.folder(), attachment(), over_the_limit());
    let spy = Spy::over(&bench.sim);
    let remote = S3Remote::new(target(), "ticketd/", &bench.credentials, &spy)
        .unwrap()
        .with_part_size(SMALL_PARTS);
    let file = put(&remote, &folder, &key, None, &bytes).unwrap();
    assert_eq!(file.size, bytes.len() as u64);

    let name = object(&folder, &key);
    let stored = bench.sim.object(&name).unwrap();
    assert!(stored.bytes == bytes);
    assert!(
        stored
            .metadata
            .contains(&("x-amz-meta-ticketd-sha256".to_owned(), sha256_hex(&bytes)))
    );
    assert!(stored.disposition.unwrap().contains("T-KQ1%20Title.md"));
    assert!(bench.sim.pending().is_empty());

    let seen = spy.seen.lock().unwrap();
    let writes: Vec<&S3Request> = seen
        .iter()
        .filter(|r| r.url.contains("attachments") && r.method != "GET")
        .collect();
    let steps: Vec<(&str, &str)> = writes
        .iter()
        .map(|r| {
            let query = r.url.split_once('?').map_or("", |(_, query)| query);
            (r.method, query.split('&').next().unwrap_or(""))
        })
        .collect();
    assert_eq!(steps.len(), 6, "{steps:?}");
    assert_eq!(
        steps[..5],
        [
            ("POST", "uploads"),
            ("PUT", "partNumber=1"),
            ("PUT", "partNumber=2"),
            ("PUT", "partNumber=3"),
            ("PUT", "partNumber=4"),
        ]
    );
    assert_eq!(steps[5].0, "POST");
    assert!(steps[5].1.starts_with("uploadId="));

    let create = writes[0];
    let hash = sha256_hex(&bytes);
    assert_eq!(
        header(create, "x-amz-meta-ticketd-sha256"),
        Some(hash.as_str())
    );
    assert_eq!(header(create, "x-amz-checksum-algorithm"), Some("SHA256"));
    for part in &writes[1..5] {
        assert!(header(part, "x-amz-checksum-sha256").is_some());
    }
    let complete = writes[5];
    assert_eq!(header(complete, "if-none-match"), Some("*"));
    let listed = String::from_utf8(complete.body.clone()).unwrap();
    for number in 1..=4 {
        assert!(listed.contains(&format!("<PartNumber>{number}</PartNumber>")));
    }
    drop(seen);

    assert!(get(&remote, &folder, &key, &file.version) == bytes);
}

#[test]
fn an_upload_interrupted_after_some_parts_resumes_with_only_the_remaining_ones() {
    let bench = Bench::new();
    let (folder, key, bytes) = (bench.folder(), attachment(), over_the_limit());
    let name = object(&folder, &key);
    // Part 3 fails for the first call and every retry it makes: the connection is gone.
    let mut fault = Fault::new("PUT", "partNumber=3&", 500, "InternalError");
    fault.times = 5;
    bench.sim.fault(fault);
    assert_eq!(
        put(&parted(&bench), &folder, &key, None, &bytes).unwrap_err(),
        RemoteError::Offline
    );
    let pending = bench.sim.pending();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].parts, [1, 2]);
    assert!(bench.sim.object(&name).is_none());

    // The app was quit and started again: a new adapter, and nothing kept from before.
    let file = put(&parted(&bench), &folder, &key, None, &bytes).unwrap();
    assert_eq!(bench.sim.count("PUT", "partNumber=1&"), 1);
    assert_eq!(bench.sim.count("PUT", "partNumber=2&"), 1);
    assert_eq!(bench.sim.count("PUT", "partNumber=4&"), 1);
    assert_eq!(
        bench.sim.count("POST", "?uploads"),
        1,
        "the upload begun before is the one finished"
    );
    assert!(bench.sim.object(&name).unwrap().bytes == bytes);
    assert!(bench.sim.pending().is_empty());
    assert_eq!(file.size, bytes.len() as u64);
}

#[test]
fn another_desktop_completing_the_same_attachment_first_is_already_uploaded() {
    let bench = Bench::new();
    let (folder, key, bytes) = (bench.folder(), attachment(), over_the_limit());
    let name = object(&folder, &key);
    bench.sim.interleave(&name, &bytes);
    let file = put(&parted(&bench), &folder, &key, None, &bytes).unwrap();
    let versions = bench.sim.versions(&name);
    assert_eq!(versions.len(), 1, "ours added no second version");
    assert_eq!(file.version, versions[0].0);
    assert!(
        bench.sim.pending().is_empty(),
        "our upload was aborted, not left billing"
    );
    assert_eq!(bench.sim.count("DELETE", "uploadId="), 1);
}

#[test]
fn a_different_file_completed_first_is_a_precondition_failure_and_our_upload_is_aborted() {
    let bench = Bench::new();
    let (folder, key, bytes) = (bench.folder(), attachment(), over_the_limit());
    let name = object(&folder, &key);
    bench.sim.interleave(&name, b"someone else's file");
    assert!(matches!(
        put(&parted(&bench), &folder, &key, None, &bytes),
        Err(RemoteError::PreconditionFailed { current: Some(current) }) if current.size == 19
    ));
    assert!(bench.sim.pending().is_empty());
    assert_eq!(
        bench.sim.object(&name).unwrap().bytes,
        b"someone else's file"
    );
}

#[test]
fn a_conflict_on_completion_aborts_the_upload_and_starts_it_again() {
    let bench = Bench::new();
    let (folder, key, bytes) = (bench.folder(), attachment(), over_the_limit());
    bench.sim.fault(Fault::new(
        "POST",
        "uploadId=",
        409,
        "ConditionalRequestConflict",
    ));
    put(&parted(&bench), &folder, &key, None, &bytes).unwrap();
    assert_eq!(bench.sim.count("POST", "?uploads"), 2);
    assert_eq!(bench.sim.count("DELETE", "uploadId="), 1);
    assert_eq!(
        bench.sim.count("PUT", "partNumber=1&"),
        2,
        "every part is sent again"
    );
    assert!(bench.sim.object(&object(&folder, &key)).unwrap().bytes == bytes);
    assert!(bench.sim.pending().is_empty());
}

#[test]
fn a_completion_answered_200_with_an_error_body_failed_and_the_next_try_only_completes() {
    let bench = Bench::new();
    let (folder, key, bytes) = (bench.folder(), attachment(), over_the_limit());
    let name = object(&folder, &key);
    bench
        .sim
        .fault(Fault::new("POST", "uploadId=", 200, "InternalError"));
    assert_eq!(
        put(&parted(&bench), &folder, &key, None, &bytes).unwrap_err(),
        RemoteError::Offline
    );
    assert!(
        bench.sim.object(&name).is_none(),
        "an error body is not a success"
    );
    assert_eq!(bench.sim.pending()[0].parts, [1, 2, 3, 4]);

    put(&parted(&bench), &folder, &key, None, &bytes).unwrap();
    assert_eq!(
        bench.sim.count("PUT", "partNumber="),
        4,
        "no part is sent twice"
    );
    assert!(bench.sim.object(&name).unwrap().bytes == bytes);
}

#[test]
fn an_upload_that_no_longer_exists_is_found_again_or_begun_again() {
    let bench = Bench::new();
    let (folder, key, bytes) = (bench.folder(), attachment(), over_the_limit());
    bench
        .sim
        .fault(Fault::new("PUT", "partNumber=2&", 404, "NoSuchUpload"));
    put(&parted(&bench), &folder, &key, None, &bytes).unwrap();
    assert!(bench.sim.object(&object(&folder, &key)).unwrap().bytes == bytes);
    assert!(bench.sim.pending().is_empty());
}

#[test]
fn stale_uploads_of_the_key_are_aborted_and_other_keys_are_left_alone() {
    let bench = Bench::new();
    let (folder, key, bytes) = (bench.folder(), attachment(), over_the_limit());
    let name = object(&folder, &key);
    bench.sim.begin_upload(&name);
    let other_file = bench.sim.begin_upload(&name);
    bench
        .sim
        .put_part(&name, &other_file, 1, &noise(SMALL_PARTS as usize));
    // `<key>0` starts with this key but is another key.
    let neighbour_key = format!("{name}0");
    let neighbour = bench.sim.begin_upload(&neighbour_key);

    put(&parted(&bench), &folder, &key, None, &bytes).unwrap();
    let pending = bench.sim.pending();
    assert_eq!(pending.len(), 1);
    assert_eq!(
        (pending[0].key.as_str(), pending[0].id.as_str()),
        (neighbour_key.as_str(), neighbour.as_str())
    );
    assert!(bench.sim.object(&name).unwrap().bytes == bytes);
}

#[test]
fn a_corrupted_download_of_an_upload_in_parts_is_refused() {
    let bench = Bench::new();
    let (folder, key, bytes) = (bench.folder(), attachment(), over_the_limit());
    let remote = parted(&bench);
    let file = put(&remote, &folder, &key, None, &bytes).unwrap();
    bench.sim.corrupt(&object(&folder, &key));
    let mut output = Vec::new();
    assert!(matches!(
        remote.download(&folder, &key, &file.version, &mut output),
        Err(RemoteError::Other(message)) if message.contains("checksum")
    ));
}

#[test]
fn a_part_is_never_smaller_than_the_five_mib_s3_requires() {
    let bench = Bench::new();
    let (folder, key, bytes) = (bench.folder(), attachment(), over_the_limit());
    let remote = bench.remote().with_part_size(1);
    put(&remote, &folder, &key, None, &bytes).unwrap();
    assert_eq!(bench.sim.count("PUT", "partNumber="), 4);
}

// ---- file identity ----------------------------------------------------------------------

#[test]
fn deleting_and_writing_again_is_another_file_and_removing_the_marker_restores_the_first() {
    let bench = Bench::new();
    let (remote, folder, key) = (bench.remote(), bench.folder(), ticket());
    let name = object(&folder, &key);
    let first = put(&remote, &folder, &key, None, b"one").unwrap();

    // A person deletes it in the bucket. The file is missing, not deleted for sync.
    let marker = bench.sim.delete(&name);
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
    // Its revisions are its own, not the first file's.
    let revisions = remote.revisions(&folder, &key).unwrap();
    assert_eq!(
        revisions
            .iter()
            .map(|r| r.version.as_str())
            .collect::<Vec<_>>(),
        [again.version.as_str()]
    );

    // The marker removed, the earlier file's identity is back, with both versions.
    bench.sim.remove_version(&name, &marker);
    let restored = remote.list(&folder).unwrap();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].file_id, first.file_id);
    assert_eq!(restored[0].created, first.created);
    assert_eq!(restored[0].version, again.version);
    assert_eq!(remote.revisions(&folder, &key).unwrap().len(), 2);
}

#[test]
fn a_non_ascii_name_survives_in_content_disposition_and_a_listing_names_the_file_by_its_key() {
    let bench = Bench::new();
    let (remote, folder, key) = (bench.remote(), bench.folder(), ticket());
    let title = "T-KQ9 Zażółć gęślą jaźń ✓ 日本語 & more.md";
    let file = remote
        .write(&folder, &key, title, None, &mut Cursor::new(b"x"))
        .unwrap();
    let stored = bench.sim.object(&object(&folder, &key)).unwrap();
    let disposition = stored.disposition.unwrap();
    let encoded = disposition
        .strip_prefix("attachment; filename*=UTF-8''")
        .unwrap();
    assert!(encoded.is_ascii());
    assert_eq!(
        percent_encoding::percent_decode_str(encoded)
            .decode_utf8()
            .unwrap(),
        title
    );
    assert_eq!(file.name, format!("{}.md", key.id));
    assert_eq!(remote.list(&folder).unwrap()[0].name, file.name);
    assert!(
        stored
            .metadata
            .iter()
            .any(|(name, value)| name == "x-amz-meta-ticketd-sha256" && *value == sha256_hex(b"x"))
    );
}

// ---- listings ---------------------------------------------------------------------------

#[test]
fn listings_page_with_key_and_version_markers_and_keep_their_order() {
    let bench = Bench::new();
    let (remote, folder) = (bench.remote(), bench.folder());
    bench.sim.page_size(2);
    let mut written = Vec::new();
    for n in 0..5 {
        let key = ticket();
        let first = put(&remote, &folder, &key, None, format!("v{n}").as_bytes()).unwrap();
        written.push((key, first));
    }
    // One file with many versions, so its versions straddle pages.
    let (key, mut latest) = written[2].clone();
    for n in 0..4 {
        latest = put(
            &remote,
            &folder,
            &key,
            Some(&latest.version),
            format!("edit {n}").as_bytes(),
        )
        .unwrap();
    }
    written[2].1 = latest.clone();

    let mut listed = remote.list(&folder).unwrap();
    listed.sort_by(|a, b| a.key.cmp(&b.key));
    written.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        listed,
        written
            .iter()
            .map(|(_, file)| file.clone())
            .collect::<Vec<_>>()
    );
    assert!(bench.sim.count("GET", "key-marker=") > 0);
    assert!(bench.sim.count("GET", "version-id-marker=") > 0);

    let revisions = remote.revisions(&folder, &key).unwrap();
    assert_eq!(revisions.len(), 5);
    assert_eq!(revisions.last().unwrap().version, latest.version);
    let expected: Vec<String> = bench
        .sim
        .versions(&object(&folder, &key))
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    assert_eq!(
        revisions
            .iter()
            .map(|r| r.version.clone())
            .collect::<Vec<_>>(),
        expected
    );
}

#[test]
fn folders_page_and_only_folders_with_a_marker_count() {
    let bench = Bench::new();
    let remote = bench.remote();
    bench.sim.page_size(2);
    let mut ids: Vec<String> = (0..5).map(|_| bench.folder()).collect();
    ids.sort();
    // Somebody else's data under the same prefix, and a prefix that is not a folder id.
    bench.sim.put_foreign("ticketd/stranger/readme.txt", b"hi");
    bench
        .sim
        .put_foreign("ticketd/not a folder id/readme.txt", b"hi");
    bench
        .sim
        .put_foreign("ticketd-other/elsewhere/readme.txt", b"hi");
    let found: Vec<String> = remote
        .folders()
        .unwrap()
        .into_iter()
        .map(|f| f.id)
        .collect();
    assert_eq!(found, ids);
    assert!(bench.sim.count("GET", "continuation-token=") > 0);
}

#[test]
fn files_that_are_not_ticketd_records_are_ignored() {
    let bench = Bench::new();
    let (remote, folder, key) = (bench.remote(), bench.folder(), ticket());
    let file = put(&remote, &folder, &key, None, b"one").unwrap();
    for stray in [
        "tickets/not-a-record.txt",
        "tickets/nested/deeper.md",
        "elsewhere/x.md",
        "tickets/bad id.md",
        "tickets/",
    ] {
        bench
            .sim
            .put_foreign(&format!("ticketd/{folder}/{stray}"), b"stray");
    }
    assert_eq!(remote.list(&folder).unwrap(), [file]);
}

#[test]
fn the_prefix_is_checked_and_the_folder_has_an_s3_address() {
    let bench = Bench::new();
    let make = |prefix: &str| S3Remote::new(target(), prefix, &bench.credentials, &bench.sim);
    assert!(make("").is_ok());
    assert!(make("/leading").is_err());
    assert!(make("a//b").is_err());
    assert!(make("with space/").is_err());
    let remote = make("team/ticketd").unwrap();
    assert_eq!(remote.prefix(), "team/ticketd/");
    assert_eq!(
        remote.folder_address("abc-1").unwrap(),
        format!("s3://{BUCKET}/team/ticketd/abc-1/")
    );
}

// ---- credentials and failures -----------------------------------------------------------

#[test]
fn expired_credentials_are_fetched_again_once() {
    let bench = Bench::with_credentials(FakeCredentials::new(&["token-1", "token-2"]));
    let (remote, folder) = (bench.remote(), bench.folder());
    // The session ends: S3 now wants the token the next export gives.
    bench.sim.accept_token("token-2");
    assert_eq!(remote.list(&folder), Ok(vec![]));
    assert_eq!(bench.credentials.forgets(), 1);
}

#[test]
fn credentials_that_stay_refused_become_unauthorized_after_one_new_fetch() {
    let bench = Bench::with_credentials(FakeCredentials::new(&["token-1", "token-2"]));
    let (remote, folder) = (bench.remote(), bench.folder());
    bench.sim.accept_token("token-3");
    let fetched = bench.credentials.fetches();
    assert_eq!(remote.list(&folder), Err(RemoteError::Unauthorized));
    assert_eq!(bench.credentials.fetches() - fetched, 2);
    assert_eq!(bench.credentials.forgets(), 1);
}

struct SignedOut;
impl CredentialSource for SignedOut {
    fn credentials(&self) -> Result<Credentials, AwsCliError> {
        Err(AwsCliError::SignInNeeded {
            message: "Token has expired and refresh failed".into(),
        })
    }
    fn forget(&self) {}
}

#[test]
fn an_ended_sign_in_needs_sign_in_and_sends_nothing() {
    let sim = S3Sim::default();
    let remote = S3Remote::new(target(), "ticketd/", &SignedOut, &sim).unwrap();
    assert_eq!(remote.list("folder"), Err(RemoteError::Unauthorized));
    assert!(sim.requests().is_empty());
}

#[test]
fn a_missing_bucket_or_marker_is_a_missing_folder() {
    let bench = Bench::new();
    let (remote, folder, key) = (bench.remote(), bench.folder(), ticket());
    put(&remote, &folder, &key, None, b"one").unwrap();
    // The marker is deleted in the bucket.
    bench
        .sim
        .delete(&format!("ticketd/{folder}/.ticketd-folder"));
    assert_eq!(remote.list(&folder), Err(RemoteError::FolderMissing));
    assert_eq!(
        put(&remote, &folder, &ticket(), None, b"two"),
        Err(RemoteError::FolderMissing)
    );

    let folder = bench.folder();
    bench.sim.remove_bucket();
    assert_eq!(remote.list(&folder), Err(RemoteError::FolderMissing));
    assert_eq!(
        bench.remote().list(&folder),
        Err(RemoteError::FolderMissing)
    );
    assert_eq!(
        put(&bench.remote(), &folder, &ticket(), None, b"x"),
        Err(RemoteError::FolderMissing)
    );
}

#[test]
fn slow_down_is_retried_with_backoff_and_then_rate_limited() {
    let bench = Bench::new();
    let (remote, folder) = (bench.remote(), bench.folder());
    let mut brief = Fault::new("GET", "versions", 503, "SlowDown");
    brief.times = 2;
    bench.sim.fault(brief);
    assert_eq!(remote.list(&folder), Ok(vec![]));
    let pauses = bench.pauses();
    assert_eq!(pauses.len(), 2);
    assert!(pauses[0] >= Duration::from_millis(500) && pauses[0] <= Duration::from_secs(1));
    assert!(pauses[1] >= Duration::from_secs(1) && pauses[1] <= Duration::from_secs(2));

    let before = bench.pauses().len();
    let mut lasting = Fault::new("GET", "versions", 503, "SlowDown");
    lasting.times = 100;
    bench.sim.fault(lasting);
    assert_eq!(
        remote.list(&folder),
        Err(RemoteError::RateLimited { retry_after: None })
    );
    assert_eq!(bench.pauses().len() - before, 4);
}

#[test]
fn a_long_retry_after_is_reported_not_waited_out() {
    let bench = Bench::new();
    let (remote, folder) = (bench.remote(), bench.folder());
    let mut asked = Fault::new("GET", "versions", 503, "SlowDown");
    asked.times = 100;
    asked.headers = vec![("Retry-After".into(), "300".into())];
    bench.sim.fault(asked);
    assert_eq!(
        remote.list(&folder),
        Err(RemoteError::RateLimited {
            retry_after: Some(Duration::from_secs(300))
        })
    );
    assert!(bench.pauses().is_empty());
}

#[test]
fn server_failures_are_retried_and_then_offline() {
    let bench = Bench::new();
    let (remote, folder) = (bench.remote(), bench.folder());
    let mut down = Fault::new("GET", "versions", 500, "InternalError");
    down.times = 100;
    bench.sim.fault(down);
    assert_eq!(remote.list(&folder), Err(RemoteError::Offline));
    assert_eq!(bench.pauses().len(), 4);
}

#[test]
fn no_network_is_offline_and_a_refused_permission_says_so() {
    let bench = Bench::new();
    let (remote, folder) = (bench.remote(), bench.folder());
    bench.sim.offline(true);
    assert_eq!(remote.list(&folder), Err(RemoteError::Offline));
    bench.sim.offline(false);

    bench
        .sim
        .fault(Fault::new("GET", "versions", 403, "AccessDenied"));
    assert!(matches!(
        remote.list(&folder),
        Err(RemoteError::Other(message)) if message.contains("denied")
    ));
}

// ---- the bucket allowlist and secrets -----------------------------------------------------

#[test]
fn the_transport_sends_only_to_the_configured_bucket() {
    let aws = target();
    let key = "ticketd/x/.ticketd-folder";
    assert!(aws.allows("GET", &aws.url(key, &[])));
    assert!(aws.allows("PUT", &aws.url(key, &[("versionId", "v1")])));
    assert!(aws.allows("GET", &aws.url("", &[("versions", ""), ("prefix", "a/b")])));
    assert_eq!(
        aws.url("a b/ü", &[("prefix", "a/b c")]),
        format!("https://{BUCKET}.s3.us-east-1.amazonaws.com/a%20b/%C3%BC?prefix=a%2Fb%20c")
    );
    for refused in [
        format!("https://other-bucket.s3.us-east-1.amazonaws.com/{key}"),
        format!("https://{BUCKET}.s3.eu-west-1.amazonaws.com/{key}"),
        format!("http://{BUCKET}.s3.us-east-1.amazonaws.com/{key}"),
        format!("https://user:pw@{BUCKET}.s3.us-east-1.amazonaws.com/{key}"),
        format!("https://{BUCKET}.s3.us-east-1.amazonaws.com.evil.example/{key}"),
        format!("https://evil.example/{BUCKET}/{key}"),
        format!("https://s3.us-east-1.amazonaws.com/{BUCKET}/{key}"),
    ] {
        assert!(!aws.allows("GET", &refused), "{refused}");
    }
    // An upload in parts is begun and completed with POST and abandoned with DELETE.
    assert!(aws.allows("POST", &aws.url(key, &[("uploads", "")])));
    assert!(aws.allows("DELETE", &aws.url(key, &[("uploadId", "u1")])));
    assert!(!aws.allows("PATCH", &aws.url(key, &[])));
    assert!(!aws.allows(
        "POST",
        &format!("https://evil.example/{BUCKET}/{key}?uploads")
    ));
    assert!(!aws.allows(
        "DELETE",
        &format!("https://other-bucket.s3.us-east-1.amazonaws.com/{key}?uploadId=u1")
    ));

    // An S3-compatible service takes the bucket in the path, at its own endpoint only.
    let minio = S3Target::new("ticketd-test", "us-east-1", Some("http://localhost:9000")).unwrap();
    assert_eq!(
        minio.url(key, &[]),
        "http://localhost:9000/ticketd-test/ticketd/x/.ticketd-folder"
    );
    assert!(minio.allows("GET", &minio.url(key, &[])));
    assert!(minio.allows("GET", &minio.url("", &[("versions", "")])));
    assert!(!minio.allows("GET", "http://localhost:9000/other-bucket/key"));
    assert!(!minio.allows("GET", "http://localhost:9001/ticketd-test/key"));
    assert!(!minio.allows("GET", "http://localhost:9000/ticketd-test/../other/key"));
    assert!(!minio.allows("GET", &aws.url(key, &[])));

    // A bucket name with a dot is not in the host, which a certificate would not cover.
    let dotted = S3Target::new("my.bucket", "eu-west-1", None).unwrap();
    assert_eq!(
        dotted.url("k", &[]),
        "https://s3.eu-west-1.amazonaws.com/my.bucket/k"
    );
    assert!(dotted.allows("GET", &dotted.url("k", &[])));
    assert!(!dotted.allows("GET", "https://s3.eu-west-1.amazonaws.com/other/k"));
}

#[test]
fn a_target_is_validated() {
    assert_eq!(
        S3Target::new("UPPER", "us-east-1", None),
        Err(S3TargetError::Bucket)
    );
    assert_eq!(
        S3Target::new("ab", "us-east-1", None),
        Err(S3TargetError::Bucket)
    );
    assert_eq!(
        S3Target::new("a..b", "us-east-1", None),
        Err(S3TargetError::Bucket)
    );
    assert_eq!(
        S3Target::new("valid-bucket", "", None),
        Err(S3TargetError::Region)
    );
    assert_eq!(
        S3Target::new("valid-bucket", "x/y", None),
        Err(S3TargetError::Region)
    );
    for endpoint in [
        "ftp://host",
        "https://host/path",
        "https://u:p@host",
        "nonsense",
        "https://host?x=1",
    ] {
        assert_eq!(
            S3Target::new("valid-bucket", "us-east-1", Some(endpoint)),
            Err(S3TargetError::Endpoint),
            "{endpoint}"
        );
    }
}

#[test]
fn the_real_transport_refuses_a_request_for_another_host_without_sending_it() {
    let transport = UreqS3Transport::new(target());
    let request = S3Request {
        method: "GET",
        url: "https://evil.example/ticketd-test/key".into(),
        headers: vec![("authorization".into(), "AWS4-HMAC-SHA256 secret".into())],
        body: vec![],
    };
    assert_eq!(
        transport.send(request).unwrap_err(),
        S3TransportError::NotAllowed
    );
}

/// Passes requests to the simulator and keeps a copy of each.
struct Spy<'a> {
    inner: &'a S3Sim,
    seen: Mutex<Vec<S3Request>>,
}

impl<'a> Spy<'a> {
    fn over(inner: &'a S3Sim) -> Self {
        Self {
            inner,
            seen: Mutex::new(vec![]),
        }
    }

    fn puts(&self) -> Vec<S3Request> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.method == "PUT" && !r.url.contains(".ticketd-folder"))
            .cloned()
            .collect()
    }
}

impl S3Transport for Spy<'_> {
    fn send(&self, request: S3Request) -> Result<S3Response, S3TransportError> {
        self.seen.lock().unwrap().push(request.clone());
        self.inner.send(request)
    }
}

fn header<'r>(request: &'r S3Request, name: &str) -> Option<&'r str> {
    request
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn no_credential_or_signature_is_in_anything_that_prints() {
    let bench = Bench::new();
    let spy = Spy::over(&bench.sim);
    let remote = S3Remote::new(target(), "ticketd/", &bench.credentials, &spy).unwrap();
    let folder = uuid::Uuid::new_v4().to_string();
    remote.ensure_folder(&folder, "Home").unwrap();
    let error = remote.list("no-such-folder").unwrap_err();

    let seen = spy.seen.lock().unwrap();
    assert!(!seen.is_empty());
    let request = &seen[0];
    let signature = header(request, "authorization")
        .unwrap()
        .split("Signature=")
        .nth(1)
        .unwrap()
        .to_owned();
    assert!(header(request, "x-amz-security-token").is_some());
    let printed = format!("{request:?} {error:?} {error} {:?}", remote.target());
    for secret in [
        signature.as_str(),
        "token-1",
        "secret-key-of-the-simulator",
        "AKIDSIM",
    ] {
        assert!(!printed.contains(secret), "{secret} was printed");
    }
    let credentials = bench.credentials.credentials().unwrap();
    assert!(!format!("{credentials:?}").contains("secret-key-of-the-simulator"));
}
