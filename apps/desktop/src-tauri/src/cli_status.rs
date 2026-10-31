//! Detects the `ticketd` command-line tool so Settings can say whether agents can reach it.
//!
//! The executable is found by walking directories and run with structured
//! arguments; no shell command string ever includes a path or user input.
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const EXECUTABLE: &str = if cfg!(windows) {
    "ticketd.exe"
} else {
    "ticketd"
};
const RUN_TIMEOUT: Duration = Duration::from_secs(5);

/// What Settings shows. `found` is false when no executable is on any searched path.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CliStatus {
    pub found: bool,
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

/// Runs the executable with fixed arguments and returns trimmed stdout on success.
fn run_cli(executable: &Path, args: &[&str]) -> Option<String> {
    let mut child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + RUN_TIMEOUT;
    loop {
        match child.try_wait().ok()? {
            Some(_) => break,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let output = child.wait_with_output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn same_path(left: &Path, right: &Path) -> bool {
    let normal = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    normal(left) == normal(right)
}

/// Looks for the executable in `directories`, in order, and checks it against this app.
pub fn detect(
    directories: &[PathBuf],
    app_version: &str,
    app_workspace: Option<&Path>,
) -> CliStatus {
    let mut status = CliStatus {
        found: false,
        path: None,
        version: None,
        version_matches: None,
        workspace_path: None,
        workspace_matches: None,
        app_version: app_version.to_string(),
        app_workspace_path: app_workspace.map(|path| path.display().to_string()),
        suggested_directory: suggested_directory(),
    };
    let Some(executable) = directories
        .iter()
        .map(|directory| directory.join(EXECUTABLE))
        .find(|candidate| is_executable(candidate))
    else {
        return status;
    };
    status.found = true;
    status.path = Some(executable.display().to_string());
    // "ticketd 0.1.0" -> "0.1.0"
    status.version = run_cli(&executable, &["--version"])
        .and_then(|text| text.split_whitespace().last().map(str::to_string));
    status.version_matches = status.version.as_deref().map(|found| found == app_version);
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
fn login_shell_path() -> Option<String> {
    const MARK: &str = "__ticketd_path__";
    let shell = std::env::var_os("SHELL")
        .filter(|shell| is_executable(Path::new(shell)))
        .unwrap_or_else(|| "/bin/sh".into());
    let mut child = Command::new(shell)
        .args([
            "-l",
            "-i",
            "-c",
            "printf '__ticketd_path__%s__ticketd_path__' \"$PATH\"",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while child.try_wait().ok()?.is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = String::from_utf8_lossy(&child.wait_with_output().ok()?.stdout).into_owned();
    let start = output.find(MARK)? + MARK.len();
    let length = output[start..].find(MARK)?;
    Some(output[start..start + length].to_string())
}

#[cfg(not(unix))]
fn login_shell_path() -> Option<String> {
    None
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

/// Process PATH first, then the login shell's PATH, then common install folders.
fn search_directories() -> Vec<PathBuf> {
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
        add(OsStr::new(&path));
    }
    for directory in common_install_directories() {
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    directories
}

/// Checks whether this user's `ticketd` is installed and belongs with this app.
#[tauri::command]
pub async fn check_cli() -> Result<CliStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let workspace = ticketd_core::default_workspace_path().ok();
        detect(
            &search_directories(),
            env!("CARGO_PKG_VERSION"),
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
        let status = detect(&[empty.path().to_path_buf()], "0.1.0", None);
        assert!(!status.found);
        assert_eq!(status.path, None);
        assert_eq!(status.version_matches, None);
    }

    /// One test, because writing and then executing scripts from parallel tests can
    /// race with another thread's fork ("text file busy").
    #[cfg(unix)]
    #[test]
    fn reports_version_and_workspace_matches_distinctly() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join(EXECUTABLE);
        let install = |version: &str, workspace: &str| {
            std::fs::write(
                &script,
                format!(
                    "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'ticketd {version}' ;;\n  workspace) echo '{{\"path\":\"{workspace}\",\"format_version\":19}}' ;;\n  *) exit 2 ;;\nesac\n"
                ),
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let dirs = [directory.path().to_path_buf()];
        let app_workspace = Path::new("/data/app/workspace.sqlite3");

        install("0.1.0", "/data/app/workspace.sqlite3");
        let status = detect(&dirs, "0.1.0", Some(app_workspace));
        assert!(status.found);
        assert_eq!(status.path, Some(script.display().to_string()));
        assert_eq!(status.version.as_deref(), Some("0.1.0"));
        assert_eq!(status.version_matches, Some(true));
        assert_eq!(status.workspace_matches, Some(true));

        install("0.0.9", "/data/app/workspace.sqlite3");
        let status = detect(&dirs, "0.1.0", Some(app_workspace));
        assert_eq!(status.version_matches, Some(false));
        assert_eq!(status.workspace_matches, Some(true));

        install("0.1.0", "/data/other/workspace.sqlite3");
        let status = detect(&dirs, "0.1.0", Some(app_workspace));
        assert_eq!(status.version_matches, Some(true));
        assert_eq!(status.workspace_matches, Some(false));
        assert_eq!(
            status.workspace_path.as_deref(),
            Some("/data/other/workspace.sqlite3")
        );
    }
}
