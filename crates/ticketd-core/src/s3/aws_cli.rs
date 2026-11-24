//! The only place that runs the `aws` program (ADR 0018).
//!
//! ticketd never stores an AWS secret. It asks the person's AWS CLI v2 for the credentials
//! of one profile (`aws configure export-credentials`), keeps them in memory until shortly
//! before they expire, and asks again. Arguments are passed as a list, never through a shell.
//! The program's stdout is credentials, so it is never logged or put in an error.
use std::fmt;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
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
/// The most output of either stream a run keeps. A longer one is an error: the answers
/// ticketd reads (credentials, names, settings) are far smaller.
const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
/// How long [`run`] waits for the output readers once the program has ended or been stopped,
/// because a helper the program started may still hold the pipes.
const PIPE_GRACE: Duration = Duration::from_secs(2);
/// `aws login` arrived in this version of the CLI.
const LOGIN_VERSION: (u64, u64) = (2, 32);

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
    /// `found` is the version the program reported (`2.9.0`), or `None` when its answer held
    /// no version. What it printed is not repeated.
    #[error("{}", too_old_message(found.as_deref()))]
    UnsupportedVersion { found: Option<String> },
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
    /// The program printed more than ticketd keeps, so what it said is not read.
    #[error("The AWS CLI printed far more than expected, so ticketd stopped reading it.")]
    OutputTooLarge,
    /// The profile signs in with `aws login`, which this CLI does not have.
    #[error(
        "This profile signs in with `aws login`, which needs AWS CLI version 2.32 or later; this one is {found}. Update the AWS CLI."
    )]
    LoginNeedsNewerCli { found: String },
    #[error(
        "This profile has a `services` section, which the AWS CLI {found} cannot read (it needs 2.34.22 or later), so ticketd cannot tell which S3 endpoint the profile names. Update the AWS CLI, or put the S3 endpoint in the profile's own endpoint_url and remove `services`."
    )]
    ServicesNeedNewerCli { found: String },
    #[error("Could not run the AWS CLI: {0}")]
    Io(#[source] io::Error),
}

/// The sentence for an AWS CLI that ticketd cannot use for its version: the version found, if
/// it could be read, and the one needed.
#[must_use]
pub fn too_old_message(found: Option<&str>) -> String {
    match found {
        Some(version) => format!("AWS CLI {version} is too old. ticketd needs 2.13 or later."),
        None => {
            "ticketd could not read the AWS CLI's version. ticketd needs 2.13 or later.".to_owned()
        }
    }
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
    version: (u64, u64),
}

impl AwsCli {
    /// Finds the program: `chosen` when the person picked one that is still there, otherwise
    /// the usual install locations. A macOS app opened from Finder has no shell `PATH`, so
    /// that is not searched.
    pub fn locate(chosen: Option<&Path>) -> Result<Self, AwsCliError> {
        Self::locate_in(chosen, &usual_locations())
    }

    /// Checks the program a person just picked, and nothing else: a file that is not there,
    /// or is not a recent AWS CLI, is an error rather than a reason to use another program.
    pub fn locate_chosen(path: &Path) -> Result<Self, AwsCliError> {
        Self::locate_in(Some(path), &[])
    }

    /// [`Self::locate`] with the locations to look in given, for tests. A chosen program that
    /// has since been moved or removed is passed over for the locations.
    pub fn locate_in(chosen: Option<&Path>, locations: &[PathBuf]) -> Result<Self, AwsCliError> {
        let program = chosen
            .filter(|path| path.is_file())
            .map(Path::to_path_buf)
            .or_else(|| {
                locations
                    .iter()
                    .map(|dir| dir.join(PROGRAM_NAME))
                    .find(|path| path.is_file())
            })
            .ok_or(AwsCliError::NotFound)?;
        let mut cli = Self {
            program,
            timeout: COMMAND_TIMEOUT,
            version: (0, 0),
        };
        cli.version = cli.check_version()?;
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

    fn check_version(&self) -> Result<(u64, u64), AwsCliError> {
        let output = run(&self.program, &["--version"], self.timeout)?;
        // CLI v1 printed its version on stderr.
        let text = format!("{}\n{}", output.stdout, output.stderr);
        let word = text
            .split_whitespace()
            .find_map(|word| word.strip_prefix("aws-cli/"));
        let found = |word: Option<&str>| AwsCliError::UnsupportedVersion {
            found: word.and_then(version_text),
        };
        let version = word.and_then(parse_version).ok_or_else(|| found(None))?;
        if version >= MINIMUM_VERSION {
            Ok(version)
        } else {
            Err(found(word))
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
            .map_err(sign_in_if_ended)?;
        parse_credentials(&stdout)
    }

    /// The ARN of the identity the profile signs in as (`aws sts get-caller-identity`),
    /// which is also how setup learns that the profile is signed in.
    ///
    /// STS is AWS's own service, so a profile with an S3 endpoint override (MinIO and the
    /// like) has no identity there. When STS fails for such a profile, its credentials
    /// exporting is the proof that it is signed in, and the identity is its name and endpoint.
    pub fn identity(&self, profile: &str) -> Result<String, AwsCliError> {
        match self.caller_arn(profile) {
            Err(error @ AwsCliError::Failed { .. }) => {
                let endpoint = self
                    .settings(profile)
                    .ok()
                    .and_then(|settings| settings.endpoint_url);
                let Some(endpoint) = endpoint else {
                    return Err(error);
                };
                // The label is kept with the Workspace, so it names the service by host and port
                // only: an endpoint may carry a user name and password, a path or a query.
                let Some(service) = service_name(&endpoint) else {
                    return Err(error);
                };
                self.credentials(profile)?;
                Ok(format!("{profile} on {service}"))
            }
            other => other,
        }
    }

    fn caller_arn(&self, profile: &str) -> Result<String, AwsCliError> {
        let stdout = self
            .checked(
                &[
                    "sts",
                    "get-caller-identity",
                    "--profile",
                    profile,
                    "--query",
                    "Arn",
                    "--output",
                    "text",
                ],
                self.timeout,
            )
            .map_err(sign_in_if_ended)?;
        non_empty(&stdout).ok_or(AwsCliError::Unreadable)
    }

    /// The names of the buckets the profile may list, or `None` when it may not
    /// (`AccessDenied`), so setup asks for the name instead. Any other failure is an error.
    pub fn buckets(&self, profile: &str) -> Result<Option<Vec<String>>, AwsCliError> {
        let args = [
            "s3api",
            "list-buckets",
            "--profile",
            profile,
            "--query",
            "Buckets[].Name",
            "--output",
            "json",
        ];
        let output = run(&self.program, &args, self.timeout)?;
        match output.code {
            Some(0) => {
                // An account without buckets has no `Buckets`, and the query prints `null`.
                let names: Option<Vec<String>> =
                    serde_json::from_str(&output.stdout).map_err(|_| AwsCliError::Unreadable)?;
                Ok(Some(names.unwrap_or_default()))
            }
            code if output.stderr.contains("AccessDenied") => {
                tracing::debug!(exit_code = ?code, "aws profile may not list buckets");
                Ok(None)
            }
            code => Err(sign_in_if_ended(failed(code, &output.stderr))),
        }
    }

    /// The profile's region and S3 endpoint. A service-specific endpoint (a `services`
    /// section) wins over `endpoint_url`, as in the AWS CLI itself. A CLI too old to read
    /// that section is an error when the profile has one.
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
            // option. The section may hold the S3 endpoint, and the profile's own
            // `endpoint_url` would then be the wrong one, so the profile is not guessed at.
            Some(252) if output.stderr.contains("Unknown options") => {
                tracing::debug!("aws cli cannot read a services section");
                Err(AwsCliError::ServicesNeedNewerCli {
                    found: format!("{}.{}", self.version.0, self.version.1),
                })
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
            if self.version < LOGIN_VERSION {
                return Err(AwsCliError::LoginNeedsNewerCli {
                    found: format!("{}.{}", self.version.0, self.version.1),
                });
            }
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
    /// The profile's region and endpoint, read once: they do not change with the session, and
    /// each read is a process of the CLI.
    settings: Mutex<Option<ProfileSettings>>,
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
            settings: Mutex::new(None),
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
        let settings = self.settings()?;
        let access = ProfileAccess {
            credentials,
            region: settings.region,
            endpoint_url: settings.endpoint_url,
        };
        *kept = Some(access.clone());
        Ok(access)
    }

    fn settings(&self) -> Result<ProfileSettings, AwsCliError> {
        let mut read = self.settings.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(settings) = read.as_ref() {
            return Ok(settings.clone());
        }
        let settings = self.cli.settings(&self.profile)?;
        *read = Some(settings.clone());
        Ok(settings)
    }

    /// Drops what is kept, such as after the person signs in again or the service refuses
    /// the credentials before their expiry.
    pub fn forget(&self) {
        *self.kept.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// Whether the profile has a sign-in command. When that cannot be told, assume it has,
    /// since a failure to read the profile says nothing against its session.
    pub fn can_sign_in(&self) -> bool {
        self.cli
            .sign_in_command(&self.profile)
            .map_or(true, |command| command.is_some())
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
        // The last is where AWS's own macOS and Linux installers put the program; they also
        // link it into /usr/local/bin, which a custom install location does not.
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/usr/local/aws-cli",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect()
    }
}

/// `2.19.5` -> `(2, 19)`.
/// The dotted version in `aws-cli/2.9.0`'s `2.9.0`, as the CLI wrote it.
fn version_text(text: &str) -> Option<String> {
    let end = text
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(text.len());
    let version = text[..end].trim_end_matches('.');
    (!version.is_empty()).then(|| version.to_owned())
}

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

/// A failure that means the session ended becomes [`AwsCliError::SignInNeeded`].
fn sign_in_if_ended(error: AwsCliError) -> AwsCliError {
    match error {
        AwsCliError::Failed { exit_code, message } if ended_session(exit_code, &message) => {
            AwsCliError::SignInNeeded { message }
        }
        other => other,
    }
}

/// The host and port of a service's endpoint, without any user info, path or query.
fn service_name(endpoint: &str) -> Option<String> {
    let url = url::Url::parse(endpoint).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
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
    let mut command = Command::new(program);
    command
        .args(args)
        // A pager would wait for a terminal.
        .env("AWS_PAGER", "")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Its own process group, so a timeout can end the helpers the program started too.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command.spawn().map_err(AwsCliError::Io)?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let started = Instant::now();
    let status = loop {
        match child.try_wait().map_err(AwsCliError::Io)? {
            Some(status) => break status,
            None if started.elapsed() >= timeout => {
                end_process_tree(&mut child);
                // The tree's end closes the pipes, so the readers finish at once. A helper that
                // left the group may still hold them; the readers are then left to end when it
                // does.
                let _ = stdout.recv_timeout(PIPE_GRACE);
                let _ = stderr.recv_timeout(PIPE_GRACE);
                return Err(AwsCliError::TimedOut);
            }
            None => thread::sleep(Duration::from_millis(10)),
        }
    };
    // A helper the program started may still hold the pipes; do not wait for it forever.
    let stdout = stdout.recv_timeout(PIPE_GRACE).unwrap_or_default();
    let stderr = stderr.recv_timeout(PIPE_GRACE).unwrap_or_default();
    if stdout.overflowed || stderr.overflowed {
        return Err(AwsCliError::OutputTooLarge);
    }
    Ok(Output {
        code: status.code(),
        stdout: stdout.text,
        stderr: stderr.text,
    })
}

/// Ends the program and the helpers it started (a `credential_process` command, for one),
/// which would otherwise keep the output pipes open and the readers blocked.
///
/// Unix: [`run`] put the program in its own process group, whose id is the program's pid, and
/// `kill` signals the whole group. `std` has no call for that, and the workspace forbids
/// `unsafe`, so the shell's `kill` does it. A helper that makes its own session or group
/// escapes this.
///
/// Windows: `taskkill /T` ends the program and its descendants, found through their parent
/// links. That has to run before the program itself ends, and a helper whose parent already
/// exited escapes it. A job object would be exact, but `std` has none and it needs `unsafe`.
fn end_process_tree(child: &mut Child) {
    let pid = child.id().to_string();
    #[cfg(unix)]
    let _ = Command::new("/bin/sh")
        .args(["-c", "kill -s KILL -- \"-$0\"", &pid])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: the desktop app has no console to show.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::os::windows::process::CommandExt::creation_flags(
            Command::new("taskkill").args(["/PID", &pid, "/T", "/F"]),
            CREATE_NO_WINDOW,
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    }
    // The program itself, in case the above could not run.
    let _ = child.kill();
    let _ = child.wait();
}

/// What one stream held, and whether it held more than [`OUTPUT_LIMIT`].
#[derive(Default)]
struct Drained {
    text: String,
    overflowed: bool,
}

/// Reads a stream to its end on another thread, keeping at most [`OUTPUT_LIMIT`] bytes. What
/// is past the limit is read and dropped, so the program is never held up by a full pipe and
/// memory stays bounded until the timeout ends it.
fn drain(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<Drained> {
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut overflowed = false;
        if let Some(mut pipe) = pipe {
            let mut chunk = [0_u8; 16 * 1024];
            while let Ok(read) = pipe.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                let room = OUTPUT_LIMIT - bytes.len();
                bytes.extend_from_slice(&chunk[..read.min(room)]);
                overflowed |= read > room;
            }
        }
        let _ = send.send(Drained {
            text: String::from_utf8_lossy(&bytes).into_owned(),
            overflowed,
        });
    });
    receive
}
