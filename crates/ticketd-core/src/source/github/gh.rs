//! Read GitHub through the user's CLI. Raw process output stays at this seam.

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    io,
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};

use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

use super::{
    SourceError, missing_credential, request_is_limited, retry_after, transport::HttpResponse,
};

const TIMEOUT: Duration = Duration::from_secs(30);
const BODY_LIMIT: u64 = 16 * 1024 * 1024;
const STDERR_LIMIT: u64 = 64 * 1024;
pub(super) const PROGRAMS: [&str; 4] = [
    "gh",
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
];

pub(super) struct Output {
    pub(super) success: bool,
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: Vec<u8>,
}

const CACHE_ENTRIES: usize = 512;
const CACHE_BYTES: usize = 16 * 1024 * 1024;
const RATE_LIMIT_FALLBACK: u64 = 60;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Operation {
    Read,
    GraphQl,
    Write,
    VerifyRedirect,
}

impl Operation {
    fn bucket(self, endpoint: &str) -> &'static str {
        if self == Self::GraphQl {
            "graphql"
        } else if endpoint.starts_with("search/")
            || url::Url::parse(endpoint).is_ok_and(|url| {
                let path = url.path().trim_start_matches('/');
                path.strip_prefix("api/v3/")
                    .unwrap_or(path)
                    .starts_with("search/")
            })
        {
            "search"
        } else {
            "core"
        }
    }
}

#[derive(Default)]
struct Shared {
    limits: HashMap<(String, &'static str), Instant>,
    entries: VecDeque<(CacheKey, HttpResponse)>,
    bytes: usize,
}

#[derive(PartialEq, Eq)]
struct CacheKey {
    credential: [u8; 32],
    host: String,
    endpoint: String,
}

impl Shared {
    fn remove(&mut self, key: &CacheKey) {
        if let Some(index) = self
            .entries
            .iter()
            .position(|(candidate, _)| candidate == key)
            && let Some((_, previous)) = self.entries.remove(index)
        {
            self.bytes -= previous.body.len();
        }
    }

    fn store(&mut self, key: CacheKey, response: HttpResponse) {
        self.remove(&key);
        self.bytes += response.body.len();
        self.entries.push_back((key, response));
        while self.bytes > CACHE_BYTES || self.entries.len() > CACHE_ENTRIES {
            if let Some((_, evicted)) = self.entries.pop_front() {
                self.bytes -= evicted.body.len();
            }
        }
    }
}

pub(super) enum Authentication<'a> {
    Ambient,
    NamedLookup,
    Scoped(&'a str),
}

// Authentication deliberately has no Debug or Display implementation.
type Runner = dyn Fn(&[&str], Option<&[u8]>, Authentication<'_>, Duration) -> Result<Output, SourceError>
    + Send
    + Sync;

#[derive(Clone)]
pub(super) struct GhApi {
    run: Arc<Runner>,
    state: Arc<Mutex<Shared>>,
    token: Option<Arc<str>>,
    fingerprint: Option<[u8; 32]>,
    account: Option<String>,
}

impl GhApi {
    pub(super) fn new(
        run: impl Fn(
            &[&str],
            Option<&[u8]>,
            Authentication<'_>,
            Duration,
        ) -> Result<Output, SourceError>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self {
            run: Arc::new(run),
            state: Arc::default(),
            token: None,
            fingerprint: None,
            account: None,
        }
    }

    pub(super) fn system() -> Self {
        static STATE: OnceLock<Arc<Mutex<Shared>>> = OnceLock::new();
        let mut api = Self::new(run);
        api.state = STATE.get_or_init(Arc::default).clone();
        api
    }

    pub(super) fn for_account(&self, account: Option<&str>) -> Self {
        let mut scoped = self.clone();
        scoped.token = None;
        scoped.fingerprint = None;
        scoped.account = account.map(str::to_owned);
        scoped
    }

    pub(super) fn with_account_if_unset(&self, account: Option<&str>) -> Self {
        if self.token.is_none() && self.account.is_none() && account.is_some() {
            self.for_account(account)
        } else {
            self.clone()
        }
    }

    pub(super) fn needs_named_scope(&self, account: Option<&str>) -> bool {
        self.token.is_none() && (self.account.is_some() || account.is_some())
    }

    pub(super) fn for_workflow(&self, host: &str) -> Result<Self, SourceError> {
        if self.token.is_some() {
            return Ok(self.clone());
        }
        let mut args = vec!["auth", "token", "--hostname", host];
        let auth = match self.account.as_deref() {
            Some(account) => {
                args.extend(["--user", account]);
                Authentication::NamedLookup
            }
            None => Authentication::Ambient,
        };
        let output = (self.run)(&args, None, auth, TIMEOUT)?;
        if !output.success {
            let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
            if let Some(account) = &self.account {
                if stderr.contains("unknown flag") && stderr.contains("--user") {
                    return Err(SourceError::Unauthenticated(
                        "A pinned GitHub login requires GitHub CLI 2.40 or later. Update the GitHub CLI and try again.".into(),
                    ));
                }
                return Err(SourceError::Unauthenticated(format!(
                    "The GitHub CLI login {account} is unavailable on {host}. Run `gh auth login --hostname {host}` to sign in."
                )));
            }
            return Err(missing_credential());
        }
        let token = std::str::from_utf8(&output.stdout)
            .ok()
            .map(str::trim)
            .filter(|token| !token.is_empty() && !token.chars().any(char::is_whitespace))
            .ok_or_else(missing_credential)?;
        let mut scoped = self.clone();
        scoped.token = Some(Arc::from(token));
        scoped.fingerprint = Some(Sha256::digest(token.as_bytes()).into());
        Ok(scoped)
    }

    pub(super) fn request(
        &self,
        host: &str,
        endpoint: &str,
        operation: Operation,
        body: Option<&[u8]>,
        deadline: Option<Instant>,
    ) -> Result<HttpResponse, SourceError> {
        let bucket = (host.to_owned(), operation.bucket(endpoint));
        let api = if self.token.is_none() && self.account.is_some() {
            self.for_workflow(host)?
        } else {
            self.clone()
        };
        let cache_key =
            (operation == Operation::Read && endpoint != "user" && !endpoint.ends_with("/user"))
                .then_some(api.fingerprint)
                .flatten()
                .map(|credential| CacheKey {
                    credential,
                    host: host.to_owned(),
                    endpoint: endpoint.to_owned(),
                });
        let cached = cache_key.as_ref().and_then(|key| {
            api.state
                .lock()
                .ok()?
                .entries
                .iter()
                .find(|(existing, _)| existing == key)
                .map(|(_, response)| response.clone())
        });
        let if_none_match = cached
            .as_ref()
            .and_then(|response| response.header("etag"))
            .map(|etag| format!("If-None-Match: {etag}"));
        let mut args = vec!["api", "--hostname", host];
        if operation == Operation::VerifyRedirect {
            args.extend(["--verbose", "--method", "HEAD"]);
        } else {
            args.push("--include");
        }
        args.extend(["-H", "Accept: application/vnd.github+json"]);
        let content_length = body.map(|body| format!("Content-Length: {}", body.len()));
        if let Some(content_length) = &content_length {
            // stdin prevents payloads appearing in argv and gives gh a
            // non-rewindable request body for writes (including redirects).
            args.extend([
                "--method",
                "POST",
                "--input",
                "-",
                "-H",
                "Content-Type: application/json",
                "-H",
                content_length,
            ]);
        }
        if let Some(header) = &if_none_match {
            args.extend(["-H", header]);
        }
        args.extend(["--", endpoint]);

        let stop = deadline.map_or_else(
            || Instant::now() + TIMEOUT,
            |deadline| (Instant::now() + TIMEOUT).min(deadline),
        );
        let mut backoffs = [Duration::from_millis(250), Duration::from_secs(1)].into_iter();
        loop {
            if let Ok(mut state) = api.state.lock() {
                let now = Instant::now();
                state.limits.retain(|_, until| *until > now);
                if let Some(until) = state.limits.get(&bucket) {
                    return Err(SourceError::RateLimited {
                        retry_after_secs: Some(until.duration_since(now).as_secs().max(1)),
                    });
                }
            }
            let auth = api
                .token
                .as_deref()
                .map_or(Authentication::Ambient, Authentication::Scoped);
            let timeout = stop.saturating_duration_since(Instant::now());
            if timeout.is_zero() {
                return Err(if operation == Operation::Write {
                    SourceError::NotSent(
                        "The publication deadline passed before GitHub was called.".into(),
                    )
                } else {
                    SourceError::Unavailable(TIMED_OUT.into())
                });
            }
            let result = (api.run)(&args, body, auth, timeout);
            let response = match result {
                Ok(output) => api.read_output(output, operation, endpoint),
                Err(error) => Err(error),
            };
            let retry = match &response {
                Ok(response) => (500..600).contains(&response.status),
                Err(error) => matches!(error, SourceError::Unavailable(message) if
                    message == OFFLINE || message == TIMED_OUT),
            };
            if operation != Operation::Write
                && retry
                && let Some(delay) = backoffs.next()
                && delay < stop.saturating_duration_since(Instant::now())
            {
                std::thread::sleep(delay);
                continue;
            }
            let mut response = response?;
            if request_is_limited(&response) || graphql_rate_limit(&response, operation) {
                let seconds = retry_after(&response).unwrap_or(RATE_LIMIT_FALLBACK).max(1);
                if let Ok(mut state) = api.state.lock()
                    && let Some(reset) = Instant::now().checked_add(Duration::from_secs(seconds))
                {
                    state
                        .limits
                        .entry(bucket)
                        .and_modify(|until| *until = (*until).max(reset))
                        .or_insert(reset);
                }
                return Err(SourceError::RateLimited {
                    retry_after_secs: Some(seconds),
                });
            }
            if response.status == 304 {
                let mut cached = cached.ok_or_else(|| {
                    SourceError::Protocol("GitHub returned 304 without a cached response".into())
                })?;
                // The cached body is unchanged. The server can update metadata.
                cached.headers.append(&mut response.headers);
                return Ok(cached);
            }
            if let Some(key) = cache_key
                && let Ok(mut state) = api.state.lock()
            {
                if response.status == 200 && response.header("etag").is_some() {
                    state.store(key, response.clone());
                } else if response.status < 500 {
                    state.remove(&key);
                }
            }
            return Ok(response);
        }
    }

    fn read_output(
        &self,
        output: Output,
        operation: Operation,
        endpoint: &str,
    ) -> Result<HttpResponse, SourceError> {
        if operation == Operation::VerifyRedirect {
            // HEAD has no response body, so only actual response headers are read.
            return parse_redirect_trace(&output.stdout, endpoint);
        }
        if let Some(response) = parse_response(output.stdout)
            && (output.success || response.status >= 300 || operation == Operation::GraphQl)
        {
            return Ok(response);
        }
        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if stderr.contains("gh auth login") || stderr.contains("gh_token environment variable") {
            return Err(missing_credential());
        }
        if output.success {
            return Err(SourceError::Protocol(
                "the GitHub CLI response had no HTTP headers".into(),
            ));
        }
        // Some gh versions report API errors on stderr without the headers.
        // Only use known status markers. Raw output may contain sensitive data.
        if let Some(status) = [
            (401, "http 401"),
            (403, "http 403"),
            (404, "http 404"),
            (429, "http 429"),
        ]
        .into_iter()
        .find_map(|(status, marker)| stderr.contains(marker).then_some(status))
        {
            let mut response = HttpResponse {
                status,
                ..Default::default()
            };
            if status == 403 && stderr.contains("rate limit") {
                response
                    .headers
                    .insert("retry-after".into(), RATE_LIMIT_FALLBACK.to_string());
            }
            return Ok(response);
        }
        if operation == Operation::Write
            && [
                "no such host",
                "connection refused",
                "network is unreachable",
                "no route to host",
            ]
            .iter()
            .any(|message| stderr.contains(message))
        {
            return Err(SourceError::NotSent(
                "Could not reach GitHub. The issue was never sent.".into(),
            ));
        }
        Err(SourceError::Unavailable(OFFLINE.into()))
    }
}

pub(in crate::source) const NOT_INSTALLED: &str =
    "the GitHub CLI (gh) was not found. Install it to use GitHub";
const OFFLINE: &str = "Could not reach GitHub. Check your network connection and try again.";
const TIMED_OUT: &str = "the GitHub CLI request timed out";

fn graphql_rate_limit(response: &HttpResponse, operation: Operation) -> bool {
    operation == Operation::GraphQl
        && serde_json::from_slice::<serde_json::Value>(&response.body)
            .ok()
            .and_then(|value| {
                Some(value.get("errors")?.as_array()?.iter().any(|error| {
                    error.get("type").and_then(serde_json::Value::as_str) == Some("RATE_LIMITED")
                        || error
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .is_some_and(|message| {
                                message.to_ascii_lowercase().contains("rate limit")
                            })
                }))
            })
            .unwrap_or(false)
}

fn parse_redirect_trace(stdout: &[u8], endpoint: &str) -> Result<HttpResponse, SourceError> {
    let error =
        || SourceError::Protocol("GitHub did not confirm a permanent issue redirect".into());
    let trace = String::from_utf8_lossy(stdout);
    let mut responses = trace.split("\n\n").filter_map(|segment| {
        let lines = segment.lines().filter_map(|line| line.strip_prefix("< "));
        let headers = lines.collect::<Vec<_>>().join("\n");
        if headers.is_empty() {
            return None;
        }
        parse_response(format!("{headers}\n\n").into_bytes())
    });
    let mut url = url::Url::parse(endpoint).map_err(|_| error())?;
    let api_path = url.path().rsplitn(6, '/').last().ok_or_else(error)?;
    let api_root = format!("{}{api_path}/repos/", url.origin().ascii_serialization());

    // Preserve the issue transfer rule across gh's automatic redirects:
    // every hop must be permanent and point to an issue on this API.
    for index in 0..=super::MAX_REDIRECTS {
        let mut response = responses.next().ok_or_else(error)?;
        if index > 0 && response.status == 200 && responses.next().is_none() {
            response.headers.insert("location".into(), url.to_string());
            return Ok(response);
        }
        if !matches!(response.status, 301 | 308) {
            return Err(error());
        }
        url = url
            .join(response.header("location").ok_or_else(error)?)
            .map_err(|_| error())?;
        let (repository, number) = url
            .as_str()
            .strip_prefix(&api_root)
            .and_then(|path| path.rsplit_once("/issues/"))
            .ok_or_else(error)?;
        if super::split_locator(&format!("{repository}#{number}")).is_err()
            || number.parse::<u64>().ok().is_none_or(|number| number == 0)
        {
            return Err(error());
        }
    }
    Err(error())
}

fn parse_response(mut stdout: Vec<u8>) -> Option<HttpResponse> {
    let mut end = 0;
    let mut separator = 0;
    for line in stdout.split_inclusive(|byte| *byte == b'\n') {
        if matches!(line, b"\n" | b"\r\n") {
            separator = line.len();
            break;
        }
        end += line.len();
    }
    if separator == 0 {
        return None;
    }
    let mut lines = std::str::from_utf8(&stdout[..end]).ok()?.lines();
    let (version, rest) = lines.next()?.split_once(' ')?;
    if !version.starts_with("HTTP/") {
        return None;
    }
    let status = rest.split_whitespace().next()?.parse().ok()?;
    let mut headers = BTreeMap::new();
    for line in lines {
        let (name, value) = line.split_once(':')?;
        headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
    }
    let body = stdout.split_off(end + separator);
    Some(HttpResponse {
        status,
        headers,
        body,
    })
}

fn run(
    args: &[&str],
    input: Option<&[u8]>,
    auth: Authentication<'_>,
    timeout: Duration,
) -> Result<Output, SourceError> {
    // The connector is synchronous, including when called by a Tokio worker.
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("github-cli".into())
            .spawn_scoped(scope, || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(process_error)?;
                runtime.block_on(run_with_timeout(&PROGRAMS, args, input, auth, timeout))
            })
            .map_err(process_error)?
            .join()
            .map_err(|_| {
                SourceError::Unavailable("the GitHub CLI worker stopped unexpectedly".into())
            })?
    })
}

fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    command
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "")
        .env("GH_TELEMETRY", "false")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env_remove("CLICOLOR_FORCE")
        .env_remove("GH_DEBUG")
        .env_remove("GH_FORCE_TTY");
    #[cfg(windows)]
    command.creation_flags(windows::Win32::System::Threading::CREATE_NO_WINDOW.0);
    command
}

pub(in crate::source) async fn sign_in(
    host: &str,
    mut canceled: tokio::sync::watch::Receiver<bool>,
    mut code: impl FnMut(String) -> Result<(), SourceError>,
    mut browser: impl FnMut(String) -> Result<(), SourceError>,
) -> Result<(), SourceError> {
    let expected = url::Url::parse(&format!("https://{host}/login/device"))
        .map_err(|_| SourceError::Unavailable("the GitHub sign-in host is invalid".into()))?;
    let mut child = None;
    for program in PROGRAMS {
        match command(program)
            .args(["auth", "login", "--web", "--hostname", host])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(process) => {
                child = Some(process);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(process_error(error)),
        }
    }
    let mut child = child.ok_or_else(|| SourceError::Unavailable(NOT_INSTALLED.into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| missing_output("stderr"))?;
    let mut lines = BufReader::new(stderr.take(STDERR_LIMIT)).lines();
    let finished = tokio::time::timeout(Duration::from_secs(900), async {
        let mut sent_code = false;
        let mut opened = false;
        while let Some(line) = lines.next_line().await.map_err(process_error)? {
            if !sent_code
                && let Some((_, value)) = line.split_once("First copy your one-time code:")
                && let Some((first, last)) = value.trim().split_once('-')
                && [first, last].into_iter().all(|part| {
                    part.len() == 4
                        && part
                            .bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
                })
            {
                code(value.trim().to_owned())?;
                sent_code = true;
            }
            if !opened
                && let Some((_, value)) =
                    line.split_once("Open this URL to continue in your web browser:")
                && url::Url::parse(value.trim()).is_ok_and(|url| url == expected)
            {
                browser(expected.to_string())?;
                opened = true;
            }
        }
        if child.wait().await.map_err(process_error)?.success() {
            Ok(())
        } else {
            Err(SourceError::Unauthenticated(
                "GitHub sign-in did not finish. Try again.".into(),
            ))
        }
    });
    tokio::select! {
        result = finished => result.map_err(|_| SourceError::Unavailable("GitHub sign-in timed out. Try again.".into()))?,
        _ = canceled.wait_for(|value| *value) => Err(SourceError::RefreshCanceled),
    }
}

async fn run_with_timeout(
    programs: &[&str],
    args: &[&str],
    input: Option<&[u8]>,
    auth: Authentication<'_>,
    timeout: Duration,
) -> Result<Output, SourceError> {
    for program in programs {
        let mut command = command(program);
        command
            .args(args)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if !matches!(auth, Authentication::Ambient) {
            for key in [
                "GH_TOKEN",
                "GITHUB_TOKEN",
                "GH_ENTERPRISE_TOKEN",
                "GITHUB_ENTERPRISE_TOKEN",
            ] {
                command.env_remove(key);
            }
        }
        if let Authentication::Scoped(token) = auth {
            let host = args.get(2).copied().unwrap_or_default();
            let key = if host == "github.com" || host.ends_with(".ghe.com") {
                "GH_TOKEN"
            } else {
                "GH_ENTERPRISE_TOKEN"
            };
            command.env(key, token);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(process_error(error)),
        };
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| missing_output("stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| missing_output("stderr"))?;
        let stdin = child.stdin.take();
        let output = tokio::time::timeout(timeout, async {
            tokio::try_join!(
                child.wait(),
                read_output(stdout.take(BODY_LIMIT + 1), BODY_LIMIT),
                read_output(stderr.take(STDERR_LIMIT + 1), STDERR_LIMIT),
                async {
                    if let (Some(input), Some(mut stdin)) = (input, stdin)
                        && let Err(error) = stdin.write_all(input).await
                        && error.kind() != io::ErrorKind::BrokenPipe
                    {
                        return Err(error);
                    }
                    Ok(())
                }
            )
        })
        .await;
        let error = match output {
            Ok(Ok((status, stdout, stderr, ()))) => {
                return Ok(Output {
                    success: status.success(),
                    stdout,
                    stderr,
                });
            }
            Ok(Err(error)) => process_error(error),
            Err(_) => SourceError::Unavailable(TIMED_OUT.into()),
        };
        let _ = child.kill().await;
        return Err(error);
    }
    Err(SourceError::Unavailable(NOT_INSTALLED.into()))
}

async fn read_output(
    mut stream: impl tokio::io::AsyncRead + Unpin,
    limit: u64,
) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let size = stream.read_to_end(&mut output).await?;
    if size as u64 > limit {
        return Err(io::ErrorKind::FileTooLarge.into());
    }
    Ok(output)
}

fn process_error(error: io::Error) -> SourceError {
    let message = match error.kind() {
        io::ErrorKind::FileTooLarge => "the GitHub CLI response exceeded the output limit",
        io::ErrorKind::PermissionDenied => "permission denied while running the GitHub CLI",
        _ => "could not run the GitHub CLI",
    };
    SourceError::Unavailable(message.into()).with_detail(error)
}

fn missing_output(stream: &str) -> SourceError {
    SourceError::Unavailable(format!("could not capture GitHub CLI {stream}"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runs_with_machine_readable_output_and_preserves_failures() {
        let output = run_with_timeout(
            &["/bin/sh"],
            &[
                "-c",
                "printf '%s:%s:%s:%s:%s' \"$GH_PROMPT_DISABLED\" \"$GH_PAGER\" \"$NO_COLOR\" \"$CLICOLOR_FORCE\" \"$0\"; printf 'failure detail' >&2; exit 1",
                "repos/acme/widgets/issues?state=open&per_page=20",
            ],
            None,
            Authentication::Ambient,
            TIMEOUT,
        )
        .await
        .unwrap();
        assert!(!output.success);
        assert_eq!(
            output.stdout,
            b"1::1::repos/acme/widgets/issues?state=open&per_page=20"
        );
        assert_eq!(output.stderr, b"failure detail");
    }

    #[tokio::test]
    async fn an_unresponsive_process_returns_a_timeout() {
        let error = run_with_timeout(
            &["/bin/sh"],
            &["-c", "while :; do :; done"],
            None,
            Authentication::Ambient,
            Duration::from_millis(20),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.to_string(), "the GitHub CLI request timed out");
    }
}

#[cfg(test)]
#[test]
fn unchanged_repository_reads_reuse_the_authenticated_representation() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let calls = AtomicUsize::new(0);
    let gh = GhApi::new(move |args, _, auth, _| {
        if args[0] == "auth" {
            return Ok(Output {
                success: true,
                stdout: b"fixture".to_vec(),
                stderr: Vec::new(),
            });
        }
        assert!(matches!(auth, Authentication::Scoped("fixture")));
        let first = calls.fetch_add(1, Ordering::Relaxed) == 0;
        let stdout = if first {
            b"HTTP/2.0 200 OK\r\nETag: \"one\"\r\nLink: <https://api.github.com/user/repos?page=2>; rel=\"next\"\r\n\r\n[{}]".as_slice()
        } else {
            assert!(args.contains(&"If-None-Match: \"one\""));
            b"HTTP/2.0 304 Not Modified\r\n\r\n"
        };
        Ok(Output {
            success: first,
            stdout: stdout.to_vec(),
            stderr: Vec::new(),
        })
    });
    let gh = gh.for_workflow("github.com").unwrap();
    let first = gh
        .request("github.com", "user/repos", Operation::Read, None, None)
        .unwrap();
    let unchanged = gh
        .request("github.com", "user/repos", Operation::Read, None, None)
        .unwrap();
    assert_eq!(unchanged.body, first.body);
    assert_eq!(unchanged.header("link"), first.header("link"));
}

#[cfg(test)]
#[test]
fn a_rate_limit_pauses_only_the_reported_host_and_bucket() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let gh = GhApi::new(move |args, _, _, _| {
        let first = counted.fetch_add(1, Ordering::Relaxed) == 0;
        let stdout = if first {
            assert_eq!(args[2], "github.com");
            b"HTTP/2.0 403 Forbidden\r\nX-RateLimit-Remaining: 0\r\nRetry-After: 1\r\n\r\n{}"
                .as_slice()
        } else {
            b"HTTP/2.0 200 OK\r\n\r\n{}".as_slice()
        };
        Ok(Output {
            success: !first,
            stdout: stdout.to_vec(),
            stderr: Vec::new(),
        })
    });
    let read = |host, endpoint, operation| gh.request(host, endpoint, operation, None, None);
    assert!(matches!(
        read("github.com", "user", Operation::Read),
        Err(SourceError::RateLimited { .. })
    ));
    assert!(matches!(
        read("github.com", "repos/o/r/issues", Operation::Write),
        Err(SourceError::RateLimited { .. })
    ));
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    assert!(read("github.com", "graphql", Operation::GraphQl).is_ok());
    assert!(read("github.example", "user", Operation::Read).is_ok());
    assert_eq!(calls.load(Ordering::Relaxed), 3);
    std::thread::sleep(Duration::from_secs(1));
    assert!(read("github.com", "user", Operation::Read).is_ok());
    assert_eq!(calls.load(Ordering::Relaxed), 4);
}
