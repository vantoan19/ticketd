use std::{
    io::{Read, Write},
    net::TcpStream,
    sync::atomic::AtomicBool,
    time::Duration,
};
use ticketd_core::drive::{
    CredentialStore, DesktopOAuthClient, DriveCredential, DriveError, DriveRequest, DriveResponse,
    DriveTransport, PickerSession,
};

fn read_http_response(socket: &mut TcpStream) -> std::io::Result<String> {
    socket.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut response = Vec::new();
    let mut expected_length = None;
    let mut buffer = [0; 1024];
    loop {
        let count = socket.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        response.extend_from_slice(&buffer[..count]);
        if response.len() > 16 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "OAuth callback response exceeded test limit",
            ));
        }
        if expected_length.is_none()
            && let Some(header_end) = response.windows(4).position(|bytes| bytes == b"\r\n\r\n")
        {
            let headers = std::str::from_utf8(&response[..header_end]).map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "OAuth callback response headers were not UTF-8",
                )
            })?;
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "OAuth callback response omitted Content-Length",
                    )
                })?;
            expected_length = Some(header_end + 4 + content_length);
        }
        if expected_length.is_some_and(|length| response.len() >= length) {
            break;
        }
    }
    let Some(expected_length) = expected_length else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "OAuth callback response ended before its headers",
        ));
    };
    if response.len() < expected_length {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "OAuth callback response ended before its body",
        ));
    }
    response.truncate(expected_length);
    String::from_utf8(response).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "OAuth callback response was not UTF-8",
        )
    })
}

#[test]
fn upload_folder_selection_requests_one_explicit_folder_with_only_drive_file_scope() {
    let session = PickerSession::begin_folder(
        DesktopOAuthClient::new("client.apps.googleusercontent.com".into(), None).unwrap(),
        Duration::from_secs(2),
    )
    .unwrap();
    let url = url::Url::parse(session.authorization_url()).unwrap();
    let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(pairs["allow_folder_selection"], "true");
    assert_eq!(pairs["allow_multiple"], "false");
    assert_eq!(pairs["mimetypes"], "application/vnd.google-apps.folder");
    assert_eq!(pairs["scope"], "https://www.googleapis.com/auth/drive.file");
}

#[test]
fn authorization_code_verifier_matches_the_browser_s256_challenge() {
    use sha2::Digest;

    struct VerifyPkce {
        challenge: String,
    }
    impl DriveTransport for VerifyPkce {
        fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError> {
            if request.method == "POST" {
                let fields: std::collections::BTreeMap<_, _> =
                    url::form_urlencoded::parse(&request.body)
                        .into_owned()
                        .collect();
                let verifier = fields.get("code_verifier").unwrap();
                let challenge = base64::Engine::encode(
                    &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                    sha2::Sha256::digest(verifier.as_bytes()),
                );
                assert_eq!(challenge, self.challenge);
                return Ok(DriveResponse {
                    headers: vec![],
                    status: 200,
                    body: br#"{"access_token":"access-secret","refresh_token":"refresh-secret","scope":"https://www.googleapis.com/auth/drive.file"}"#.to_vec(),
                });
            }
            assert_eq!(
                request.url,
                "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)"
            );
            Ok(DriveResponse {
                headers: vec![],
                status: 200,
                body: br#"{"user":{"permissionId":"account-123"}}"#.to_vec(),
            })
        }
    }

    let session = PickerSession::begin(
        DesktopOAuthClient::new("client.apps.googleusercontent.com".into(), None).unwrap(),
        Duration::from_secs(5),
    )
    .unwrap();
    let url = url::Url::parse(session.authorization_url()).unwrap();
    let fields: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    let redirect = url::Url::parse(&fields["redirect_uri"]).unwrap();
    let transport = VerifyPkce {
        challenge: fields["code_challenge"].clone(),
    };
    let state = fields["state"].clone();
    let port = redirect.port().unwrap();
    let authority = redirect.authority().to_owned();
    let callback = std::thread::spawn(move || {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let request = format!(
            "GET /oauth2callback?state={state}&code=authorization-secret&picked_file_ids=selected HTTP/1.1\r\nHost: {authority}\r\n\r\n"
        );
        socket.write_all(request.as_bytes()).unwrap();
        read_http_response(&mut socket).unwrap()
    });

    let selection = session
        .finish(&transport, &Vault, &AtomicBool::new(false))
        .unwrap();
    assert!(callback.join().unwrap().starts_with("HTTP/1.1 200 OK"));
    assert_eq!(selection.file_ids, ["selected"]);
}

#[test]
fn callback_waits_for_the_rest_of_a_request_sent_after_connection_accept() {
    let session = PickerSession::begin(
        DesktopOAuthClient::new("client.apps.googleusercontent.com".into(), None).unwrap(),
        Duration::from_secs(5),
    )
    .unwrap();
    let url = url::Url::parse(session.authorization_url()).unwrap();
    let fields: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    let redirect = url::Url::parse(&fields["redirect_uri"]).unwrap();
    let port = redirect.port().unwrap();
    let authority = redirect.authority().to_owned();
    let state = fields["state"].clone();
    let cancelled = std::sync::Arc::new(AtomicBool::new(false));
    let callback_cancelled = cancelled.clone();
    let callback = std::thread::spawn(move || {
        let request = format!(
            "GET /oauth2callback?state={state}&code=authorization-secret&picked_file_ids=selected HTTP/1.1\r\nHost: {authority}\r\n\r\n"
        );
        let mut delayed = TcpStream::connect(("127.0.0.1", port)).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        let split = request.len() - 2;
        let mut early_response = false;
        let response = match delayed.write_all(&request.as_bytes()[..split]) {
            Err(error) => {
                early_response = true;
                Err(error)
            }
            Ok(()) => {
                delayed
                    .set_read_timeout(Some(Duration::from_millis(100)))
                    .unwrap();
                let mut byte = [0];
                match delayed.peek(&mut byte) {
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        delayed
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        delayed
                            .write_all(&request.as_bytes()[split..])
                            .and_then(|()| read_http_response(&mut delayed))
                    }
                    Ok(_) => {
                        early_response = true;
                        read_http_response(&mut delayed)
                    }
                    Err(error) => {
                        early_response = true;
                        Err(error)
                    }
                }
            }
        };
        if early_response {
            callback_cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        (early_response, response)
    });

    let selection = session.finish(&Http, &Vault, &cancelled);
    let (early_response, response) = callback.join().unwrap();
    assert!(
        !early_response,
        "callback answered or closed before receiving the complete request"
    );
    let selection = selection.unwrap_or_else(|error| panic!("callback failed: {error}"));
    assert!(response.unwrap().starts_with("HTTP/1.1 200 OK"));
    assert_eq!(selection.file_ids, ["selected"]);
}

#[test]
fn picker_requires_confirmed_narrow_scope_before_account_lookup_or_vault_access() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct NoCredentials;
    impl CredentialStore for NoCredentials {
        fn load(&self, _: &str) -> Result<DriveCredential, DriveError> {
            unreachable!("scope rejection must not read credentials")
        }
        fn save(&self, _: &str, _: &DriveCredential) -> Result<(), DriveError> {
            unreachable!("scope rejection must not save credentials")
        }
    }
    struct TokenOnly {
        body: &'static [u8],
        calls: AtomicUsize,
    }
    impl DriveTransport for TokenOnly {
        fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError> {
            assert_eq!(request.method, "POST");
            assert_eq!(request.url, "https://oauth2.googleapis.com/token");
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(DriveResponse {
                headers: vec![],
                status: 200,
                body: self.body.to_vec(),
            })
        }
    }

    for (body, expected) in [
        (
            br#"{"access_token":"access-secret"}"#.as_slice(),
            ticketd_core::drive::DriveErrorKind::InvalidResponse,
        ),
        (
            br#"{"access_token":"access-secret","scope":"https://www.googleapis.com/auth/drive"}"#
                .as_slice(),
            ticketd_core::drive::DriveErrorKind::Reauthorize,
        ),
    ] {
        let session = PickerSession::begin(
            DesktopOAuthClient::new("client.apps.googleusercontent.com".into(), None).unwrap(),
            Duration::from_secs(5),
        )
        .unwrap();
        let url = url::Url::parse(session.authorization_url()).unwrap();
        let fields: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        let redirect = url::Url::parse(&fields["redirect_uri"]).unwrap();
        let port = redirect.port().unwrap();
        let authority = redirect.authority().to_owned();
        let state = fields["state"].clone();
        let callback = std::thread::spawn(move || {
            let mut socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let request = format!(
                "GET /oauth2callback?state={state}&code=authorization-secret&picked_file_ids=selected HTTP/1.1\r\nHost: {authority}\r\n\r\n"
            );
            socket.write_all(request.as_bytes()).unwrap();
            let _ = read_http_response(&mut socket).unwrap();
        });
        let transport = TokenOnly {
            body,
            calls: AtomicUsize::new(0),
        };
        let error = session
            .finish(&transport, &NoCredentials, &AtomicBool::new(false))
            .err()
            .unwrap();
        assert_eq!(error.kind, expected);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
        callback.join().unwrap();
    }
}

struct Vault;
impl CredentialStore for Vault {
    fn load(&self, _: &str) -> Result<DriveCredential, DriveError> {
        Ok(DriveCredential {
            client_id: "client.apps.googleusercontent.com".into(),
            client_secret: None,
            refresh_token: "refresh-secret".into(),
        })
    }
    fn save(&self, _: &str, value: &DriveCredential) -> Result<(), DriveError> {
        assert_eq!(value.refresh_token, "refresh-secret");
        Ok(())
    }
}
struct Http;
impl DriveTransport for Http {
    fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError> {
        if request.method == "GET" {
            assert_eq!(
                request.url,
                "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)"
            );
            return Ok(DriveResponse {
                headers: vec![],
                status: 200,
                body: br#"{"user":{"permissionId":"account-123"}}"#.to_vec(),
            });
        }
        assert_eq!(request.url, "https://oauth2.googleapis.com/token");
        let form: std::collections::BTreeMap<_, _> = url::form_urlencoded::parse(&request.body)
            .into_owned()
            .collect();
        assert_eq!(form["code"], "authorization-secret");
        assert_eq!(form["grant_type"], "authorization_code");
        assert!(form["code_verifier"].len() >= 43);
        Ok(DriveResponse { headers: vec![], status: 200, body: br#"{"access_token":"access-secret","refresh_token":"refresh-secret","scope":"https://www.googleapis.com/auth/drive.file"}"#.to_vec() })
    }
}

struct Reconnect;
impl DriveTransport for Reconnect {
    fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError> {
        if request.method == "GET" {
            return Http.send(request);
        }
        Ok(DriveResponse { headers: vec![], status: 200, body: br#"{"access_token":"access-secret","scope":"https://www.googleapis.com/auth/drive.file"}"#.to_vec() })
    }
}
struct DifferentAccount;
impl DriveTransport for DifferentAccount {
    fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError> {
        if request.method == "GET" {
            return Ok(DriveResponse {
                headers: vec![],
                status: 200,
                body: br#"{"user":{"permissionId":"other-account"}}"#.to_vec(),
            });
        }
        Http.send(request)
    }
}

#[test]
fn disabled_drive_api_reports_publisher_setup_without_saving_credentials() {
    struct DisabledApi(&'static [u8]);
    impl DriveTransport for DisabledApi {
        fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError> {
            if request.method == "POST" {
                return Http.send(request);
            }
            assert_eq!(
                request.url,
                "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)"
            );
            Ok(DriveResponse {
                headers: vec![],
                status: 403,
                body: self.0.to_vec(),
            })
        }
    }
    struct NoCredentials;
    impl CredentialStore for NoCredentials {
        fn load(&self, _: &str) -> Result<DriveCredential, DriveError> {
            unreachable!("disabled API must not load credentials")
        }
        fn save(&self, _: &str, _: &DriveCredential) -> Result<(), DriveError> {
            unreachable!("disabled API must not save credentials")
        }
    }
    for body in [
        br#"{"error":{"message":"provider-private-details","errors":[{"reason":"accessNotConfigured"}]}}"#.as_slice(),
        br#"{"error":{"message":"provider-private-details","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"SERVICE_DISABLED","domain":"googleapis.com","metadata":{"service":"drive.googleapis.com"}}]}}"#.as_slice(),
    ] {
        let session = PickerSession::begin_folder(
            DesktopOAuthClient::new("client.apps.googleusercontent.com".into(), None).unwrap(),
            Duration::from_secs(5),
        )
        .unwrap();
        let url = url::Url::parse(session.authorization_url()).unwrap();
        let fields: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        let redirect = url::Url::parse(&fields["redirect_uri"]).unwrap();
        let worker = std::thread::spawn(move || {
            session.finish(&DisabledApi(body), &NoCredentials, &AtomicBool::new(false))
        });
        let mut socket = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
        let request = format!("GET /oauth2callback?state={}&code=authorization-secret&picked_file_ids=folder HTTP/1.1\r\nHost: {}\r\n\r\n", fields["state"], redirect.authority());
        socket.write_all(request.as_bytes()).unwrap();
        let _ = read_http_response(&mut socket).unwrap();
        let error = worker.join().unwrap().err().unwrap();
        assert_eq!(error.kind, ticketd_core::drive::DriveErrorKind::Unconfigured);
        assert!(error.message.contains("Google Drive API"));
        assert!(error.message.contains("publisher"));
        assert!(!error.message.contains("provider-private-details"));
    }
}

#[test]
fn recovery_picker_rejects_other_accounts_or_files_before_saving_credentials() {
    use ticketd_core::{
        Workspace,
        drive::{AttachmentProvider, DriveErrorKind, DriveMetadata},
    };
    struct File;
    impl AttachmentProvider for File {
        fn metadata(&self, id: &str, _: Option<&str>) -> Result<DriveMetadata, DriveError> {
            Ok(DriveMetadata {
                id: id.into(),
                name: "Plan".into(),
                mime_type: "text/plain".into(),
                size_bytes: Some(3),
                web_url: format!("https://drive.google.com/file/d/{id}/view"),
                resource_key: None,
            })
        }
    }
    struct NoSave;
    impl CredentialStore for NoSave {
        fn load(&self, _: &str) -> Result<DriveCredential, DriveError> {
            unreachable!("rejected recovery must not load credentials")
        }
        fn save(&self, _: &str, _: &DriveCredential) -> Result<(), DriveError> {
            unreachable!("rejected recovery must not save credentials")
        }
    }
    let original = select_native(&Http);
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let file = workspace
        .reference_drive_file(&original.connection_id, "first", None, &File)
        .unwrap();
    for (transport, selected, expected) in [
        (
            &DifferentAccount as &'static dyn DriveTransport,
            "first",
            DriveErrorKind::Reauthorize,
        ),
        (&Http, "other", DriveErrorKind::SelectFile),
    ] {
        let session = workspace
            .begin_drive_reference_recovery(
                &file.id,
                DesktopOAuthClient::new("client.apps.googleusercontent.com".into(), None).unwrap(),
                Duration::from_secs(5),
            )
            .unwrap();
        let url = url::Url::parse(session.authorization_url()).unwrap();
        let fields: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(fields["allow_multiple"], "false");
        assert_eq!(fields["scope"], ticketd_core::drive::DRIVE_FILE_SCOPE);
        let redirect = url::Url::parse(&fields["redirect_uri"]).unwrap();
        let worker =
            std::thread::spawn(move || session.finish(transport, &NoSave, &AtomicBool::new(false)));
        let mut socket = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
        let request = format!(
            "GET /oauth2callback?state={}&code=authorization-secret&picked_file_ids={selected} HTTP/1.1\r\nHost: {}\r\n\r\n",
            fields["state"],
            redirect.authority()
        );
        socket.write_all(request.as_bytes()).unwrap();
        let _ = read_http_response(&mut socket).unwrap();
        assert_eq!(worker.join().unwrap().err().unwrap().kind, expected);
        assert_eq!(
            workspace.attachments(10, 0).unwrap(),
            std::slice::from_ref(&file)
        );
    }
}

#[allow(clippy::unwrap_used)] // Loopback test setup; not a production path.
fn select_native(transport: &'static dyn DriveTransport) -> ticketd_core::drive::DriveSelection {
    let session = PickerSession::begin(
        DesktopOAuthClient::new("client.apps.googleusercontent.com".into(), None).unwrap(),
        Duration::from_secs(5),
    )
    .unwrap();
    let url = url::Url::parse(session.authorization_url()).unwrap();
    assert_eq!(url.host_str(), Some("accounts.google.com"));
    let fields: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(
        fields["scope"],
        "https://www.googleapis.com/auth/drive.file"
    );
    assert_eq!(fields["trigger_onepick"], "true");
    assert_eq!(fields["code_challenge_method"], "S256");
    assert!(!fields.contains_key("include_granted_scopes"));
    let redirect = url::Url::parse(&fields["redirect_uri"]).unwrap();
    let state = fields["state"].clone();
    let worker =
        std::thread::spawn(move || session.finish(transport, &Vault, &AtomicBool::new(false)));
    for (path, host, query, expected) in [
        (
            "/oauth2callback",
            redirect.authority(),
            "state=wrong".into(),
            "400",
        ),
        (
            "/wrong",
            redirect.authority(),
            format!("state={state}"),
            "400",
        ),
        (
            "/oauth2callback",
            "evil.example",
            format!("state={state}"),
            "400",
        ),
        (
            "/oauth2callback",
            redirect.authority(),
            format!("state={state}&state={state}"),
            "400",
        ),
        (
            "/oauth2callback",
            redirect.authority(),
            format!("state={state}"),
            "200",
        ),
    ] {
        let mut socket = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
        let request = format!(
            "GET {path}?{query}&code=authorization-secret&picked_file_ids=first,second HTTP/1.1\r\nHost: {host}\r\n\r\n"
        );
        socket.write_all(request.as_bytes()).unwrap();
        let response = read_http_response(&mut socket).unwrap();
        assert!(response.starts_with(&format!("HTTP/1.1 {expected}")));
        assert!(!response.contains("authorization-secret"));
    }
    let selection = worker.join().unwrap().unwrap();
    assert_eq!(selection.file_ids, ["first", "second"]);
    assert!(uuid::Uuid::parse_str(&selection.connection_id).is_ok());
    selection
}

#[test]
fn desktop_picker_uses_pkce_validated_callback_and_reuses_only_the_same_account_connection() {
    let first = select_native(&Http);
    let second = select_native(&Reconnect);
    assert_eq!(first.connection_id, second.connection_id);
    assert_ne!(
        first.connection_id,
        select_native(&DifferentAccount).connection_id
    );
    let dir = tempfile::tempdir().unwrap();
    let workspace = ticketd_core::Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let exported = workspace.export().unwrap().to_string();
    let bytes = std::fs::read(backup).unwrap();
    for secret in ["authorization-secret", "access-secret", "refresh-secret"] {
        assert!(!exported.contains(secret));
        assert!(
            !bytes
                .windows(secret.len())
                .any(|part| part == secret.as_bytes())
        );
    }
}

#[test]
fn cancelled_picker_closes_without_credentials_or_network() {
    let session = PickerSession::begin(
        DesktopOAuthClient::new("client.apps.googleusercontent.com".into(), None).unwrap(),
        Duration::from_secs(5),
    )
    .unwrap();
    let error = session
        .finish(&Http, &Vault, &AtomicBool::new(true))
        .err()
        .unwrap();
    assert_eq!(error.kind, ticketd_core::drive::DriveErrorKind::Cancelled);
}
