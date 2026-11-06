use std::sync::Mutex;
use ticketd_core::drive::{
    AttachmentProvider, CredentialStore, DriveCredential, DriveError, DriveErrorKind, DriveRequest,
    DriveResponse, DriveTransport, GoogleDrive,
};

struct Vault;
impl CredentialStore for Vault {
    fn load(&self, _: &str) -> Result<DriveCredential, DriveError> {
        Ok(DriveCredential {
            client_id: "desktop-client".into(),
            client_secret: None,
            refresh_token: "secret-refresh".into(),
        })
    }
    fn save(&self, _: &str, _: &DriveCredential) -> Result<(), DriveError> {
        Ok(())
    }
}
struct Http {
    requests: Mutex<Vec<DriveRequest>>,
    responses: Mutex<Vec<DriveResponse>>,
}
#[allow(clippy::unwrap_used)] // Fixture synchronization failures should fail the test.
impl DriveTransport for Http {
    fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError> {
        self.requests.lock().unwrap().push(request);
        Ok(self.responses.lock().unwrap().remove(0))
    }
}

#[test]
fn native_metadata_uses_only_token_exchange_and_metadata_get_with_redacted_credentials() {
    let transport = Http { requests: Mutex::new(vec![]), responses: Mutex::new(vec![
        DriveResponse { status: 200, body: br#"{"access_token":"secret-access","scope":"https://www.googleapis.com/auth/drive.file"}"#.to_vec() },
        DriveResponse { status: 200, body: br#"{"id":"doc-123","name":"Plan","mimeType":"application/vnd.google-apps.document","webViewLink":"https://docs.google.com/document/d/doc-123/edit","isAppAuthorized":true}"#.to_vec() },
    ]) };
    let provider = GoogleDrive::new("connection", &Vault, &transport);
    let file = provider.metadata("doc-123", None).unwrap();
    assert_eq!(file.size_bytes, None);
    assert_eq!(file.name, "Plan");
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].url, "https://oauth2.googleapis.com/token");
    assert_eq!(requests[1].method, "GET");
    assert!(
        requests[1]
            .url
            .starts_with("https://www.googleapis.com/drive/v3/files/doc-123?")
    );
    assert!(!format!("{requests:?}").contains("secret"));
}

#[test]
fn unselected_file_has_explicit_picker_guidance_instead_of_broader_authorization() {
    let transport = Http {
        requests: Mutex::new(vec![]),
        responses: Mutex::new(vec![
            DriveResponse {
                status: 200,
                body: br#"{"access_token":"secret-access"}"#.to_vec(),
            },
            DriveResponse {
                status: 403,
                body: br#"{"error":{"errors":[{"reason":"appNotAuthorizedToFile"}]}}"#.to_vec(),
            },
        ]),
    };
    let error = GoogleDrive::new("connection", &Vault, &transport)
        .metadata("unselected", None)
        .unwrap_err();
    assert_eq!(error.kind, DriveErrorKind::SelectFile);
    assert!(error.message.contains("Google Drive tab"));
}

#[test]
fn ambiguous_missing_offline_rate_limit_and_invalid_scope_are_not_misreported() {
    for (status, expected) in [
        (503, DriveErrorKind::Offline),
        (429, DriveErrorKind::RateLimited),
        (400, DriveErrorKind::Reauthorize),
    ] {
        let transport = Http {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![DriveResponse {
                status,
                body: br#"{"error":"invalid_grant","sensitive":"must-not-echo"}"#.to_vec(),
            }]),
        };
        let error = GoogleDrive::new("connection", &Vault, &transport)
            .metadata("file", None)
            .unwrap_err();
        assert_eq!(error.kind, expected);
        assert!(!error.message.contains("must-not-echo"));
    }
    for (status, body, expected) in [
        (
            404,
            br#"{"error":{"errors":[{"reason":"notFound"}]}}"#.as_slice(),
            DriveErrorKind::InaccessibleOrMissing,
        ),
        (
            403,
            br#"{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}"#.as_slice(),
            DriveErrorKind::RateLimited,
        ),
        (
            503,
            b"provider unavailable".as_slice(),
            DriveErrorKind::Offline,
        ),
    ] {
        let transport = Http {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![
                DriveResponse {
                    status: 200,
                    body: br#"{"access_token":"access"}"#.to_vec(),
                },
                DriveResponse {
                    status,
                    body: body.to_vec(),
                },
            ]),
        };
        let error = GoogleDrive::new("connection", &Vault, &transport)
            .metadata("file", None)
            .unwrap_err();
        assert_eq!(error.kind, expected);
    }
    let transport = Http { requests: Mutex::new(vec![]), responses: Mutex::new(vec![
        DriveResponse { status: 200, body: br#"{"access_token":"must-not-use","scope":"https://www.googleapis.com/auth/drive"}"#.to_vec() },
    ]) };
    assert_eq!(
        GoogleDrive::new("connection", &Vault, &transport)
            .metadata("file", None)
            .unwrap_err()
            .kind,
        DriveErrorKind::Reauthorize
    );
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
}

#[test]
fn native_types_and_resource_keys_need_no_download_or_conversion_capability() {
    for (mime, url) in [
        (
            "application/vnd.google-apps.document",
            "https://docs.google.com/document/d/file/edit",
        ),
        (
            "application/vnd.google-apps.spreadsheet",
            "https://docs.google.com/spreadsheets/d/file/edit",
        ),
        (
            "application/vnd.google-apps.presentation",
            "https://docs.google.com/presentation/d/file/edit",
        ),
    ] {
        let transport = Http { requests: Mutex::new(vec![]), responses: Mutex::new(vec![
            DriveResponse { status: 200, body: br#"{"access_token":"access"}"#.to_vec() },
            DriveResponse { status: 200, body: serde_json::to_vec(&serde_json::json!({"id":"file", "name":"Native file", "mimeType":mime, "webViewLink":url})).unwrap() },
        ]) };
        let file = GoogleDrive::new("connection", &Vault, &transport)
            .metadata("file", Some("resource-key"))
            .unwrap();
        assert_eq!(file.size_bytes, None);
        assert_eq!(file.mime_type, mime);
        assert_eq!(file.resource_key.as_deref(), Some("resource-key"));
        let requests = transport.requests.lock().unwrap();
        assert!(
            requests[1]
                .headers
                .iter()
                .any(|(k, v)| k == "X-Goog-Drive-Resource-Keys" && v == "file/resource-key")
        );
        assert_eq!(requests.len(), 2);
    }
}

#[test]
fn invalid_viewer_hosts_and_unsupported_folders_cannot_become_references() {
    for (mime, url, expected) in [
        (
            "text/plain",
            "https://docs.google.com.evil.example/view",
            DriveErrorKind::InvalidResponse,
        ),
        (
            "application/vnd.google-apps.folder",
            "https://drive.google.com/drive/folders/file",
            DriveErrorKind::Unsupported,
        ),
    ] {
        let transport = Http { requests: Mutex::new(vec![]), responses: Mutex::new(vec![
            DriveResponse { status: 200, body: br#"{"access_token":"access"}"#.to_vec() },
            DriveResponse { status: 200, body: serde_json::to_vec(&serde_json::json!({"id":"file", "name":"File", "mimeType":mime, "webViewLink":url})).unwrap() },
        ]) };
        assert_eq!(
            GoogleDrive::new("connection", &Vault, &transport)
                .metadata("file", None)
                .unwrap_err()
                .kind,
            expected
        );
    }
}
