//! Detects the `ticketd` command-line tool so Settings can say whether agents can reach it.
//!
//! The executable is found by walking directories and run with structured
//! arguments; no shell command string ever includes a path or user input.
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const EXECUTABLE: &str = if cfg!(windows) {
    "ticketd.exe"
} else {
    "ticketd"
};
const RUN_TIMEOUT: Duration = Duration::from_secs(5);
/// How long to wait for output after a process exits. A background job started
/// by a shell's rc files can keep the pipe open long after the shell is done.
const OUTPUT_GRACE: Duration = Duration::from_millis(250);

/// What Settings shows. `found` is false when no executable is on any searched path.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CliStatus {
    pub found: bool,
    /// True when the executable was found on the PATH that agents and terminals
    /// use; false when only a common install folder has it.
    pub on_path: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub version_matches: Option<bool>,
    pub workspace_path: Option<String>,
    pub workspace_matches: Option<bool>,
    pub app_version: String,
    pub app_workspace_path: Option<String>,
    /// The usual user bin folder to copy the executable into.
    pub suggested_directory: String,
}

/// What `ticketd workspace` prints. Older executables lack the format fields.
#[derive(Deserialize)]
struct CliWorkspace {
    path: PathBuf,
}

fn suggested_directory() -> String {
    if cfg!(windows) {
        r"%LOCALAPPDATA%\Programs\ticketd-cli".into()
    } else {
        "~/.local/bin".into()
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Runs a command with a deadline and returns its stdout when it succeeds.
///
/// Output is read on its own thread so a chatty process cannot fill the pipe
/// and stall. The process is killed at the deadline. The reader is not waited
/// on indefinitely: a background job that inherited the pipe would hold it open.
fn run_with_timeout(mut command: Command, timeout: Duration) -> Option<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: release builds have no console to attach to.
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let collected = Arc::new(Mutex::new(Vec::new()));
    let reader = {
        let collected = Arc::clone(&collected);
        std::thread::spawn(move || {
            let mut chunk = [0_u8; 4096];
            while let Ok(read) = stdout.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                if let Ok(mut bytes) = collected.lock() {
                    bytes.extend_from_slice(&chunk[..read]);
                }
            }
        })
    };
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait().ok()? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let grace = Instant::now() + OUTPUT_GRACE;
    while !reader.is_finished() && Instant::now() < grace {
        std::thread::sleep(Duration::from_millis(10));
    }
    let bytes = collected.lock().ok()?.clone();
    status
        .success()
        .then(|| String::from_utf8_lossy(&bytes).trim().to_string())
}

/// Runs the executable with fixed arguments and returns trimmed stdout on success.
fn run_cli(executable: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new(executable);
    command.args(args);
    run_with_timeout(command, RUN_TIMEOUT)
}

fn same_path(left: &Path, right: &Path) -> bool {
    let normal = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    normal(left) == normal(right)
}

fn find_executable(directories: &[PathBuf]) -> Option<PathBuf> {
    directories
        .iter()
        .map(|directory| directory.join(EXECUTABLE))
        .find(|candidate| is_executable(candidate))
}

/// Looks for the executable on `search_path`, then in `fallback` folders, and
/// checks it against this app. A hit only in a fallback folder is reported as
/// not on the PATH, because a terminal or agent could not run it by name.
pub fn detect(
    search_path: &[PathBuf],
    fallback: &[PathBuf],
    app_version: &str,
    app_workspace: Option<&Path>,
) -> CliStatus {
    let mut status = CliStatus {
        found: false,
        on_path: false,
        path: None,
        version: None,
        version_matches: None,
        workspace_path: None,
        workspace_matches: None,
        app_version: app_version.to_string(),
        app_workspace_path: app_workspace.map(|path| path.display().to_string()),
        suggested_directory: suggested_directory(),
    };
    let (executable, on_path) = match find_executable(search_path) {
        Some(executable) => (executable, true),
        None => match find_executable(fallback) {
            Some(executable) => (executable, false),
            None => return status,
        },
    };
    status.found = true;
    status.on_path = on_path;
    status.path = Some(executable.display().to_string());
    // "ticketd 0.1.0" -> "0.1.0"
    status.version = run_cli(&executable, &["--version"])
        .and_then(|text| text.split_whitespace().last().map(str::to_string));
    status.version_matches = status.version.as_deref().map(|found| found == app_version);
    // A different version may print a different shape, or open the workspace
    // when asked; only a matching executable is asked where its workspace is.
    if status.version_matches == Some(false) {
        return status;
    }
    // A CLI built before the `workspace` command exists cannot confirm its workspace.
    let workspace = run_cli(&executable, &["workspace"])
        .and_then(|text| serde_json::from_str::<CliWorkspace>(&text).ok());
    status.workspace_path = workspace
        .as_ref()
        .map(|workspace| workspace.path.display().to_string());
    status.workspace_matches = workspace
        .zip(app_workspace)
        .map(|(workspace, expected)| same_path(&workspace.path, expected));
    status
}

/// Apps started from the Finder or Dock do not inherit the terminal PATH, so
/// ask the login shell for it. The shell command is a fixed string.
#[cfg(unix)]
fn ask_login_shell_for_path() -> Option<String> {
    const MARK: &str = "__ticketd_path__";
    let shell = std::env::var_os("SHELL")
        .filter(|shell| is_executable(Path::new(shell)))
        .unwrap_or_else(|| "/bin/sh".into());
    let mut command = Command::new(shell);
    command.args([
        "-l",
        "-i",
        "-c",
        "printf '__ticketd_path__%s__ticketd_path__' \"$PATH\"",
    ]);
    let output = run_with_timeout(command, Duration::from_secs(3))?;
    let start = output.find(MARK)? + MARK.len();
    let length = output[start..].find(MARK)?;
    Some(output[start..start + length].to_string())
}

#[cfg(not(unix))]
fn ask_login_shell_for_path() -> Option<String> {
    None
}

/// The login shell's PATH. Starting a login shell runs the user's rc files,
/// so it is asked once per run of the app, not on every check.
fn login_shell_path() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(ask_login_shell_for_path).as_deref()
}

fn common_install_directories() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let mut directories = Vec::new();
    if let Some(home) = home.as_deref().map(PathBuf::from) {
        directories.push(home.join(".local").join("bin"));
        directories.push(home.join("bin"));
        directories.push(home.join(".cargo").join("bin"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        directories.push(PathBuf::from(local).join("Programs").join("ticketd-cli"));
    }
    if cfg!(unix) {
        directories.push("/opt/homebrew/bin".into());
        directories.push("/usr/local/bin".into());
    }
    directories
}

/// The process PATH, then the login shell's PATH, without repeats.
fn path_directories() -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = Vec::new();
    let mut add = |paths: &OsStr| {
        for directory in std::env::split_paths(paths) {
            if !directory.as_os_str().is_empty() && !directories.contains(&directory) {
                directories.push(directory);
            }
        }
    };
    if let Some(path) = std::env::var_os("PATH") {
        add(&path);
    }
    if let Some(path) = login_shell_path() {
        add(OsStr::new(path));
    }
    directories
}

/// Checks whether this user's `ticketd` is installed and belongs with this app.
#[tauri::command]
pub async fn check_cli(app: tauri::AppHandle) -> Result<CliStatus, String> {
    let app_version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = ticketd_core::Workspace::open_default()
            .and_then(|workspace| workspace.workspace_info())
            .ok()
            .map(|info| PathBuf::from(info.path));
        detect(
            &path_directories(),
            &common_install_directories(),
            &app_version,
            workspace.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_not_found_when_no_directory_has_the_executable() {
        let empty = tempfile::tempdir().unwrap();
        let status = detect(&[empty.path().to_path_buf()], &[], "0.1.0", None);
        assert!(!status.found);
        assert!(!status.on_path);
        assert_eq!(status.path, None);
        assert_eq!(status.version_matches, None);
    }

    #[cfg(unix)]
    fn sh(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(unix)]
    #[test]
    fn a_process_that_outlives_the_deadline_is_killed() {
        let started = Instant::now();
        let output = run_with_timeout(sh("printf partial; sleep 30"), Duration::from_millis(300));
        assert_eq!(output, None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn a_background_job_holding_the_pipe_does_not_block_the_result() {
        let started = Instant::now();
        let output = run_with_timeout(sh("printf hello; sleep 5 &"), Duration::from_secs(3));
        assert_eq!(output.as_deref(), Some("hello"));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[cfg(unix)]
    #[test]
    fn output_beyond_one_pipe_buffer_is_drained() {
        let output = run_with_timeout(
            sh("head -c 300000 /dev/zero | tr '\\0' x"),
            Duration::from_secs(5),
        );
        assert_eq!(output.map(|text| text.len()), Some(300_000));
    }

    /// One test, because writing and then executing scripts from parallel tests can
    /// race with another thread's fork ("text file busy").
    #[cfg(unix)]
    #[test]
    fn reports_version_workspace_and_path_membership_distinctly() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join(EXECUTABLE);
        let install = |version: &str, workspace: &str| {
            std::fs::write(
                &script,
                format!(
                    "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'ticketd {version}' ;;\n  workspace) echo '{{\"path\":\"{workspace}\",\"format_version\":19,\"supported_format_version\":20}}' ;;\n  *) exit 2 ;;\nesac\n"
                ),
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let dirs = [directory.path().to_path_buf()];
        let app_workspace = Path::new("/data/app/workspace.sqlite3");

        install("0.1.0", "/data/app/workspace.sqlite3");
        let status = detect(&dirs, &[], "0.1.0", Some(app_workspace));
        assert!(status.found);
        assert!(status.on_path);
        assert_eq!(status.path, Some(script.display().to_string()));
        assert_eq!(status.version.as_deref(), Some("0.1.0"));
        assert_eq!(status.version_matches, Some(true));
        assert_eq!(status.workspace_matches, Some(true));

        // Only in a fallback folder: found, but not runnable by name.
        let elsewhere = tempfile::tempdir().unwrap();
        let status = detect(
            &[elsewhere.path().to_path_buf()],
            &dirs,
            "0.1.0",
            Some(app_workspace),
        );
        assert!(status.found);
        assert!(!status.on_path);

        // A different version is not asked about its workspace.
        install("0.0.9", "/data/app/workspace.sqlite3");
        let status = detect(&dirs, &[], "0.1.0", Some(app_workspace));
        assert_eq!(status.version_matches, Some(false));
        assert_eq!(status.workspace_matches, None);
        assert_eq!(status.workspace_path, None);

        install("0.1.0", "/data/other/workspace.sqlite3");
        let status = detect(&dirs, &[], "0.1.0", Some(app_workspace));
        assert_eq!(status.version_matches, Some(true));
        assert_eq!(status.workspace_matches, Some(false));
        assert_eq!(
            status.workspace_path.as_deref(),
            Some("/data/other/workspace.sqlite3")
        );
    }
}
