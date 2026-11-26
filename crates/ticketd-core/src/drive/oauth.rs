use super::{
    CredentialStore, DRIVE_FILE_SCOPE, DriveCredential, DriveError, DriveErrorKind, DriveRequest,
    DriveTransport,
    client::{api_disabled_error, invalid_response},
    provider::{credential_lock, token_request},
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
    /// Builds bundle the publisher's installed-app registration. A runtime file
    /// remains an explicit developer override, outside workspace data and Git.
    pub fn from_environment() -> Result<Self, DriveError> {
        let path =
            std::env::var_os("TICKETD_GOOGLE_OAUTH_CLIENT_FILE").map(std::path::PathBuf::from);
        Self::from_configuration(
            path.as_deref(),
            option_env!("TICKETD_GOOGLE_OAUTH_CLIENT_JSON"),
        )
    }

    fn from_configuration(
        override_file: Option<&std::path::Path>,
        bundled_json: Option<&str>,
    ) -> Result<Self, DriveError> {
        if let Some(path) = override_file {
            let bytes = std::fs::read(path).map_err(|_| invalid_override())?;
            return Self::from_json(&bytes).map_err(|_| invalid_override());
        }
        let json = bundled_json
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(unconfigured)?;
        Self::from_json(json.as_bytes())
    }

    fn from_json(bytes: &[u8]) -> Result<Self, DriveError> {
        #[derive(Deserialize)]
        struct Config {
            installed: Installed,
        }
        #[derive(Deserialize)]
        struct Installed {
            client_id: String,
            client_secret: Option<String>,
        }
        let config: Config = serde_json::from_slice(bytes).map_err(|_| unconfigured())?;
        Self::new(config.installed.client_id, config.installed.client_secret)
    }
}
fn unconfigured() -> DriveError {
    DriveError::new(
        DriveErrorKind::Unconfigured,
        "This build does not include a valid Google Drive app configuration. Install a ticketd build with Google Drive enabled, then sign in with Google; local files remain available",
    )
}
fn invalid_override() -> DriveError {
    DriveError::new(
        DriveErrorKind::Unconfigured,
        "The developer override TICKETD_GOOGLE_OAUTH_CLIENT_FILE must point to a valid Desktop OAuth client JSON. Fix it or unset it to use this build's Google Drive configuration, then restart ticketd",
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
    /// A sign-in picks no files and learns which account signed in.
    sign_in: bool,
    /// Choosing a folder names the account too, so Settings can say whose folder it is.
    names_account: bool,
}
pub struct DriveSelection {
    pub connection_id: String,
    pub file_ids: Vec<String>,
    /// The account's email address, after [`PickerSession::begin_sign_in`] when
    /// Google names it.
    pub account: Option<String>,
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
    /// Sign in without choosing files: the app only reaches files it creates.
    pub fn begin_sign_in(
        client: DesktopOAuthClient,
        timeout: Duration,
    ) -> Result<Self, DriveError> {
        let mut session = Self::begin(client, timeout)?;
        let mut url =
            url::Url::parse(&session.authorization_url).map_err(|_| invalid_response())?;
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .into_owned()
            .filter(|(k, _)| k != "allow_multiple" && k != "trigger_onepick")
            .collect();
        url.set_query(None);
        url.query_pairs_mut().extend_pairs(pairs);
        session.authorization_url = url.into();
        session.sign_in = true;
        session.names_account = true;
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
        session.names_account = true;
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
            sign_in: false,
            names_account: false,
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
            // Windows accept inherits the listener's nonblocking mode. The
            // callback request may arrive in fragments, so restore blocking I/O
            // before reading it and then apply the bounded socket timeouts.
            socket
                .set_nonblocking(false)
                .map_err(|_| loopback_error())?;
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
            let page = if valid && self.sign_in {
                "Signed in. Return to ticketd. You can close this tab."
            } else if valid {
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
            if file_ids.is_empty() && !self.sign_in {
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
                url: if self.names_account {
                    "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)"
                } else {
                    "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)"
                }
                .into(),
                headers: vec![(
                    "Authorization".into(),
                    format!("Bearer {}", token.access_token),
                )],
                body: vec![],
            })?;
            if account.status != 200 {
                return Err(api_disabled_error(&account).unwrap_or_else(invalid_response));
            }
            let account: serde_json::Value =
                serde_json::from_slice(&account.body).map_err(|_| invalid_response())?;
            let email = account["user"]["emailAddress"].as_str().map(str::to_owned);
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
                        account: None,
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
                account: email,
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

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLED: &str = r#"{"installed":{"client_id":"publisher.apps.googleusercontent.com","client_secret":"desktop-client-secret"}}"#;

    #[test]
    fn bundled_client_requires_no_runtime_file() {
        let client = DesktopOAuthClient::from_configuration(None, Some(BUNDLED)).unwrap();
        assert_eq!(client.client_id, "publisher.apps.googleusercontent.com");
        assert_eq!(
            client.client_secret.as_deref(),
            Some("desktop-client-secret")
        );
    }

    #[test]
    fn explicit_developer_file_overrides_the_bundled_registration() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("desktop-client.json");
        std::fs::write(
            &path,
            r#"{"installed":{"client_id":"developer.apps.googleusercontent.com"}}"#,
        )
        .unwrap();
        let client = DesktopOAuthClient::from_configuration(Some(&path), Some(BUNDLED)).unwrap();
        assert_eq!(client.client_id, "developer.apps.googleusercontent.com");
        assert!(client.client_secret.is_none());
    }

    #[test]
    fn invalid_developer_override_never_silently_uses_the_bundled_registration() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("desktop-client.json");
        for contents in [None, Some("invalid-client-secret"), Some(r#"{"web":{}}"#)] {
            if let Some(contents) = contents {
                std::fs::write(&path, contents).unwrap();
            }
            let error = DesktopOAuthClient::from_configuration(Some(&path), Some(BUNDLED))
                .err()
                .unwrap();
            assert_eq!(error.kind, DriveErrorKind::Unconfigured);
            assert!(error.message.contains("TICKETD_GOOGLE_OAUTH_CLIENT_FILE"));
            assert!(!error.message.contains("invalid-client-secret"));
        }
    }

    #[test]
    fn missing_or_invalid_bundled_registration_gives_installation_guidance() {
        for contents in [
            None,
            Some(""),
            Some("invalid-client-secret"),
            Some(r#"{"installed":{"client_id":"invalid"}}"#),
            Some(r#"{"web":{"client_id":"web.apps.googleusercontent.com"}}"#),
        ] {
            let error = DesktopOAuthClient::from_configuration(None, contents)
                .err()
                .unwrap();
            assert_eq!(error.kind, DriveErrorKind::Unconfigured);
            assert!(error.message.contains("Install a ticketd build"));
            assert!(!error.message.contains("TICKETD_GOOGLE"));
            assert!(!error.message.contains("invalid-client-secret"));
        }
    }

    #[test]
    fn distribution_client_is_valid() {
        if let Some(json) =
            option_env!("TICKETD_GOOGLE_OAUTH_CLIENT_JSON").filter(|value| !value.is_empty())
        {
            assert!(
                DesktopOAuthClient::from_configuration(None, Some(json)).is_ok(),
                "TICKETD_GOOGLE_OAUTH_CLIENT_JSON must contain a valid Desktop OAuth client JSON"
            );
            if std::env::var_os("TICKETD_GOOGLE_OAUTH_CLIENT_FILE").is_none() {
                assert!(DesktopOAuthClient::from_environment().is_ok());
            }
        }
    }
}
