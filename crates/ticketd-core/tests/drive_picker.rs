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
        Ok(DriveResponse { status: 200, body: br#"{"access_token":"access-secret","refresh_token":"refresh-secret","scope":"https://www.googleapis.com/auth/drive.file"}"#.to_vec() })
    }
}

struct Reconnect;
impl DriveTransport for Reconnect {
    fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError> {
        if request.method == "GET" {
            return Http.send(request);
        }
        Ok(DriveResponse { status: 200, body: br#"{"access_token":"access-secret","scope":"https://www.googleapis.com/auth/drive.file"}"#.to_vec() })
    }
}
struct DifferentAccount;
impl DriveTransport for DifferentAccount {
    fn send(&self, request: DriveRequest) -> Result<DriveResponse, DriveError> {
        if request.method == "GET" {
            return Ok(DriveResponse {
                status: 200,
                body: br#"{"user":{"permissionId":"other-account"}}"#.to_vec(),
            });
        }
        Http.send(request)
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
        write!(socket, "GET {path}?{query}&code=authorization-secret&picked_file_ids=first,second HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).unwrap();
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
