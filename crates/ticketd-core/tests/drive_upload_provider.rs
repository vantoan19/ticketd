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
        // The real transport refuses anything outside its allow-list.
        assert!(
            ticketd_core::drive::request_allowed(request.method, &request.url),
            "GoogleTransport refuses {} {}",
            request.method,
            request.url
        );
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

#[derive(Default)]
struct LifecycleHttp {
    requests: Mutex<Vec<DriveRequest>>,
    created: Mutex<Option<serde_json::Value>>,
    complete: Mutex<bool>,
}
#[allow(clippy::unwrap_used)] // Deterministic provider fixture, never production recovery.
impl DriveTransport for LifecycleHttp {
    fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError> {
        // The real transport refuses anything outside its allow-list.
        assert!(
            ticketd_core::drive::request_allowed(request.method, &request.url),
            "GoogleTransport refuses {} {}",
            request.method,
            request.url
        );
        let url = request.url.clone();
        let method = request.method;
        let body = request.body.clone();
        self.requests.lock().unwrap().push(request);
        if url == "https://oauth2.googleapis.com/token" {
            return Ok(response(200, r#"{"access_token":"fixture-only"}"#, vec![]));
        }
        if method == "GET" && url.contains("/files/folder?") {
            return Ok(response(
                200,
                r#"{"id":"folder","name":"Uploads","mimeType":"application/vnd.google-apps.folder","capabilities":{"canAddChildren":true}}"#,
                vec![],
            ));
        }
        if method == "GET" && url.contains("/generateIds?") {
            return Ok(response(200, r#"{"ids":["reserved"]}"#, vec![]));
        }
        if method == "POST" && url.contains("/upload/drive/v3/files?") {
            *self.created.lock().unwrap() = Some(serde_json::from_slice(&body).unwrap());
            return Ok(response(200, "", vec![("Location".into(), "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fixture".into())]));
        }
        if method == "PUT" && url.contains("upload_id=fixture") {
            assert_eq!(body, b"original bytes");
            *self.complete.lock().unwrap() = true;
            return Ok(response(200, "{}", vec![]));
        }
        if method == "GET" && url.contains("/files/reserved?") {
            if !*self.complete.lock().unwrap() {
                return Ok(response(404, "{}", vec![]));
            }
            let created = self.created.lock().unwrap();
            return Ok(response(200, &serde_json::json!({"id":"reserved","name":"diagnostic.zip","mimeType":"application/octet-stream","size":"14","webViewLink":"https://drive.google.com/file/d/reserved/view","sha256Checksum":"52c3935626c104b2cbc9031291a1c4d56614c38f52072a361d658a58a9c48698","version":"1","parents":["folder"],"appProperties":created.as_ref().unwrap()["appProperties"]}).to_string(), vec![]));
        }
        if method == "GET" && url.contains("/files/selected?") {
            return Ok(response(
                200,
                r#"{"id":"selected","name":"Runbook","mimeType":"application/vnd.google-apps.document","webViewLink":"https://docs.google.com/document/d/selected/edit"}"#,
                vec![],
            ));
        }
        Err(DriveError::new(
            DriveErrorKind::Unsupported,
            format!("Unexpected fixture request: {method}"),
        ))
    }
}

#[test]
fn every_record_cleanup_detach_cancel_and_local_fallback_route_leaves_drive_content_and_permissions_intact()
 {
    let dir = tempfile::tempdir().unwrap();
    let mut w = ticketd_core::Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let http = LifecycleHttp::default();
    let connection = uuid::Uuid::new_v4().to_string();
    let provider = GoogleDrive::new(&connection, &Vault, &http);
    let selected = w
        .reference_drive_file(&connection, "selected", None, &provider)
        .unwrap();
    let ticket = w.create_ticket("Reference only").unwrap();
    w.set_ticket_attachment(&ticket.reference, &selected.id, true)
        .unwrap();
    w.set_ticket_attachment(&ticket.reference, &selected.id, false)
        .unwrap();
    let before_cleanup = http.requests.lock().unwrap().len();
    assert!(w.quarantine_attachment(&selected.id).is_err());
    assert!(w.restore_attachment(&selected.id).is_err());
    assert!(w.purge_attachment(&selected.id).is_err());
    w.remove_remote_attachment(&selected.id).unwrap();
    assert_eq!(http.requests.lock().unwrap().len(), before_cleanup);

    let destination = DriveUploadDestination {
        connection_id: connection.clone(),
        folder_id: "folder".into(),
        resource_key: None,
    };
    assert!(
        w.upload_drive_bytes(
            "cancel-before",
            "diagnostic.zip",
            b"original bytes",
            &destination,
            &provider,
            |_, _| false
        )
        .is_err()
    );
    assert!(http.created.lock().unwrap().is_none());
    // Cancellation after acknowledged completion reconciles into a discoverable copy.
    let uploaded = w
        .upload_drive_bytes(
            "cancel-after",
            "diagnostic.zip",
            b"original bytes",
            &destination,
            &provider,
            |copied, _| copied == 0,
        )
        .unwrap();
    assert_eq!(
        w.drive_upload("cancel-after").unwrap().state,
        DriveUploadState::Completed
    );
    let before_cleanup = http.requests.lock().unwrap().len();
    let local = w
        .import_attachment_bytes(
            "explicit-local",
            "diagnostic.zip",
            b"original bytes",
            |_, _| true,
        )
        .unwrap();
    w.quarantine_attachment(&local.id).unwrap();
    w.purge_attachment(&local.id).unwrap();
    assert!(w.quarantine_attachment(&uploaded.id).is_err());
    assert!(w.restore_attachment(&uploaded.id).is_err());
    assert!(w.purge_attachment(&uploaded.id).is_err());
    w.remove_remote_attachment(&uploaded.id).unwrap();
    w.check_drive_upload("cancel-after", &provider).unwrap();
    assert!(
        w.upload_drive_bytes(
            "cancel-after",
            "diagnostic.zip",
            b"original bytes",
            &destination,
            &provider,
            |_, _| true
        )
        .is_err()
    );
    assert_eq!(http.requests.lock().unwrap().len(), before_cleanup);
    assert!(*http.complete.lock().unwrap());
    let requests = http.requests.lock().unwrap();
    assert!(
        requests
            .iter()
            .all(|r| matches!(r.method, "GET" | "POST" | "PUT") && !r.url.contains("permissions"))
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| r.method == "POST" && r.url.contains("/upload/"))
            .count(),
        1
    );
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
        record_removed: false,
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
fn unsafe_sessions_conflicts_and_expiry_never_change_id_or_delete_remote_content() {
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
            record_removed: false,
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

#[test]
fn cancellation_after_an_acknowledged_chunk_stops_sending_without_remote_compensation() {
    let http=Http{requests:Mutex::new(vec![]),responses:Mutex::new(vec![response(200,r#"{"access_token":"access"}"#,vec![]),response(200,"",vec![("location".into(),"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session".into())]),response(308,"",vec![("Range".into(),"bytes=0-262143".into())])])};
    let operation = DriveUploadOperation {
        request_id: "cancel".into(),
        attachment_id: "attachment".into(),
        remote_file_id: Some("reserved".into()),
        request: DriveUploadRequest {
            destination: DriveUploadDestination {
                connection_id: "connection".into(),
                folder_id: "folder".into(),
                resource_key: None,
            },
            filename: "trace.log".into(),
            size_bytes: 262149,
            sha256: "digest".into(),
        },
        state: DriveUploadState::Uncertain,
        provenance: None,
        record_removed: false,
    };
    let error = GoogleDrive::new("connection", &Vault, &http)
        .upload_blob(
            &operation,
            &mut Cursor::new(vec![1u8; 262149]),
            &mut |copied, _| copied == 0,
        )
        .unwrap_err();
    assert_eq!(error.kind, DriveErrorKind::Cancelled);
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[2].body.len(), 262144);
    assert!(
        requests
            .iter()
            .all(|r| !matches!(r.method, "DELETE" | "PATCH"))
    );
}
