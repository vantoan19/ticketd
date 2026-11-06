use std::{io::Cursor, sync::Mutex};
use ticketd_core::drive::*;
struct Vault;
impl CredentialStore for Vault {
    fn load(&self, _: &str) -> Result<DriveCredential, DriveError> {
        Ok(DriveCredential {
            client_id: "client".into(),
            client_secret: None,
            refresh_token: "private-refresh".into(),
        })
    }
    fn save(&self, _: &str, _: &DriveCredential) -> Result<(), DriveError> {
        Ok(())
    }
}
struct Http {
    responses: Mutex<Vec<DriveResponse>>,
    requests: Mutex<Vec<DriveRequest>>,
}
#[allow(clippy::unwrap_used)] // Fixture synchronization failures must fail the test.
impl DriveTransport for Http {
    fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError> {
        self.requests.lock().unwrap().push(request);
        Ok(self.responses.lock().unwrap().remove(0))
    }
}
fn response(status: u16, body: &str, headers: Vec<(String, String)>) -> DriveResponse {
    DriveResponse {
        status,
        body: body.as_bytes().to_vec(),
        headers,
    }
}
#[test]
fn blob_upload_uses_reserved_identity_chunks_and_transient_pinned_session_only() {
    let session = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=private-session";
    let http = Http {
        requests: Mutex::new(vec![]),
        responses: Mutex::new(vec![
            response(200, r#"{"access_token":"private-access"}"#, vec![]),
            response(200, "", vec![("location".into(), session.into())]),
            response(200, "{}", vec![]),
        ]),
    };
    let provider = GoogleDrive::new("connection", &Vault, &http);
    let operation = DriveUploadOperation {
        request_id: "request".into(),
        attachment_id: "attachment".into(),
        remote_file_id: Some("reserved".into()),
        request: DriveUploadRequest {
            destination: DriveUploadDestination {
                connection_id: "connection".into(),
                folder_id: "folder".into(),
                resource_key: None,
            },
            filename: "trace.log".into(),
            size_bytes: 5,
            sha256: "digest".into(),
        },
        state: DriveUploadState::Uncertain,
        provenance: None,
    };
    let mut progress = vec![];
    provider
        .upload_blob(&operation, &mut Cursor::new(b"bytes"), &mut |copied, _| {
            progress.push(copied);
            true
        })
        .unwrap();
    let requests = http.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|r| r.url == "https://oauth2.googleapis.com/token")
            .count(),
        1,
        "one bounded upload should reuse its in-memory access token across chunks"
    );
    let create: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(create["id"], "reserved");
    assert_eq!(create["parents"][0], "folder");
    assert_eq!(create["appProperties"]["ticketdUpload"], "attachment");
    assert_eq!(requests[2].method, "PUT");
    assert_eq!(requests[2].body, b"bytes");
    assert!(
        requests[2]
            .headers
            .contains(&("Content-Range".into(), "bytes 0-4/5".into()))
    );
    assert_eq!(progress.last(), Some(&5));
    assert!(!format!("{requests:?}").contains("private-"));
    assert!(
        requests
            .iter()
            .all(|r| !matches!(r.method, "DELETE" | "PATCH"))
    );
}

#[test]
fn unsafe_sessions_conflicts_expiry_and_cancellation_never_change_id_or_delete_remote_content() {
    for (status, location, expected_puts) in [
        (200, "https://attacker.example/steal", 0),
        (409, "", 0),
        (
            200,
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=private-session",
            1,
        ),
    ] {
        let mut responses = vec![
            response(200, r#"{"access_token":"access"}"#, vec![]),
            response(status, "", vec![("Location".into(), location.into())]),
        ];
        if expected_puts == 1 {
            responses.push(response(404, "", vec![]));
        }
        let http = Http {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(responses),
        };
        let operation = DriveUploadOperation {
            request_id: "request".into(),
            attachment_id: "attachment".into(),
            remote_file_id: Some("same-id".into()),
            request: DriveUploadRequest {
                destination: DriveUploadDestination {
                    connection_id: "connection".into(),
                    folder_id: "folder".into(),
                    resource_key: None,
                },
                filename: "trace.log".into(),
                size_bytes: 5,
                sha256: "digest".into(),
            },
            state: DriveUploadState::Uncertain,
            provenance: None,
        };
        let result = GoogleDrive::new("connection", &Vault, &http).upload_blob(
            &operation,
            &mut Cursor::new(b"bytes"),
            &mut |_, _| true,
        );
        assert_eq!(result.is_ok(), status == 409);
        let requests = http.requests.lock().unwrap();
        assert_eq!(
            requests.iter().filter(|r| r.method == "PUT").count(),
            expected_puts
        );
        assert!(
            requests
                .iter()
                .all(|r| !r.url.contains("attacker") && !matches!(r.method, "DELETE" | "PATCH"))
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&requests[1].body).unwrap()["id"],
            "same-id"
        );
    }
}
