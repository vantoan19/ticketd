//! Finds the independent `ticketd` command-line tool and checks that it belongs with
//! this app, for Settings and for the context a hosted agent is given.
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

/// Reports the version of a ticketd executable without opening any workspace.
pub fn version(executable: &Path) -> Option<String> {
    run_cli(executable, &["--version"])
        .and_then(|text| text.strip_prefix("ticketd ").map(str::to_string))
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
    status.version = version(&executable);
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

/// Variables an app started from the Finder or Dock does not inherit from the
/// user's shell profile, read from the login shell instead: PATH to find
/// `ticketd`, and the harness config folders that decide where skills go.
#[cfg(any(unix, test))]
const LOGIN_SHELL_VARIABLES: [&str; 3] = ["PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];

/// The fixed script that prints each variable between markers naming it.
/// `printenv` keeps the shell from expanding an unset variable, which fails
/// under `set -u` in the user's rc files, and `|| true` keeps `set -e` going.
/// Unlike `${NAME-}`, both work in fish too.
#[cfg(any(unix, test))]
fn login_shell_script() -> String {
    LOGIN_SHELL_VARIABLES
        .iter()
        .map(|name| {
            let mark = format!("__ticketd_{name}__");
            format!("printf '{mark}'; printenv {name} || true; printf '{mark}'")
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Reads the variables the script printed; rc-file noise around the markers
/// is ignored, and a variable that is unset or empty is left out.
#[cfg(any(unix, test))]
fn parse_login_shell_output(output: &str) -> Vec<(&'static str, String)> {
    LOGIN_SHELL_VARIABLES
        .iter()
        .filter_map(|&name| {
            let mark = format!("__ticketd_{name}__");
            let start = output.find(&mark)? + mark.len();
            let length = output[start..].find(&mark)?;
            let value = &output[start..start + length];
            // printenv ends the value with a newline.
            let value = value.strip_suffix('\n').unwrap_or(value);
            (!value.is_empty()).then(|| (name, value.to_string()))
        })
        .collect()
}

/// The shell command is a fixed string; no path or user input is part of it.
#[cfg(unix)]
fn ask_login_shell() -> Vec<(&'static str, String)> {
    let shell = std::env::var_os("SHELL")
        .filter(|shell| is_executable(Path::new(shell)))
        .unwrap_or_else(|| "/bin/sh".into());
    let mut command = Command::new(shell);
    command.args(["-l", "-i", "-c", &login_shell_script()]);
    run_with_timeout(command, Duration::from_secs(3))
        .map(|output| parse_login_shell_output(&output))
        .unwrap_or_default()
}

#[cfg(not(unix))]
fn ask_login_shell() -> Vec<(&'static str, String)> {
    Vec::new()
}

/// One of `LOGIN_SHELL_VARIABLES` as the user's login shell exports it. Starting a
/// login shell runs the user's rc files, so it is asked once per run of the
/// app, not on every check. Blocking the first time on Unix.
pub fn login_shell_variable(name: &str) -> Option<&'static str> {
    static VARIABLES: OnceLock<Vec<(&'static str, String)>> = OnceLock::new();
    VARIABLES
        .get_or_init(ask_login_shell)
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, value)| value.as_str())
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

/// Where to look when PATH has no `ticketd`: the app's own folder first, where a
/// development build (`target/debug`) puts the CLI beside the desktop executable and
/// an installation may ship it, then the usual install folders. The path is absolute,
/// so a hosted agent runs it without PATH.
fn fallback_directories(app_executable: Option<&Path>) -> Vec<PathBuf> {
    app_executable
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .into_iter()
        .chain(common_install_directories())
        .collect()
}

/// The process PATH, then the login shell's PATH, without repeats.
fn path_directories(paths: &[&OsStr]) -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = Vec::new();
    for path in paths {
        for directory in std::env::split_paths(path) {
            if !directory.as_os_str().is_empty() && !directories.contains(&directory) {
                directories.push(directory);
            }
        }
    }
    directories
}

fn process_then_login_path() -> Vec<PathBuf> {
    path_directories(&[
        &std::env::var_os("PATH").unwrap_or_default(),
        OsStr::new(login_shell_variable("PATH").unwrap_or_default()),
    ])
}

/// The last terminal PATH an explicit recheck read, so later checks see it too.
static TERMINAL_PATH: Mutex<Option<String>> = Mutex::new(None);

fn remember_terminal_path(path: &str) {
    if let Ok(mut latest) = TERMINAL_PATH.lock() {
        *latest = Some(path.to_string());
    }
}

#[cfg(not(windows))]
fn cached_terminal_path() -> Option<String> {
    TERMINAL_PATH
        .lock()
        .ok()
        .and_then(|latest| latest.clone())
        .or_else(|| login_shell_variable("PATH").map(str::to_string))
}

#[cfg(not(windows))]
fn read_terminal_path() -> Option<String> {
    let path = ask_login_shell()
        .into_iter()
        .find(|(name, _)| *name == "PATH")
        .map(|(_, path)| path)?;
    remember_terminal_path(&path);
    Some(path)
}

#[cfg(windows)]
fn cached_terminal_path() -> Option<String> {
    TERMINAL_PATH.lock().ok()?.clone()
}

#[cfg(windows)]
fn read_terminal_path() -> Option<String> {
    // Registry.GetValue expands REG_EXPAND_SZ entries. Read both scopes in the
    // order Windows builds PATH for a fresh terminal and preserve non-ASCII paths.
    let powershell = PathBuf::from(std::env::var_os("SystemRoot")?)
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let mut command = Command::new(powershell);
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        r"$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$machine = [Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Environment', 'Path', '')
$user = [Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\Environment', 'Path', '')
[Console]::Write((@($machine, $user) -join ';'))",
    ]);
    let path = run_with_timeout(command, RUN_TIMEOUT)?;
    remember_terminal_path(&path);
    Some(path)
}

fn terminal_search_path(
    process_path: &OsStr,
    refresh_path: bool,
    cached: impl FnOnce() -> Option<String>,
    fresh: impl FnOnce() -> Option<String>,
) -> Vec<PathBuf> {
    // A failed refresh keeps the last PATH that was read successfully.
    let terminal_path = if refresh_path {
        fresh().or_else(cached)
    } else {
        cached()
    };
    path_directories(&[terminal_path.as_deref().map_or(process_path, OsStr::new)])
}

/// Settings reports what a new terminal resolves. An explicit recheck can
/// see a PATH edit made after the app started. The terminal PATH replaces the
/// launch PATH when it can be read.
pub fn locate_for_terminals(
    app_executable: Option<&Path>,
    app_version: &str,
    app_workspace: Option<&Path>,
    refresh_path: bool,
) -> CliStatus {
    let process_path = std::env::var_os("PATH").unwrap_or_default();
    let paths = terminal_search_path(
        &process_path,
        refresh_path,
        cached_terminal_path,
        read_terminal_path,
    );
    detect(
        &paths,
        &fallback_directories(app_executable),
        app_version,
        app_workspace,
    )
}

/// Finds this user's `ticketd` and checks it against the app's version and workspace.
/// Blocking: it runs the executable, and once per process a login shell.
pub fn locate(app_version: &str, app_workspace: Option<&Path>) -> CliStatus {
    let app = std::env::current_exe().ok();
    detect(
        &process_then_login_path(),
        &fallback_directories(app.as_deref()),
        app_version,
        app_workspace,
    )
}

/// The executable `locate` reports, found the same way but without running it.
/// Blocking only the first time on Unix, where it asks the login shell for its PATH.
pub fn executable() -> Option<PathBuf> {
    let app = std::env::current_exe().ok();
    find_executable(&process_then_login_path())
        .or_else(|| find_executable(&fallback_directories(app.as_deref())))
}

impl CliStatus {
    /// Why a hosted agent cannot be pointed at this executable, in words for the user.
    /// `None` means it runs, matches the app's version, and is not known to use
    /// another workspace.
    pub fn problem(&self) -> Option<String> {
        if !self.found {
            return Some("the ticketd command-line tool is not installed".into());
        }
        match (&self.version, self.version_matches) {
            (Some(version), Some(false)) => {
                return Some(format!(
                    "the installed ticketd command-line tool is version {version}, but this app is version {}",
                    self.app_version
                ));
            }
            (Some(_), _) => {}
            (None, _) => return Some("the ticketd command-line tool could not be run".into()),
        }
        if self.workspace_matches == Some(false) {
            return Some(format!(
                "the ticketd command-line tool uses another workspace ({})",
                self.workspace_path.as_deref().unwrap_or("unknown")
            ));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_path_recheck_uses_the_current_terminal_path() {
        let launch_path = OsStr::new("launch-bin");
        let cached = || Some("cached-bin".into());
        let fresh = || Some("installed-bin".into());
        assert_eq!(
            terminal_search_path(launch_path, true, cached, fresh),
            [PathBuf::from("installed-bin")]
        );
        assert_eq!(
            terminal_search_path(launch_path, false, cached, fresh),
            [PathBuf::from("cached-bin")]
        );
        assert_eq!(
            terminal_search_path(launch_path, true, cached, || Some(String::new())),
            Vec::<PathBuf>::new()
        );
        assert_eq!(
            terminal_search_path(launch_path, true, cached, || None),
            [PathBuf::from("cached-bin")],
            "a failed refresh keeps the last PATH that was read"
        );
        assert_eq!(
            terminal_search_path(launch_path, true, || None, || None),
            [PathBuf::from("launch-bin")]
        );
    }

    #[test]
    fn a_refreshed_terminal_path_is_what_later_checks_use() {
        remember_terminal_path("installed-bin");
        assert_eq!(cached_terminal_path().as_deref(), Some("installed-bin"));
    }

    #[test]
    fn the_folder_of_the_app_itself_is_searched_before_the_common_install_folders() {
        let app = Path::new("/work/target/debug").join("ticketd-desktop");
        let folders = fallback_directories(Some(&app));
        assert_eq!(folders.first(), Some(&PathBuf::from("/work/target/debug")));
        assert_eq!(&folders[1..], common_install_directories().as_slice());
        assert_eq!(fallback_directories(None), common_install_directories());
    }

    #[test]
    fn reports_not_found_when_no_directory_has_the_executable() {
        let empty = tempfile::tempdir().unwrap();
        let status = detect(&[empty.path().to_path_buf()], &[], "0.1.0", None);
        assert!(!status.found);
        assert!(!status.on_path);
        assert_eq!(status.path, None);
        assert_eq!(status.version_matches, None);
    }

    #[test]
    fn login_shell_variables_are_read_between_their_markers() {
        let output = "rc noise __ticketd_PATH__/bin:/usr/bin\n__ticketd_PATH__\
                      __ticketd_CLAUDE_CONFIG_DIR__/profile dir\n__ticketd_CLAUDE_CONFIG_DIR__\
                      __ticketd_CODEX_HOME____ticketd_CODEX_HOME__ more noise";
        assert_eq!(
            parse_login_shell_output(output),
            [
                ("PATH", "/bin:/usr/bin".to_string()),
                ("CLAUDE_CONFIG_DIR", "/profile dir".to_string()),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_login_shell_script_reads_every_variable_even_when_rc_files_set_eu() {
        // The rc files run first in the same shell; `set -eu` stands in for them.
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", &format!("set -eu; {}", login_shell_script())])
            .env("CLAUDE_CONFIG_DIR", "/profile")
            .env_remove("CODEX_HOME");
        let output = run_with_timeout(command, Duration::from_secs(5)).unwrap();
        let variables = parse_login_shell_output(&output);
        assert!(variables.contains(&("CLAUDE_CONFIG_DIR", "/profile".to_string())));
        assert!(variables.iter().any(|(name, _)| *name == "PATH"));
        assert!(!variables.iter().any(|(name, _)| *name == "CODEX_HOME"));
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
