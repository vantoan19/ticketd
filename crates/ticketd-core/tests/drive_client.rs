//! The attachment adapters on the stateful Drive simulator: they share the one
//! Drive client with Workspace sync, so they authorize and fail the same way.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Test helpers fail the test.
use std::io::Cursor;
use std::sync::Mutex;

use serde_json::json;
use ticketd_core::drive::*;
use ticketd_core::sync::remote::RemoteStorage;

#[path = "support/drive_sim.rs"]
mod drive_sim;
use drive_sim::{DriveSim, Fault, Vault};

const CONNECTION: &str = "6a0b8b0e-93a5-4d6c-9a43-0d3f5f1f2c11";
const FOLDER: &str = "application/vnd.google-apps.folder";

fn sim_with_folder() -> DriveSim {
    let sim = DriveSim::default();
    sim.insert(
        json!({"id": "uploads", "name": "Uploads", "mimeType": FOLDER, "appProperties": {}}),
        b"",
    );
    sim
}

fn operation(id: &str, bytes: &[u8]) -> DriveUploadOperation {
    DriveUploadOperation {
        request_id: "request".into(),
        attachment_id: "attachment".into(),
        remote_file_id: Some(id.into()),
        request: DriveUploadRequest {
            destination: DriveUploadDestination {
                connection_id: CONNECTION.into(),
                folder_id: "uploads".into(),
                resource_key: None,
            },
            filename: "trace.log".into(),
            size_bytes: bytes.len() as u64,
            sha256: "digest".into(),
        },
        state: DriveUploadState::Uncertain,
        provenance: None,
        record_removed: false,
    }
}

fn stored(sim: &DriveSim, id: &str, bytes: &[u8], properties: serde_json::Value) {
    sim.insert(
        json!({"id": id, "name": "trace.log", "mimeType": "application/octet-stream",
            "parents": ["uploads"], "appProperties": properties}),
        bytes,
    );
}

/// Replaceable credentials: what signing in again does to the secure store.
struct Credentials(Mutex<String>);
impl CredentialStore for Credentials {
    fn load(&self, _: &str) -> Result<DriveCredential, DriveError> {
        Ok(DriveCredential {
            client_id: "client".into(),
            client_secret: None,
            refresh_token: self.0.lock().unwrap().clone(),
        })
    }
    fn save(&self, _: &str, credential: &DriveCredential) -> Result<(), DriveError> {
        *self.0.lock().unwrap() = credential.refresh_token.clone();
        Ok(())
    }
}

#[test]
fn requests_share_one_access_token_and_a_refused_token_is_renewed_once() {
    let sim = sim_with_folder();
    stored(&sim, "blob", b"bytes", json!({}));
    let drive = GoogleDrive::new(CONNECTION, &Vault, &sim);
    drive.folder("uploads", None).unwrap();
    drive.reserve_file_id().unwrap();
    assert!(drive.uploaded_file("blob").unwrap().is_some());
    assert_eq!(sim.count("POST", "/token"), 1);

    sim.expire_access_token();
    drive.folder("uploads", None).unwrap();
    drive.reserve_file_id().unwrap();
    assert_eq!(
        sim.count("POST", "/token"),
        2,
        "the refusal renewed the token once; later requests reuse it"
    );
}

#[test]
fn a_withdrawn_grant_asks_to_reconnect_without_renewing_in_a_loop() {
    let sim = sim_with_folder();
    let drive = GoogleDrive::new(CONNECTION, &Vault, &sim);
    drive.folder("uploads", None).unwrap();
    sim.revoke();
    let error = drive.folder("uploads", None).unwrap_err();
    assert_eq!(error.kind, DriveErrorKind::Reauthorize);
    assert_eq!(sim.count("POST", "/token"), 2);
}

#[test]
fn a_kept_adapter_uses_the_credential_stored_by_a_later_sign_in() {
    let sim = sim_with_folder();
    let credentials = Credentials(Mutex::new("first".into()));
    let drive = GoogleDrive::new(CONNECTION, &credentials, &sim);
    let remote = DriveRemote::new(CONNECTION, &credentials, &sim);
    drive.folder("uploads", None).unwrap();
    assert_eq!(remote.folders(), Ok(vec![]));

    // Signing in again replaces the refresh token and ends the old access token.
    sim.rotate_refresh_token("second");
    *credentials.0.lock().unwrap() = "second".into();
    drive.folder("uploads", None).unwrap();
    assert!(!drive.reserve_file_id().unwrap().is_empty());
    sim.rotate_refresh_token("third");
    *credentials.0.lock().unwrap() = "third".into();
    assert_eq!(remote.folders(), Ok(vec![]));
}

#[test]
fn an_uploaded_copy_is_created_under_its_reserved_id_with_one_authorization() {
    let sim = sim_with_folder();
    let drive = GoogleDrive::new(CONNECTION, &Vault, &sim);
    let id = drive.reserve_file_id().unwrap();
    let bytes = vec![7u8; 256 * 1024 + 3];
    let mut progress = Vec::new();
    drive
        .upload_blob(
            &operation(&id, &bytes),
            &mut Cursor::new(bytes.clone()),
            &mut |sent, _| {
                progress.push(sent);
                true
            },
        )
        .unwrap();
    assert_eq!(progress.last(), Some(&(bytes.len() as u64)));

    let file = drive.uploaded_file(&id).unwrap().unwrap();
    assert_eq!(file.operation_id.as_deref(), Some("attachment"));
    assert_eq!(file.parent_ids, ["uploads"]);
    assert_eq!(file.metadata.size_bytes, Some(bytes.len() as u64));
    assert_eq!(
        sim.count("POST", "/token"),
        1,
        "reserving, creating, sending two chunks and reading back"
    );
    assert_eq!(drive.uploaded_file("never-created").unwrap(), None);
}

#[test]
fn an_uploaded_copy_is_never_retried_automatically() {
    let sim = sim_with_folder();
    let drive = GoogleDrive::new(CONNECTION, &Vault, &sim);

    sim.fault(Fault::new("GET", "generateIds", 503));
    assert_eq!(
        drive.reserve_file_id().unwrap_err().kind,
        DriveErrorKind::Offline
    );
    assert_eq!(sim.count("GET", "generateIds"), 1);

    sim.fault(Fault {
        body: r#"{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}"#,
        ..Fault::new("POST", "/upload/drive/v3/files", 403)
    });
    let id = drive.reserve_file_id().unwrap();
    let error = drive
        .upload_blob(
            &operation(&id, b"bytes"),
            &mut Cursor::new(b"bytes"),
            &mut |_, _| true,
        )
        .unwrap_err();
    assert_eq!(error.kind, DriveErrorKind::RateLimited);
    assert_eq!(sim.count("POST", "/upload/drive/v3/files"), 1);

    // A chunk whose response is lost leaves the outcome for reconciliation.
    sim.fault(Fault {
        after_applying: true,
        ..Fault::new("PUT", "upload_id=", 503)
    });
    let error = drive
        .upload_blob(
            &operation(&id, b"bytes"),
            &mut Cursor::new(b"bytes"),
            &mut |_, _| true,
        )
        .unwrap_err();
    assert_eq!(error.kind, DriveErrorKind::Offline);
    assert_eq!(sim.count("PUT", "upload_id="), 1);
    assert!(drive.uploaded_file(&id).unwrap().is_some());
}

#[test]
fn a_repeated_create_under_the_same_id_is_left_for_reconciliation() {
    let sim = sim_with_folder();
    let drive = GoogleDrive::new(CONNECTION, &Vault, &sim);
    stored(
        &sim,
        "taken",
        b"earlier",
        json!({"ticketdUpload": "attachment"}),
    );
    drive
        .upload_blob(
            &operation("taken", b"bytes"),
            &mut Cursor::new(b"bytes"),
            &mut |_, _| true,
        )
        .unwrap();
    assert_eq!(sim.count("PUT", "upload_id="), 0, "no bytes were sent");
}

#[test]
fn copies_of_one_account_share_a_token_and_read_exact_ranges() {
    let sim = sim_with_folder();
    let bytes: Vec<u8> = (0..=255u8).cycle().take(256 * 1024 + 5).collect();
    stored(&sim, "blob", &bytes, json!({}));
    let copies = GoogleDriveCopies::new(&Vault, &sim);
    let reference = DriveReference {
        connection_id: CONNECTION.into(),
        metadata: DriveMetadata {
            id: "blob".into(),
            name: "trace.log".into(),
            mime_type: "application/octet-stream".into(),
            size_bytes: Some(bytes.len() as u64),
            web_url: "https://drive.google.com/file/d/blob/view".into(),
            resource_key: None,
        },
    };
    let observed = copies.inspect(&reference).unwrap();
    assert_eq!(observed.can_download, Some(true));
    let mut output = Vec::new();
    copies
        .download(&reference, bytes.len() as u64, &mut output)
        .unwrap();
    assert_eq!(output, bytes);
    assert_eq!(sim.count("POST", "/token"), 1);

    sim.fault(Fault {
        body: "x",
        headers: vec![("Content-Range".into(), "bytes 9-9/10".into())],
        ..Fault::new("GET", "alt=media", 206)
    });
    let mut refused = Vec::new();
    assert!(
        copies
            .download(&reference, 256 * 1024 + 5, &mut refused)
            .is_err()
    );
    assert!(refused.is_empty());
}

#[test]
fn errors_are_classified_alike_for_every_request() {
    let sim = sim_with_folder();
    let drive = GoogleDrive::new(CONNECTION, &Vault, &sim);
    for (status, body, kind) in [
        (
            403,
            r#"{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}"#,
            DriveErrorKind::RateLimited,
        ),
        (429, "{}", DriveErrorKind::RateLimited),
        (
            403,
            r#"{"error":{"errors":[{"reason":"insufficientFilePermissions"}]}}"#,
            DriveErrorKind::PermissionDenied,
        ),
        (
            403,
            r#"{"error":{"errors":[{"reason":"appNotAuthorizedToFile"}]}}"#,
            DriveErrorKind::SelectFile,
        ),
        (503, "{}", DriveErrorKind::Offline),
        (404, "{}", DriveErrorKind::InaccessibleOrMissing),
    ] {
        for url in ["generateIds", "/files/uploads?"] {
            sim.fault(Fault {
                body,
                ..Fault::new("GET", url, status)
            });
        }
        assert_eq!(drive.reserve_file_id().unwrap_err().kind, kind, "{status}");
        assert_eq!(drive.folder("uploads", None).unwrap_err().kind, kind);
    }
}
