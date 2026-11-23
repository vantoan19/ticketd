//! The only place that runs the `aws` program (ADR 0018).
//!
//! ticketd never stores an AWS secret. It asks the person's AWS CLI v2 for the credentials
//! of one profile (`aws configure export-credentials`), keeps them in memory until shortly
//! before they expire, and asks again. Arguments are passed as a list, never through a shell.
//! The program's stdout is credentials, so it is never logged or put in an error.
use std::fmt;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use chrono::{DateTime, TimeDelta, Utc};
use serde::Deserialize;

/// `aws configure get --services` is newer than this, but `export-credentials` and
/// service-specific endpoints are not; setup can say what is missing.
const MINIMUM_VERSION: (u64, u64) = (2, 13);
/// Credentials are exported again this long before they expire.
const REFRESH_MARGIN: TimeDelta = TimeDelta::minutes(5);
/// An ordinary call. A profile that runs a helper (`credential_process`) can be slow.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
/// `aws sso login` waits up to 10 minutes for the browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(11 * 60);
/// How much of the CLI's own message an error carries.
const MESSAGE_LIMIT: usize = 2000;

/// Temporary or static AWS credentials. `Debug` shows no key, secret or token.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    /// `None` for static keys, which do not expire.
    pub expires_at: Option<DateTime<Utc>>,
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("access_key_id", &"[redacted]")
            .field("secret_access_key", &"[redacted]")
            .field(
                "session_token",
                &self.session_token.as_ref().map(|_| "[redacted]"),
            )
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// What a profile says about where its requests go.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProfileSettings {
    pub region: Option<String>,
    /// The S3 endpoint of an S3-compatible service; `None` means AWS.
    pub endpoint_url: Option<String>,
}

/// Credentials with the region and endpoint of the profile that produced them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileAccess {
    pub credentials: Credentials,
    pub region: Option<String>,
    pub endpoint_url: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AwsCliError {
    #[error(
        "The AWS CLI was not found. Install AWS CLI version 2, or choose where the aws program is."
    )]
    NotFound,
    #[error("ticketd needs AWS CLI version 2.13 or later; this one reports \"{found}\".")]
    UnsupportedVersion { found: String },
    /// The profile's session ended, or it never signed in. Signing in again fixes it.
    #[error("Sign in to AWS again: {message}")]
    SignInNeeded { message: String },
    #[error("The AWS CLI failed{}: {message}", exit_suffix(*exit_code))]
    Failed {
        exit_code: Option<i32>,
        message: String,
    },
    /// The program answered, but not with credentials ticketd can read. The answer is not
    /// repeated, because it may hold them.
    #[error("The AWS CLI returned credentials in a form ticketd could not read.")]
    Unreadable,
    #[error("The AWS CLI did not answer in time.")]
    TimedOut,
    #[error("Could not run the AWS CLI: {0}")]
    Io(#[source] io::Error),
}

fn exit_suffix(code: Option<i32>) -> String {
    code.map(|code| format!(" (exit code {code})"))
        .unwrap_or_default()
}

impl AwsCliError {
    /// Whether signing in again (see [`AwsCli::sign_in_command`]) would fix this.
    pub fn needs_sign_in(&self) -> bool {
        matches!(self, Self::SignInNeeded { .. })
    }
}

/// An AWS CLI v2 program that was found and is recent enough.
#[derive(Debug, Clone)]
pub struct AwsCli {
    program: PathBuf,
    timeout: Duration,
}

impl AwsCli {
    /// Finds the program: `chosen` when the person picked one, otherwise the usual install
    /// locations. A macOS app opened from Finder has no shell `PATH`, so that is not searched.
    pub fn locate(chosen: Option<&Path>) -> Result<Self, AwsCliError> {
        Self::locate_in(chosen, &usual_locations())
    }

    /// [`Self::locate`] with the locations to look in given, for tests.
    pub fn locate_in(chosen: Option<&Path>, locations: &[PathBuf]) -> Result<Self, AwsCliError> {
        let program = match chosen {
            Some(path) if path.is_file() => path.to_path_buf(),
            Some(_) => return Err(AwsCliError::NotFound),
            None => locations
                .iter()
                .map(|dir| dir.join(PROGRAM_NAME))
                .find(|path| path.is_file())
                .ok_or(AwsCliError::NotFound)?,
        };
        let cli = Self {
            program,
            timeout: COMMAND_TIMEOUT,
        };
        cli.check_version()?;
        Ok(cli)
    }

    /// The program that will run.
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Changes how long an ordinary call may take before it is stopped.
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    fn check_version(&self) -> Result<(), AwsCliError> {
        let output = run(&self.program, &["--version"], self.timeout)?;
        // CLI v1 printed its version on stderr.
        let text = format!("{}\n{}", output.stdout, output.stderr);
        let first_line = text.trim().lines().next().unwrap_or_default().trim();
        let found = || AwsCliError::UnsupportedVersion {
            found: clip(first_line, 200),
        };
        let version = text
            .split_whitespace()
            .find_map(|word| word.strip_prefix("aws-cli/"))
            .and_then(parse_version)
            .ok_or_else(found)?;
        if version >= MINIMUM_VERSION {
            Ok(())
        } else {
            Err(found())
        }
    }

    /// The profile names in the person's AWS CLI configuration.
    pub fn profiles(&self) -> Result<Vec<String>, AwsCliError> {
        let output = self.checked(&["configure", "list-profiles"], self.timeout)?;
        Ok(output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect())
    }

    /// Exports the profile's credentials now. [`ProfileCredentials`] keeps them between calls.
    pub fn credentials(&self, profile: &str) -> Result<Credentials, AwsCliError> {
        let stdout = self
            .checked(
                &["configure", "export-credentials", "--profile", profile],
                self.timeout,
            )
            .map_err(|error| match error {
                AwsCliError::Failed { exit_code, message }
                    if ended_session(exit_code, &message) =>
                {
                    AwsCliError::SignInNeeded { message }
                }
                other => other,
            })?;
        parse_credentials(&stdout)
    }

    /// The profile's region and S3 endpoint. A service-specific endpoint (a `services`
    /// section) wins over `endpoint_url`, as in the AWS CLI itself.
    pub fn settings(&self, profile: &str) -> Result<ProfileSettings, AwsCliError> {
        let region = self.config_value(&["region"], profile)?;
        let endpoint_url = match self.services_endpoint(profile)? {
            Some(endpoint) => Some(endpoint),
            None => self.config_value(&["endpoint_url"], profile)?,
        };
        Ok(ProfileSettings {
            region,
            endpoint_url,
        })
    }

    fn services_endpoint(&self, profile: &str) -> Result<Option<String>, AwsCliError> {
        let Some(services) = self.config_value(&["services"], profile)? else {
            return Ok(None);
        };
        let args = [
            "configure",
            "get",
            "--services",
            &services,
            "s3.endpoint_url",
            "--profile",
            profile,
        ];
        let output = run(&self.program, &args, self.timeout)?;
        match output.code {
            Some(0) => Ok(non_empty(&output.stdout)),
            Some(1) if output.stderr.trim().is_empty() => Ok(None),
            // `configure get --services` arrived in AWS CLI 2.34.22; older ones reject the
            // option. The profile's own `endpoint_url` is then the only one readable.
            Some(252) if output.stderr.contains("Unknown options") => {
                tracing::debug!("aws cli cannot read a services section");
                Ok(None)
            }
            code => Err(failed(code, &output.stderr)),
        }
    }

    /// The command that signs the profile in again: `aws sso login` for an SSO profile,
    /// `aws login` for a console sign-in profile, and `None` for any other (static keys, a
    /// credential helper), where the CLI's own message is what the person needs to read.
    pub fn sign_in_command(&self, profile: &str) -> Result<Option<SignInCommand>, AwsCliError> {
        let is_sso = self.config_value(&["sso_session"], profile)?.is_some()
            || self.config_value(&["sso_start_url"], profile)?.is_some();
        let words: &[&str] = if is_sso {
            &["sso", "login"]
        } else if self.config_value(&["login_session"], profile)?.is_some() {
            &["login"]
        } else {
            return Ok(None);
        };
        let mut args: Vec<String> = words.iter().map(|word| (*word).to_owned()).collect();
        args.extend(["--profile".to_owned(), profile.to_owned()]);
        Ok(Some(SignInCommand {
            program: self.program.clone(),
            args,
        }))
    }

    /// `aws configure get`, where "not set" is `None` and anything else wrong is an error.
    fn config_value(&self, name: &[&str], profile: &str) -> Result<Option<String>, AwsCliError> {
        let mut args = vec!["configure", "get"];
        args.extend(name);
        args.extend(["--profile", profile]);
        let output = run(&self.program, &args, self.timeout)?;
        match output.code {
            Some(0) => Ok(non_empty(&output.stdout)),
            Some(1) if output.stderr.trim().is_empty() => Ok(None),
            code => Err(failed(code, &output.stderr)),
        }
    }

    /// Runs the program and returns its stdout when it exits 0.
    fn checked(&self, args: &[&str], timeout: Duration) -> Result<String, AwsCliError> {
        let output = run(&self.program, args, timeout)?;
        match output.code {
            Some(0) => Ok(output.stdout),
            code => Err(failed(code, &output.stderr)),
        }
    }
}

/// A sign-in the person has to complete, such as in a browser. Running it blocks until they
/// finish, for at most 10 minutes, so run it off the interface's thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInCommand {
    program: PathBuf,
    args: Vec<String>,
}

impl SignInCommand {
    /// The arguments after the program, for example `["sso", "login", "--profile", "work"]`.
    pub fn args(&self) -> &[String] {
        &self.args
    }

    pub fn run(&self) -> Result<(), AwsCliError> {
        let args: Vec<&str> = self.args.iter().map(String::as_str).collect();
        let output = run(&self.program, &args, SIGN_IN_TIMEOUT)?;
        match output.code {
            Some(0) => Ok(()),
            code => Err(failed(code, &output.stderr)),
        }
    }
}

/// A profile's credentials, kept in memory and exported again shortly before they expire.
/// Share one between everything that signs requests for the profile.
pub struct ProfileCredentials {
    cli: AwsCli,
    profile: String,
    clock: Box<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    kept: Mutex<Option<ProfileAccess>>,
}

impl ProfileCredentials {
    pub fn new(cli: AwsCli, profile: impl Into<String>) -> Self {
        Self::with_clock(cli, profile, Utc::now)
    }

    /// [`Self::new`] reading the time from `clock`, for tests.
    pub fn with_clock(
        cli: AwsCli,
        profile: impl Into<String>,
        clock: impl Fn() -> DateTime<Utc> + Send + Sync + 'static,
    ) -> Self {
        Self {
            cli,
            profile: profile.into(),
            clock: Box::new(clock),
            kept: Mutex::new(None),
        }
    }

    /// The credentials to sign with now, exported again when the kept ones are within five
    /// minutes of expiring. A failed export keeps nothing, so the next call tries again.
    pub fn access(&self) -> Result<ProfileAccess, AwsCliError> {
        let mut kept = self.kept.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(access) = kept.as_ref()
            && self.is_fresh(&access.credentials)
        {
            return Ok(access.clone());
        }
        *kept = None;
        let credentials = self.cli.credentials(&self.profile)?;
        let settings = self.cli.settings(&self.profile)?;
        let access = ProfileAccess {
            credentials,
            region: settings.region,
            endpoint_url: settings.endpoint_url,
        };
        *kept = Some(access.clone());
        Ok(access)
    }

    /// Drops what is kept, such as after the person signs in again or the service refuses
    /// the credentials before their expiry.
    pub fn forget(&self) {
        *self.kept.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    fn is_fresh(&self, credentials: &Credentials) -> bool {
        credentials
            .expires_at
            .is_none_or(|expires| (self.clock)() + REFRESH_MARGIN < expires)
    }
}

impl fmt::Debug for ProfileCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProfileCredentials")
            .field("profile", &self.profile)
            .finish_non_exhaustive()
    }
}

// ---- reading the program's answers -----------------------------------------------------

#[cfg(windows)]
const PROGRAM_NAME: &str = "aws.exe";
#[cfg(not(windows))]
const PROGRAM_NAME: &str = "aws";

fn usual_locations() -> Vec<PathBuf> {
    if cfg!(windows) {
        vec![PathBuf::from(r"C:\Program Files\Amazon\AWSCLIV2")]
    } else {
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
            .into_iter()
            .map(PathBuf::from)
            .collect()
    }
}

/// `2.19.5` -> `(2, 19)`.
fn parse_version(text: &str) -> Option<(u64, u64)> {
    let mut parts = text.split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// The CLI exits 253 for "Unable to retrieve credentials" and 255 when an SSO profile has
/// no token at all. Only these messages mean signing in again helps; a missing profile or a
/// network failure share the exit code and do not.
fn ended_session(exit_code: Option<i32>, message: &str) -> bool {
    const MARKERS: [&str; 6] = [
        "token has expired and refresh failed",
        "sso session associated with this profile has expired",
        "error loading sso token",
        "reauthenticate",
        "aws sso login",
        "aws login",
    ];
    matches!(exit_code, Some(253 | 255))
        && MARKERS
            .iter()
            .any(|marker| message.to_ascii_lowercase().contains(marker))
}

#[derive(Deserialize)]
struct Exported {
    #[serde(rename = "AccessKeyId")]
    access_key_id: String,
    #[serde(rename = "SecretAccessKey")]
    secret_access_key: String,
    #[serde(rename = "SessionToken")]
    session_token: Option<String>,
    #[serde(rename = "Expiration")]
    expiration: Option<String>,
}

fn parse_credentials(stdout: &str) -> Result<Credentials, AwsCliError> {
    let exported: Exported = serde_json::from_str(stdout).map_err(|_| AwsCliError::Unreadable)?;
    if exported.access_key_id.is_empty() || exported.secret_access_key.is_empty() {
        return Err(AwsCliError::Unreadable);
    }
    let expires_at = match exported.expiration {
        Some(text) => Some(
            DateTime::parse_from_rfc3339(&text)
                .map_err(|_| AwsCliError::Unreadable)?
                .with_timezone(&Utc),
        ),
        None => None,
    };
    Ok(Credentials {
        access_key_id: exported.access_key_id,
        secret_access_key: exported.secret_access_key,
        session_token: exported.session_token.filter(|token| !token.is_empty()),
        expires_at,
    })
}

fn non_empty(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn clip(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_owned(),
    }
}

fn failed(exit_code: Option<i32>, stderr: &str) -> AwsCliError {
    AwsCliError::Failed {
        exit_code,
        message: clip(stderr.trim(), MESSAGE_LIMIT),
    }
}

// ---- running the program ---------------------------------------------------------------

struct Output {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Runs `program` with `args` and no input, and stops it after `timeout`.
fn run(program: &Path, args: &[&str], timeout: Duration) -> Result<Output, AwsCliError> {
    let mut child = Command::new(program)
        .args(args)
        // A pager would wait for a terminal.
        .env("AWS_PAGER", "")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(AwsCliError::Io)?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let started = Instant::now();
    let status = loop {
        match child.try_wait().map_err(AwsCliError::Io)? {
            Some(status) => break status,
            None if started.elapsed() >= timeout => {
                // The readers are left to end when the pipes close.
                let _ = child.kill();
                let _ = child.wait();
                return Err(AwsCliError::TimedOut);
            }
            None => thread::sleep(Duration::from_millis(10)),
        }
    };
    // A helper the program started may still hold the pipes; do not wait for it forever.
    let grace = Duration::from_secs(2);
    Ok(Output {
        code: status.code(),
        stdout: stdout.recv_timeout(grace).unwrap_or_default(),
        stderr: stderr.recv_timeout(grace).unwrap_or_default(),
    })
}

fn drain(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<String> {
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        let _ = send.send(String::from_utf8_lossy(&bytes).into_owned());
    });
    receive
}
