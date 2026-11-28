//! Read GitHub through the user's CLI. Raw process output stays at this seam.

use std::{collections::BTreeMap, io, process::Stdio, time::Duration};

use tokio::{io::AsyncReadExt, process::Command};

use super::{SourceError, classify, missing_credential, transport::HttpResponse};

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

type Runner = dyn Fn(&[&str]) -> Result<Output, SourceError> + Send + Sync;

pub(super) struct GhApi(Box<Runner>);

impl GhApi {
    pub(super) fn new(
        run: impl Fn(&[&str]) -> Result<Output, SourceError> + Send + Sync + 'static,
    ) -> Self {
        Self(Box::new(run))
    }

    pub(super) fn system() -> Self {
        Self::new(run)
    }

    pub(super) fn get(
        &self,
        host: &str,
        endpoint: &str,
        subject: &str,
    ) -> Result<HttpResponse, SourceError> {
        let output = (self.0)(&["api", "--hostname", host, "--include", endpoint])?;
        if let Some(response) = parse_response(output.stdout)
            && (output.success || response.status >= 300)
        {
            return classify(response, subject);
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
        Err(SourceError::Unavailable(
            "could not reach GitHub through the GitHub CLI".into(),
        ))
    }
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

fn run(args: &[&str]) -> Result<Output, SourceError> {
    // The connector is synchronous, including when called by a Tokio worker.
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("github-cli".into())
            .spawn_scoped(scope, || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(process_error)?;
                runtime.block_on(run_with_timeout(&PROGRAMS, args, TIMEOUT))
            })
            .map_err(process_error)?
            .join()
            .map_err(|_| {
                SourceError::Unavailable("the GitHub CLI worker stopped unexpectedly".into())
            })?
    })
}

async fn run_with_timeout(
    programs: &[&str],
    args: &[&str],
    timeout: Duration,
) -> Result<Output, SourceError> {
    for program in programs {
        let mut command = Command::new(program);
        command
            .args(args)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_PAGER", "")
            .env("GH_TELEMETRY", "false")
            .env("NO_COLOR", "1")
            .env_remove("CLICOLOR_FORCE")
            .env_remove("GH_DEBUG")
            .env_remove("GH_FORCE_TTY")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(windows::Win32::System::Threading::CREATE_NO_WINDOW.0);
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
        let output = tokio::time::timeout(timeout, async {
            tokio::try_join!(
                child.wait(),
                read_output(stdout.take(BODY_LIMIT + 1), BODY_LIMIT),
                read_output(stderr.take(STDERR_LIMIT + 1), STDERR_LIMIT)
            )
        })
        .await;
        let error = match output {
            Ok(Ok((status, stdout, stderr))) => {
                return Ok(Output {
                    success: status.success(),
                    stdout,
                    stderr,
                });
            }
            Ok(Err(error)) => process_error(error),
            Err(_) => SourceError::Unavailable("the GitHub CLI request timed out".into()),
        };
        let _ = child.kill().await;
        return Err(error);
    }
    Err(SourceError::Unavailable(
        "the GitHub CLI (gh) was not found. Install it to use GitHub".into(),
    ))
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
            Duration::from_millis(20),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.to_string(), "the GitHub CLI request timed out");
    }
}
