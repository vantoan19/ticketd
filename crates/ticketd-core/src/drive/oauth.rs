use super::{
    CredentialStore, DRIVE_FILE_SCOPE, DriveCredential, DriveError, DriveErrorKind, DriveRequest,
    DriveTransport,
    provider::{credential_lock, invalid_response, token_request},
    valid_file_id,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::TcpListener,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub struct DesktopOAuthClient {
    client_id: String,
    client_secret: Option<String>,
}
impl DesktopOAuthClient {
    pub fn new(client_id: String, client_secret: Option<String>) -> Result<Self, DriveError> {
        if !client_id.ends_with(".apps.googleusercontent.com")
            || client_id.contains(char::is_whitespace)
        {
            return Err(unconfigured());
        }
        Ok(Self {
            client_id,
            client_secret,
        })
    }
    /// The operator-owned installed-app JSON stays outside workspace data/Git.
    pub fn from_environment() -> Result<Self, DriveError> {
        let path = std::env::var_os("TICKETD_GOOGLE_OAUTH_CLIENT_FILE").ok_or_else(unconfigured)?;
        let bytes = std::fs::read(path).map_err(|_| unconfigured())?;
        #[derive(Deserialize)]
        struct Config {
            installed: Installed,
        }
        #[derive(Deserialize)]
        struct Installed {
            client_id: String,
            client_secret: Option<String>,
        }
        let config: Config = serde_json::from_slice(&bytes).map_err(|_| unconfigured())?;
        Self::new(config.installed.client_id, config.installed.client_secret)
    }
}
fn unconfigured() -> DriveError {
    DriveError::new(
        DriveErrorKind::Unconfigured,
        "Google Drive is not configured: set TICKETD_GOOGLE_OAUTH_CLIENT_FILE to a Desktop OAuth client JSON outside the workspace, enable Drive and Picker APIs, and restart ticketd; local files remain available",
    )
}

/// One-shot, bounded, Rust-owned operation. No code, verifier or token crosses IPC.
pub struct PickerSession {
    listener: TcpListener,
    client: DesktopOAuthClient,
    authorization_url: String,
    redirect_uri: String,
    state: String,
    verifier: String,
    timeout: Duration,
    recovery: Option<super::DriveReference>,
}
pub struct DriveSelection {
    pub connection_id: String,
    pub file_ids: Vec<String>,
}
impl PickerSession {
    pub(super) fn begin_recovery(
        client: DesktopOAuthClient,
        timeout: Duration,
        reference: super::DriveReference,
    ) -> Result<Self, DriveError> {
        let mut session = Self::begin(client, timeout)?;
        let mut url =
            url::Url::parse(&session.authorization_url).map_err(|_| invalid_response())?;
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .into_owned()
            .filter(|(k, _)| k != "allow_multiple")
            .collect();
        url.set_query(None);
        url.query_pairs_mut()
            .extend_pairs(pairs)
            .append_pair("allow_multiple", "false");
        session.authorization_url = url.into();
        session.recovery = Some(reference);
        Ok(session)
    }
    pub fn begin_folder(client: DesktopOAuthClient, timeout: Duration) -> Result<Self, DriveError> {
        let mut session = Self::begin(client, timeout)?;
        let mut url =
            url::Url::parse(&session.authorization_url).map_err(|_| invalid_response())?;
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .into_owned()
            .filter(|(k, _)| k != "allow_multiple")
            .collect();
        url.set_query(None);
        url.query_pairs_mut().extend_pairs(pairs).extend_pairs([
            ("allow_multiple", "false"),
            ("allow_folder_selection", "true"),
            ("mimetypes", "application/vnd.google-apps.folder"),
        ]);
        session.authorization_url = url.into();
        Ok(session)
    }
    pub fn begin(client: DesktopOAuthClient, timeout: Duration) -> Result<Self, DriveError> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| loopback_error())?;
        listener
            .set_nonblocking(true)
            .map_err(|_| loopback_error())?;
        let redirect_uri = format!(
            "http://127.0.0.1:{}/oauth2callback",
            listener.local_addr().map_err(|_| loopback_error())?.port()
        );
        let state = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
            .map_err(|_| invalid_response())?;
        url.query_pairs_mut().extend_pairs([
            ("client_id", client.client_id.as_str()),
            ("redirect_uri", &redirect_uri),
            ("response_type", "code"),
            ("scope", DRIVE_FILE_SCOPE),
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("trigger_onepick", "true"),
            ("allow_multiple", "true"),
            ("state", &state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ]);
        Ok(Self {
            listener,
            client,
            authorization_url: url.into(),
            redirect_uri,
            state,
            verifier,
            timeout: timeout.min(Duration::from_secs(180)),
            recovery: None,
        })
    }
    pub fn authorization_url(&self) -> &str {
        &self.authorization_url
    }

    /// Consume exactly one validated callback. Unrelated paths/states are refused
    /// without completing the operation; cancellation never creates references.
    pub fn finish(
        self,
        transport: &dyn DriveTransport,
        vault: &dyn CredentialStore,
        cancelled: &AtomicBool,
    ) -> Result<DriveSelection, DriveError> {
        let deadline = Instant::now() + self.timeout;
        while Instant::now() < deadline {
            if cancelled.load(Ordering::SeqCst) {
                return Err(cancelled_error());
            }
            let (mut socket, peer) = match self.listener.accept() {
                Ok(value) => value,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                Err(_) => return Err(loopback_error()),
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            socket
                .set_read_timeout(Some(Duration::from_millis(500)))
                .map_err(|_| loopback_error())?;
            socket
                .set_write_timeout(Some(Duration::from_millis(500)))
                .map_err(|_| loopback_error())?;
            let mut request = Vec::new();
            let read_deadline = Instant::now() + Duration::from_secs(1);
            let mut buffer = [0; 1024];
            while request.len() < 16 * 1024
                && Instant::now() < read_deadline
                && !request.ends_with(b"\r\n\r\n")
            {
                let Ok(count) = socket.read(&mut buffer) else {
                    break;
                };
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
            }
            let callback = self.parse_callback(&request);
            let valid = callback.is_some();
            let page = if valid {
                "Selection received. Return to ticketd. You can close this tab."
            } else {
                "Invalid callback. Return to ticketd and retry selection."
            };
            let _ = write!(
                socket,
                "HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{page}",
                if valid { "200 OK" } else { "400 Bad Request" },
                page.len()
            );
            drop(socket);
            let Some(fields) = callback else { continue };
            if fields.contains_key("error") || cancelled.load(Ordering::SeqCst) {
                return Err(cancelled_error());
            }
            let code = fields
                .get("code")
                .filter(|v| !v.is_empty())
                .ok_or_else(invalid_response)?;
            let file_ids: Vec<String> = fields
                .get("picked_file_ids")
                .into_iter()
                .flat_map(|v| v.split(','))
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .collect();
            if file_ids.is_empty() {
                return Err(cancelled_error());
            }
            if file_ids.len() > 100 || file_ids.iter().any(|id| !valid_file_id(id)) {
                return Err(invalid_response());
            }
            if fields.get("scope").is_some_and(|v| v != DRIVE_FILE_SCOPE) {
                return Err(invalid_response());
            }
            let mut fields = vec![
                ("grant_type", "authorization_code"),
                ("client_id", &self.client.client_id),
                ("redirect_uri", &self.redirect_uri),
                ("code", code),
                ("code_verifier", &self.verifier),
            ];
            if let Some(secret) = self.client.client_secret.as_deref() {
                fields.push(("client_secret", secret));
            }
            let token = token_request(transport, &fields)?;
            // An exchange must positively confirm narrow granted scope. No token
            // from a broader previous grant is accepted into the secure store.
            if token.scope.as_deref() != Some(DRIVE_FILE_SCOPE) {
                return Err(invalid_response());
            }
            let account = transport.send(DriveRequest {
                method: "GET",
                url: "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)".into(),
                headers: vec![(
                    "Authorization".into(),
                    format!("Bearer {}", token.access_token),
                )],
                body: vec![],
            })?;
            if account.status != 200 {
                return Err(invalid_response());
            }
            let account: serde_json::Value =
                serde_json::from_slice(&account.body).map_err(|_| invalid_response())?;
            let permission_id = account["user"]["permissionId"]
                .as_str()
                .filter(|id| valid_file_id(id))
                .ok_or_else(invalid_response)?;
            // Same client/account reconnects reuse a handle. A different account
            // gets a different handle, so existing references cannot switch users.
            let connection_id = Uuid::new_v5(
                &Uuid::NAMESPACE_URL,
                format!(
                    "ticketd:google-drive:{}:{permission_id}",
                    self.client.client_id
                )
                .as_bytes(),
            )
            .to_string();
            if let Some(reference) = &self.recovery {
                super::validate_recovery_selection(
                    reference,
                    &DriveSelection {
                        connection_id: connection_id.clone(),
                        file_ids: file_ids.clone(),
                    },
                )?;
            }
            let _lock = credential_lock(&connection_id)?;
            let refresh_token = match token.refresh_token.filter(|s| !s.is_empty()) {
                Some(token) => token,
                None => vault.load(&connection_id)?.refresh_token,
            };
            if cancelled.load(Ordering::SeqCst) {
                return Err(cancelled_error());
            }
            vault.save(
                &connection_id,
                &DriveCredential {
                    client_id: self.client.client_id,
                    client_secret: self.client.client_secret,
                    refresh_token,
                },
            )?;
            return Ok(DriveSelection {
                connection_id,
                file_ids,
            });
        }
        Err(DriveError::new(
            DriveErrorKind::Cancelled,
            "Drive selection timed out; return to the Google Drive tab and try again",
        ))
    }

    fn parse_callback(&self, bytes: &[u8]) -> Option<BTreeMap<String, String>> {
        let text = std::str::from_utf8(bytes).ok()?;
        if !text.ends_with("\r\n\r\n") {
            return None;
        }
        let mut lines = text.split("\r\n");
        let mut first = lines.next()?.split_whitespace();
        if first.next()? != "GET" {
            return None;
        }
        let target = first.next()?;
        if !target.starts_with("/oauth2callback?")
            || first.next()? != "HTTP/1.1"
            || first.next().is_some()
        {
            return None;
        }
        let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
        let redirect = url::Url::parse(&self.redirect_uri).ok()?;
        let hosts: Vec<_> = lines
            .filter_map(|line| line.split_once(':'))
            .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
            .collect();
        if hosts.len() != 1
            || hosts[0].1.trim() != redirect.authority()
            || url.path() != "/oauth2callback"
        {
            return None;
        }
        let mut fields = BTreeMap::new();
        for (key, value) in url.query_pairs() {
            if fields
                .insert(key.into_owned(), value.into_owned())
                .is_some()
            {
                return None;
            }
        }
        if fields.get("state")? != &self.state {
            return None;
        }
        Some(fields)
    }
}
fn loopback_error() -> DriveError {
    DriveError::new(
        DriveErrorKind::Unconfigured,
        "cannot receive Drive authorization on the local loopback address; check local security settings and retry",
    )
}
fn cancelled_error() -> DriveError {
    DriveError::new(
        DriveErrorKind::Cancelled,
        "Drive selection cancelled; no attachment was inserted",
    )
}
