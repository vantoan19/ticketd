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
        DriveResponse { headers: vec![], status: 200, body: br#"{"access_token":"secret-access","scope":"https://www.googleapis.com/auth/drive.file"}"#.to_vec() },
        DriveResponse { headers: vec![], status: 200, body: br#"{"id":"doc-123","name":"Plan","mimeType":"application/vnd.google-apps.document","webViewLink":"https://docs.google.com/document/d/doc-123/edit","isAppAuthorized":true}"#.to_vec() },
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
fn empty_successful_token_response_is_invalid_provider_data() {
    let transport = Http {
        requests: Mutex::new(vec![]),
        responses: Mutex::new(vec![DriveResponse {
            headers: vec![],
            status: 200,
            body: br#"{"access_token":"","scope":"https://www.googleapis.com/auth/drive.file"}"#
                .to_vec(),
        }]),
    };
    let error = GoogleDrive::new("connection", &Vault, &transport)
        .metadata("doc-123", None)
        .unwrap_err();
    assert_eq!(error.kind, DriveErrorKind::InvalidResponse);
    assert!(!error.message.contains("secret"));
    assert_eq!(transport.requests.lock().unwrap().len(), 1);
}

#[test]
fn mixed_portable_outputs_and_restore_exclude_credentials_and_need_no_provider_access() {
    struct PrivateVault;
    impl CredentialStore for PrivateVault {
        fn load(&self, _: &str) -> Result<DriveCredential, DriveError> {
            Ok(DriveCredential {
                client_id: "client.apps.googleusercontent.com".into(),
                client_secret: Some("private-client-secret".into()),
                refresh_token: "private-refresh-token".into(),
            })
        }
        fn save(&self, _: &str, _: &DriveCredential) -> Result<(), DriveError> {
            Ok(())
        }
    }
    let transport = Http { requests: Mutex::new(vec![]), responses: Mutex::new(vec![
        DriveResponse { status: 200, headers: vec![], body: br#"{"access_token":"private-access-token","scope":"https://www.googleapis.com/auth/drive.file"}"#.to_vec() },
        DriveResponse { status: 200, headers: vec![], body: br#"{"id":"doc-123","name":"Plan","mimeType":"application/vnd.google-apps.document","webViewLink":"https://docs.google.com/document/d/doc-123/edit","isAppAuthorized":true,"unexpectedToken":"private-response-token"}"#.to_vec() },
    ]) };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = ticketd_core::Workspace::open(&path).unwrap();
    let connection = uuid::Uuid::new_v4().to_string();
    let remote = workspace
        .reference_drive_file(
            &connection,
            "doc-123",
            None,
            &GoogleDrive::new(&connection, &PrivateVault, &transport),
        )
        .unwrap();
    let local = workspace
        .import_attachment_bytes("local", "log.txt", b"stored bytes", |_, _| true)
        .unwrap();
    let document = workspace
        .create_document(
            None,
            &format!(
                "[Plan]({}) and [Log]({})",
                workspace.attachment_uri(&remote.id).unwrap(),
                workspace.attachment_uri(&local.id).unwrap()
            ),
        )
        .unwrap();
    let export = workspace
        .export_markdown_with_files(
            ticketd_core::MarkdownExportSource::Document { id: document.id },
            dir.path(),
        )
        .unwrap();
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let restored_path = dir.path().join("restored.sqlite3");
    ticketd_core::Workspace::restore(&restored_path, &backup).unwrap();
    let restored = ticketd_core::Workspace::open(&restored_path).unwrap();
    assert_eq!(
        restored.drive_reference(&remote.id).unwrap(),
        workspace.drive_reference(&remote.id).unwrap()
    );
    let outputs = [
        workspace.export().unwrap().to_string().into_bytes(),
        std::fs::read(&path).unwrap(),
        std::fs::read(&backup).unwrap(),
        std::fs::read(&restored_path).unwrap(),
        std::fs::read(export.directory.join("content.md")).unwrap(),
        std::fs::read(export.directory.join("manifest.json")).unwrap(),
    ];
    for secret in [
        "private-client-secret",
        "private-refresh-token",
        "private-access-token",
        "private-response-token",
    ] {
        for bytes in &outputs {
            assert!(
                !bytes
                    .windows(secret.len())
                    .any(|part| part == secret.as_bytes())
            );
        }
    }
    // The two deterministic auth/metadata calls precede persistence. Export,
    // backup and restore add no network, download, conversion or mutation calls.
    assert_eq!(transport.requests.lock().unwrap().len(), 2);
}

#[test]
fn unselected_file_has_explicit_picker_guidance_instead_of_broader_authorization() {
    let transport = Http {
        requests: Mutex::new(vec![]),
        responses: Mutex::new(vec![
            DriveResponse {
                headers: vec![],
                status: 200,
                body: br#"{"access_token":"secret-access"}"#.to_vec(),
            },
            DriveResponse {
                headers: vec![],
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
fn proven_permission_denial_and_trash_are_distinct_from_ambiguous_missing() {
    for (status, body, kind) in [
        (
            403,
            br#"{"error":{"errors":[{"reason":"insufficientFilePermissions"}]}}"#.as_slice(),
            DriveErrorKind::PermissionDenied,
        ),
        (
            200,
            br#"{"id":"file","name":"Last name","mimeType":"text/plain","trashed":true}"#
                .as_slice(),
            DriveErrorKind::Missing,
        ),
        (
            404,
            br#"{"error":{"errors":[{"reason":"notFound"}]}}"#.as_slice(),
            DriveErrorKind::InaccessibleOrMissing,
        ),
        (
            403,
            b"unknown denial".as_slice(),
            DriveErrorKind::InaccessibleOrMissing,
        ),
        (
            200,
            br#"{"id":"another-file","name":"Unrelated","mimeType":"text/plain","trashed":true}"#
                .as_slice(),
            DriveErrorKind::InvalidResponse,
        ),
        (
            503,
            br#"{"error":{"errors":[{"reason":"appNotAuthorizedToFile"}]}}"#.as_slice(),
            DriveErrorKind::Offline,
        ),
    ] {
        let transport = Http {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![
                DriveResponse {
                    headers: vec![],
                    status: 200,
                    body: br#"{"access_token":"secret-access"}"#.to_vec(),
                },
                DriveResponse {
                    headers: vec![],
                    status,
                    body: body.to_vec(),
                },
            ]),
        };
        let error = GoogleDrive::new("connection", &Vault, &transport)
            .metadata("file", None)
            .unwrap_err();
        assert_eq!(error.kind, kind);
        assert!(!error.message.contains("secret"));
    }
}

#[test]
fn workspace_transport_recovery_refreshes_only_metadata_and_keeps_secrets_out_of_portable_data() {
    use ticketd_core::Workspace;
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let connection = uuid::Uuid::new_v4().to_string();
    let response = |status, body: &[u8]| DriveResponse {
        headers: vec![],
        status,
        body: body.to_vec(),
    };
    let token = || {
        response(
            200,
            br#"{"access_token":"secret-access","refresh_token":"secret-rotated"}"#,
        )
    };
    let transport = Http {
        requests: Mutex::new(vec![]),
        responses: Mutex::new(vec![
            token(),
            response(
                200,
                br#"{"id":"file","name":"Original","mimeType":"text/plain","size":"4"}"#,
            ),
            token(),
            response(
                403,
                br#"{"error":{"errors":[{"reason":"appNotAuthorizedToFile"}]}}"#,
            ),
            token(),
            response(
                403,
                br#"{"error":{"errors":[{"reason":"insufficientFilePermissions"}]}}"#,
            ),
            token(),
            response(404, br#"{"error":{"errors":[{"reason":"notFound"}]}}"#),
            response(503, b"secret-provider-response"),
            token(),
            response(
                200,
                br#"{"id":"file","name":"Renamed in Drive","mimeType":"text/plain","size":"8"}"#,
            ),
        ]),
    };
    let provider = GoogleDrive::new(&connection, &Vault, &transport);
    let file = workspace
        .reference_drive_file(&connection, "file", None, &provider)
        .unwrap();
    workspace
        .rename_attachment(&file.id, "Local display name")
        .unwrap();
    let previous = workspace.drive_reference(&file.id).unwrap();
    for kind in [
        DriveErrorKind::SelectFile,
        DriveErrorKind::PermissionDenied,
        DriveErrorKind::InaccessibleOrMissing,
        DriveErrorKind::Offline,
    ] {
        let status = workspace
            .check_drive_reference(&file.id, &provider)
            .unwrap();
        assert_eq!(status.failure.unwrap().kind, kind);
        assert_eq!(status.reference, previous);
    }
    let selection = ticketd_core::drive::DriveSelection {
        connection_id: connection.clone(),
        file_ids: vec!["file".into()],
    };
    // Account/file proof came from the Picker boundary; this call resolves metadata only.
    assert_eq!(
        workspace
            .recover_drive_reference(&file.id, &selection, &provider)
            .unwrap()
            .metadata
            .name,
        "Renamed in Drive"
    );
    assert_eq!(
        workspace.attachment(&file.id).unwrap().display_name,
        "Local display name"
    );
    assert_eq!(
        workspace.attachment(&file.id).unwrap().original_filename,
        "Original"
    );
    assert_eq!(workspace.attachment(&file.id).unwrap().size_bytes, Some(8));
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let bytes = std::fs::read(backup).unwrap();
    let json = workspace.export().unwrap().to_string();
    for secret in [
        "secret-refresh",
        "secret-access",
        "secret-rotated",
        "secret-provider-response",
    ] {
        assert!(!json.contains(secret));
        assert!(
            !bytes
                .windows(secret.len())
                .any(|part| part == secret.as_bytes())
        );
    }
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 11);
    assert!(
        requests
            .iter()
            .all(|r| r.url == "https://oauth2.googleapis.com/token"
                || (r.method == "GET"
                    && r.url.contains("/files/file?")
                    && !r.url.contains("alt=media")))
    );
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
                headers: vec![],
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
                    headers: vec![],
                    status: 200,
                    body: br#"{"access_token":"access"}"#.to_vec(),
                },
                DriveResponse {
                    headers: vec![],
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
        DriveResponse { headers: vec![], status: 200, body: br#"{"access_token":"must-not-use","scope":"https://www.googleapis.com/auth/drive"}"#.to_vec() },
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
            DriveResponse { headers: vec![], status: 200, body: br#"{"access_token":"access"}"#.to_vec() },
            DriveResponse { headers: vec![], status: 200, body: serde_json::to_vec(&serde_json::json!({"id":"file", "name":"Native file", "mimeType":mime, "webViewLink":url})).unwrap() },
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
            DriveResponse { headers: vec![], status: 200, body: br#"{"access_token":"access"}"#.to_vec() },
            DriveResponse { headers: vec![], status: 200, body: serde_json::to_vec(&serde_json::json!({"id":"file", "name":"File", "mimeType":mime, "webViewLink":url})).unwrap() },
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
