//! Google Drive specifics of the sync adapter on the controlled transport:
//! layout, authorization renewal, pagination, retries and recovery states.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Test helpers fail the test.
use std::io::Cursor;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use ticketd_core::drive::DriveRemote;
use ticketd_core::sync::remote::*;

#[path = "support/drive_sim.rs"]
mod drive_sim;
use drive_sim::{DriveSim, Fault, Vault};

const CONNECTION: &str = "6a0b8b0e-93a5-4d6c-9a43-0d3f5f1f2c11";
const FOLDER: &str = "0c0ffee0-0000-4000-8000-000000000001";
const RATE_LIMITED: &str = r#"{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}"#;

fn remote(sim: &DriveSim) -> DriveRemote<'_> {
    DriveRemote::new(CONNECTION, &Vault, sim).with_pause(|_| panic!("this scenario must not wait"))
}

fn timed<'a>(sim: &'a DriveSim, pauses: &'a Mutex<Vec<Duration>>) -> DriveRemote<'a> {
    DriveRemote::new(CONNECTION, &Vault, sim).with_pause(|pause| pauses.lock().unwrap().push(pause))
}

fn key(id: &str) -> RemoteKey {
    RemoteKey::new(RemoteKind::Ticket, id)
}

fn put(
    remote: &DriveRemote,
    key: &RemoteKey,
    expected: Option<&str>,
    bytes: &[u8],
) -> Result<RemoteFile, RemoteError> {
    let name = format!("{}.md", key.id);
    remote.write(FOLDER, key, &name, expected, &mut Cursor::new(bytes))
}

fn connected(sim: &DriveSim) -> DriveRemote<'_> {
    let remote = remote(sim);
    remote.ensure_folder(FOLDER, "ticketd Home").unwrap();
    remote
}

#[test]
fn files_live_in_a_visible_folder_identified_by_properties_with_readable_names() {
    let sim = DriveSim::default();
    let remote = connected(&sim);
    let ticket = key("3f2c9a1e-0000-4000-8000-00000000000a");
    remote
        .write(
            FOLDER,
            &ticket,
            "T-KQ43 Fix login.md",
            None,
            &mut Cursor::new(b"# Fix login"),
        )
        .unwrap();
    let attachment = RemoteKey::new(
        RemoteKind::Attachment,
        "3f2c9a1e-0000-4000-8000-00000000000b",
    );
    remote
        .write(
            FOLDER,
            &attachment,
            "diagram.png",
            None,
            &mut Cursor::new(b"\x89PNG"),
        )
        .unwrap();

    let items = sim.items();
    let named = |name: &str| {
        items
            .iter()
            .find(|item| item["name"] == name)
            .unwrap()
            .clone()
    };
    let root = named("ticketd Home");
    assert_eq!(
        root["parents"],
        json!([]),
        "the folder is visible in My Drive"
    );
    assert_eq!(root["mimeType"], "application/vnd.google-apps.folder");
    assert_eq!(root["appProperties"]["ticketdSync"], FOLDER);
    let attachments = named("attachments");
    assert_eq!(attachments["parents"], json!([root["id"]]));

    let file = named("T-KQ43 Fix login.md");
    assert_eq!(file["parents"], json!([named("tickets")["id"]]));
    assert_eq!(file["mimeType"], "text/markdown");
    assert_eq!(
        file["appProperties"],
        json!({"ticketdKind": "ticket", "ticketdId": ticket.id})
    );
    assert!(
        file["id"].as_str().unwrap().starts_with("file-"),
        "the ID was pre-generated"
    );
    let blob = named("diagram.png");
    assert_eq!(blob["parents"], json!([attachments["id"]]));
    assert_eq!(blob["appProperties"]["ticketdKind"], "attachment");
    for name in [
        "documents",
        "plans",
        "projects",
        "automations",
        "automation_agents",
    ] {
        assert_eq!(named(name)["parents"], json!([root["id"]]));
    }
    assert_eq!(
        items.len(),
        10,
        "one folder, seven subfolders and two files"
    );
}

#[test]
fn an_expired_access_token_is_renewed_once_and_a_withdrawn_grant_asks_to_reconnect() {
    let sim = DriveSim::default();
    let remote = connected(&sim);
    put(&remote, &key("a"), None, b"a").unwrap();
    assert_eq!(remote.list(FOLDER).unwrap().len(), 1);
    assert_eq!(
        sim.count("POST", "/token"),
        1,
        "one access token serves many requests"
    );

    sim.expire_access_token();
    assert_eq!(remote.list(FOLDER).unwrap().len(), 1);
    assert_eq!(sim.count("POST", "/token"), 2);

    sim.revoke();
    assert_eq!(remote.list(FOLDER), Err(RemoteError::Unauthorized));
    assert_eq!(
        put(&remote, &key("b"), None, b"b"),
        Err(RemoteError::Unauthorized)
    );
    assert_eq!(sim.items().len(), 9, "nothing was written or removed");
}

#[test]
fn listings_and_revisions_follow_every_page() {
    let sim = DriveSim::default();
    let remote = connected(&sim);
    let ticket = key("paged");
    let mut version = put(&remote, &ticket, None, b"0").unwrap().version;
    for n in 1..5u8 {
        version = put(&remote, &ticket, Some(&version), &[n]).unwrap().version;
    }
    for id in ["b", "c", "d", "e"] {
        put(&remote, &key(id), None, id.as_bytes()).unwrap();
    }
    sim.page_size(2);
    let mut listed: Vec<String> = remote
        .list(FOLDER)
        .unwrap()
        .into_iter()
        .map(|file| file.key.id)
        .collect();
    listed.sort();
    assert_eq!(listed, ["b", "c", "d", "e", "paged"]);
    assert_eq!(
        sim.count("GET", "pageToken="),
        8,
        "three more pages of eight folders, five more of twelve folder entries"
    );
    let revisions = remote.revisions(FOLDER, &ticket).unwrap();
    assert_eq!(revisions.len(), 5);
    assert_eq!(revisions[4].version, version);
}

#[test]
fn rate_limits_are_retried_with_growing_jittered_waits_then_reported() {
    let sim = DriveSim::default();
    connected(&sim);
    let pauses = Mutex::new(Vec::new());
    let remote = timed(&sim, &pauses);

    sim.fault(Fault {
        times: 2,
        body: RATE_LIMITED,
        ..Fault::new("GET", "/drive/v3/files?", 403)
    });
    assert_eq!(remote.list(FOLDER), Ok(vec![]));
    let waited = std::mem::take(&mut *pauses.lock().unwrap());
    assert_eq!(waited.len(), 2);
    assert!((500..=1000).contains(&waited[0].as_millis()), "{waited:?}");
    assert!((1000..=2000).contains(&waited[1].as_millis()), "{waited:?}");

    sim.fault(Fault {
        times: 5,
        headers: vec![("Retry-After".into(), "30".into())],
        ..Fault::new("GET", "/drive/v3/files?", 429)
    });
    assert_eq!(
        remote.list(FOLDER),
        Err(RemoteError::RateLimited {
            retry_after: Some(Duration::from_secs(30))
        })
    );
    let waited = std::mem::take(&mut *pauses.lock().unwrap());
    assert_eq!(
        waited,
        [Duration::from_secs(30); 4],
        "the server's wait is honoured"
    );
    assert_eq!(remote.list(FOLDER), Ok(vec![]));
}

#[test]
fn server_failures_are_retried_then_reported_as_offline() {
    let sim = DriveSim::default();
    connected(&sim);
    let pauses = Mutex::new(Vec::new());
    let remote = timed(&sim, &pauses);
    sim.fault(Fault {
        times: 5,
        ..Fault::new("GET", "/drive/v3/files?", 503)
    });
    assert_eq!(remote.list(FOLDER), Err(RemoteError::Offline));
    let waited = pauses.lock().unwrap().clone();
    assert_eq!(waited.len(), 4);
    for (attempt, pause) in waited.iter().enumerate() {
        let ceiling = 1000u128 << attempt;
        assert!(
            (ceiling / 2..=ceiling).contains(&pause.as_millis()),
            "{waited:?}"
        );
    }
}

#[test]
fn a_revision_listing_that_fails_for_a_transient_reason_is_not_a_missing_file() {
    let sim = DriveSim::default();
    let remote = connected(&sim);
    let pauses = Mutex::new(Vec::new());
    let timed = timed(&sim, &pauses);
    let ticket = key("a");
    put(&remote, &ticket, None, b"a").unwrap();
    timed.list(FOLDER).unwrap();
    let lookups = sim.count("GET", "/drive/v3/files?");

    sim.fault(Fault {
        times: 5,
        ..Fault::new("GET", "/revisions?", 503)
    });
    assert_eq!(timed.revisions(FOLDER, &ticket), Err(RemoteError::Offline));

    sim.fault(Fault {
        times: 5,
        headers: vec![("Retry-After".into(), "30".into())],
        ..Fault::new("GET", "/revisions?", 429)
    });
    assert_eq!(
        timed.revisions(FOLDER, &ticket),
        Err(RemoteError::RateLimited {
            retry_after: Some(Duration::from_secs(30))
        })
    );

    sim.fault(Fault {
        times: 2,
        ..Fault::new("GET", "/revisions?", 401)
    });
    assert_eq!(
        timed.revisions(FOLDER, &ticket),
        Err(RemoteError::Unauthorized)
    );

    assert_eq!(timed.revisions(FOLDER, &ticket).unwrap().len(), 1);
    assert_eq!(
        sim.count("GET", "/drive/v3/files?"),
        lookups,
        "the file's ID stayed cached through every failure"
    );
}

#[test]
fn a_revision_listing_of_a_file_drive_no_longer_has_is_missing() {
    let sim = DriveSim::default();
    let remote = connected(&sim);
    let ticket = key("a");
    put(&remote, &ticket, None, b"a").unwrap();
    sim.fault(Fault::new("GET", "/revisions?", 404));
    assert_eq!(
        remote.revisions(FOLDER, &ticket),
        Err(RemoteError::NotFound)
    );
}

#[test]
fn full_storage_no_network_and_a_removed_folder_are_reported_without_waiting() {
    let sim = DriveSim::default();
    let remote = connected(&sim);
    let stored = put(&remote, &key("kept"), None, b"kept").unwrap();

    sim.fault(Fault {
        body: r#"{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}"#,
        ..Fault::new("POST", "/upload/drive/v3/files", 403)
    });
    assert_eq!(
        put(&remote, &key("full"), None, b"x"),
        Err(RemoteError::StorageFull)
    );

    sim.offline(true);
    assert_eq!(remote.list(FOLDER), Err(RemoteError::Offline));
    assert_eq!(
        put(&remote, &key("kept"), Some(&stored.version), b"edit"),
        Err(RemoteError::Offline)
    );
    sim.offline(false);
    assert_eq!(remote.list(FOLDER).unwrap(), [stored]);

    let root = sim
        .items()
        .into_iter()
        .find(|item| item["name"] == "ticketd Home")
        .unwrap();
    sim.trash(root["id"].as_str().unwrap());
    assert_eq!(remote.list(FOLDER), Err(RemoteError::FolderMissing));
    assert_eq!(remote.folders(), Ok(vec![]));
    assert_eq!(
        put(&remote, &key("after"), None, b"x"),
        Err(RemoteError::FolderMissing)
    );
}

#[test]
fn a_lost_upload_response_never_stores_the_file_twice() {
    let sim = DriveSim::default();
    connected(&sim);
    let pauses = Mutex::new(Vec::new());
    let remote = timed(&sim, &pauses);
    let ticket = key("once");

    // The final chunk is stored but its response is lost once: the retry
    // inside the call gets the stored file back.
    sim.fault(Fault {
        after_applying: true,
        ..Fault::new("PUT", "upload_id=", 503)
    });
    let created = put(&remote, &ticket, None, b"first").unwrap();
    assert_eq!(remote.revisions(FOLDER, &ticket).unwrap().len(), 1);

    // Every response is lost: the call fails, and repeating it finds the write applied.
    sim.fault(Fault {
        after_applying: true,
        times: 5,
        ..Fault::new("PUT", "upload_id=", 503)
    });
    assert_eq!(
        put(&remote, &ticket, Some(&created.version), b"second"),
        Err(RemoteError::Offline)
    );
    let another_device = timed(&sim, &pauses);
    let repeated = put(&another_device, &ticket, Some(&created.version), b"second").unwrap();
    assert_ne!(repeated.version, created.version);
    assert_eq!(remote.list(FOLDER).unwrap(), [repeated]);
    assert_eq!(remote.revisions(FOLDER, &ticket).unwrap().len(), 2);
}

#[test]
fn duplicate_files_of_one_record_resolve_to_the_oldest_on_every_device() {
    let sim = DriveSim::default();
    let remote = connected(&sim);
    let ticket = key("twice");
    let oldest = put(&remote, &ticket, None, b"oldest").unwrap();
    let root = sim
        .items()
        .into_iter()
        .find(|item| item["name"] == "ticketd Home")
        .unwrap();
    // Two devices created the same record before either saw the other's file.
    sim.insert(
        json!({"id": "late-duplicate", "name": "twice.md", "mimeType": "text/markdown",
            "parents": [root["id"]], "appProperties": {"ticketdKind": "ticket", "ticketdId": "twice"}}),
        b"newer duplicate",
    );
    let other_device = self::remote(&sim);
    assert_eq!(
        other_device.list(FOLDER).unwrap(),
        std::slice::from_ref(&oldest)
    );
    assert_eq!(
        put(&other_device, &ticket, None, b"mine"),
        Err(RemoteError::PreconditionFailed {
            current: Some(Box::new(oldest.clone()))
        })
    );
    let updated = put(&other_device, &ticket, Some(&oldest.version), b"merged").unwrap();
    assert_eq!(remote.list(FOLDER).unwrap(), [updated]);
}

#[test]
fn a_file_trashed_in_drive_is_missing_until_it_is_uploaded_again() {
    let sim = DriveSim::default();
    let remote = connected(&sim);
    let ticket = key("trashed");
    let stored = put(&remote, &ticket, None, b"content").unwrap();
    let id = sim
        .items()
        .into_iter()
        .find(|item| item["name"] == "trashed.md")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    sim.trash(&id);
    assert_eq!(remote.list(FOLDER), Ok(vec![]));
    assert_eq!(
        put(&remote, &ticket, Some(&stored.version), b"edit"),
        Err(RemoteError::PreconditionFailed { current: None })
    );
    let again = put(&remote, &ticket, None, b"content").unwrap();
    assert_eq!(remote.list(FOLDER).unwrap(), [again]);
}

#[test]
fn the_change_feed_probe_reports_files_written_since_its_token() {
    let sim = DriveSim::default();
    let remote = connected(&sim);
    let (none, start) = remote.changed_file_ids(None).unwrap();
    assert!(none.is_empty());
    put(&remote, &key("changed"), None, b"x").unwrap();
    let (ids, next) = remote.changed_file_ids(Some(&start)).unwrap();
    assert_eq!(ids.len(), 1);
    assert!(ids[0].starts_with("file-"));
    assert_eq!(
        remote.changed_file_ids(Some(&next)).unwrap().0,
        Vec::<String>::new()
    );
}

/// F31: the production transport refuses requests outside its allow-list, and
/// tests run on a fake transport. Every request shape sync sends goes through
/// the production predicate here (the fake also checks each request it gets).
#[test]
fn the_production_transport_allows_every_request_sync_sends() {
    let sim = DriveSim::default();
    let remote = connected(&sim);
    let ticket = key("3f2c9a1e-0000-4000-8000-00000000000b");
    let big = vec![7_u8; 300 * 1024];
    let first = put(&remote, &ticket, None, &big).unwrap();
    let second = put(&remote, &ticket, Some(&first.version), b"edit").unwrap();
    remote.list(FOLDER).unwrap();
    remote.folders().unwrap();
    remote.revisions(FOLDER, &ticket).unwrap();
    let mut bytes = Vec::new();
    remote
        .download(FOLDER, &ticket, &first.version, &mut bytes)
        .unwrap();
    assert_eq!(bytes, big);
    remote
        .download(FOLDER, &ticket, &second.version, &mut Vec::new())
        .unwrap();
    let (_, start) = remote.changed_file_ids(None).unwrap();
    remote.changed_file_ids(Some(&start)).unwrap();

    let requests = sim.requests();
    let sent = |method: &str, part: &str| {
        requests
            .iter()
            .any(|(m, url)| m == method && url.contains(part))
    };
    for (method, part) in [
        ("POST", "oauth2.googleapis.com/token"),
        ("GET", "/drive/v3/files?q="),
        ("GET", "/drive/v3/files/generateIds?"),
        ("POST", "/drive/v3/files?supportsAllDrives=true&fields=id"),
        ("POST", "/upload/drive/v3/files?uploadType=resumable"),
        ("PATCH", "/upload/drive/v3/files/"),
        ("PUT", "upload_id="),
        ("GET", "/revisions?"),
        ("GET", "?fields=id,size"),
        ("GET", "?alt=media"),
        ("GET", "/drive/v3/changes/startPageToken"),
        ("GET", "/drive/v3/changes?"),
    ] {
        assert!(
            sent(method, part),
            "the scenario never sent {method} {part}"
        );
    }
    for (method, url) in &requests {
        assert!(
            ticketd_core::drive::request_allowed(method, url),
            "GoogleTransport refuses {method} {url}"
        );
    }
    // Credentials go nowhere else.
    for (method, url) in [
        ("GET", "https://www.googleapis.com/drive/v3/about?fields=*"),
        ("GET", "https://example.com/drive/v3/files/x"),
        ("DELETE", "https://www.googleapis.com/drive/v3/files/x"),
        (
            "POST",
            "https://www.googleapis.com/drive/v3/files/x/permissions",
        ),
    ] {
        assert!(!ticketd_core::drive::request_allowed(method, url));
    }
}

/// F44: the server's wait is honoured only up to a minute; beyond that the run
/// ends rate limited instead of holding the app for as long as a header says.
#[test]
fn a_download_that_answers_another_range_than_asked_is_refused() {
    let sim = DriveSim::default();
    let remote = connected(&sim);
    let ticket = key("ranged");
    let file = put(&remote, &ticket, None, b"hello").unwrap();
    for range in ["bytes 5-9/10", "bytes 0-4/6", "bytes 0-3/5"] {
        sim.fault(Fault {
            body: "world",
            headers: vec![("Content-Range".into(), range.into())],
            ..Fault::new("GET", "alt=media", 206)
        });
        let mut bytes = Vec::new();
        assert!(
            matches!(
                remote.download(FOLDER, &ticket, &file.version, &mut bytes),
                Err(RemoteError::Other(_))
            ),
            "{range}"
        );
        assert!(bytes.is_empty(), "{range}");
    }
    let mut bytes = Vec::new();
    remote
        .download(FOLDER, &ticket, &file.version, &mut bytes)
        .unwrap();
    assert_eq!(bytes, b"hello");
}

#[test]
fn a_long_retry_after_ends_the_call_instead_of_waiting() {
    let sim = DriveSim::default();
    let remote = connected(&sim);
    sim.fault(Fault {
        headers: vec![("Retry-After".into(), "86400".into())],
        ..Fault::new("GET", "/drive/v3/files?", 429)
    });
    // `connected` panics on any wait.
    assert_eq!(
        remote.list(FOLDER),
        Err(RemoteError::RateLimited {
            retry_after: Some(Duration::from_secs(86400))
        })
    );
    assert_eq!(remote.list(FOLDER), Ok(vec![]));
}

/// F54: the engine tells an older file that came back from one written after
/// it by the file's identity and creation time, so the adapter must keep both
/// through an update and give a file that is written again new ones.
#[test]
fn a_file_keeps_its_identity_through_an_update_and_one_written_again_is_another_made_later() {
    let sim = DriveSim::default();
    let remote = connected(&sim);
    let ticket = key("identity");
    let first = put(&remote, &ticket, None, b"one").unwrap();
    assert!(chrono::DateTime::parse_from_rfc3339(&first.created).is_ok());

    let updated = put(&remote, &ticket, Some(&first.version), b"two").unwrap();
    assert_ne!(updated.version, first.version);
    assert_eq!(
        (&updated.file_id, &updated.created),
        (&first.file_id, &first.created)
    );
    assert_eq!(remote.list(FOLDER).unwrap(), std::slice::from_ref(&updated));

    sim.trash(&first.file_id);
    let again = put(&remote, &ticket, None, b"two").unwrap();
    assert_ne!(again.file_id, first.file_id);
    let made = |file: &RemoteFile| chrono::DateTime::parse_from_rfc3339(&file.created).unwrap();
    assert!(made(&again) > made(&first));
    assert_eq!(remote.list(FOLDER).unwrap(), [again]);
}
