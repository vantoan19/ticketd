//! Checks and installs the CLI that ships with the desktop app.
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};
use ticketd_chat_host::cli::{self, CliStatus};

const CLI_EXE: &str = if cfg!(windows) {
    "ticketd.exe"
} else {
    "ticketd"
};
static PATH_CHANGES: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
pub struct CommandLineStatus {
    #[serde(flatten)]
    status: CliStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundled: Option<BundledStatus>,
}

#[derive(Serialize)]
struct BundledStatus {
    platform: &'static str,
    installed: bool,
    needs_repair: bool,
    in_the_way: Option<OtherCli>,
}

/// A `ticketd` that comes first on the PATH but is not this app's copy and does
/// not match it (older, newer, or reading another Workspace).
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct OtherCli {
    path: PathBuf,
    version: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Installed,
    /// The person declined the administrator password; nothing changed.
    /// `directory` is the folder that needs no password.
    // Only the macOS administrator prompt can be declined.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Declined,
}

#[derive(Debug, Serialize)]
pub struct CliInstallation {
    outcome: Outcome,
    directory: PathBuf,
    next_step: Option<&'static str>,
}

fn installed(directory: &Path, next_step: Option<&'static str>) -> CliInstallation {
    CliInstallation {
        outcome: Outcome::Installed,
        directory: directory.to_path_buf(),
        next_step,
    }
}

fn bundled_cli(desktop: &Path) -> Option<PathBuf> {
    let cli = desktop.with_file_name(CLI_EXE);
    #[cfg(target_os = "macos")]
    if !is_macos_bundle_cli(&cli) {
        return None;
    }
    cli.is_file().then_some(cli)
}

fn same_executable(candidate: &Path, bundled: &Path) -> bool {
    fs::canonicalize(candidate)
        .ok()
        .zip(fs::canonicalize(bundled).ok())
        .is_some_and(|(candidate, bundled)| candidate == bundled)
}

/// The copy the person's terminals run when it is not this app's own and does
/// not match it. Replacing it is the one fix.
fn other_cli(status: &CliStatus, bundled: &Path) -> Option<OtherCli> {
    let path = PathBuf::from(status.path.as_ref()?);
    if !status.on_path
        || !path.is_absolute()
        || same_executable(&path, bundled)
        || (status.version_matches == Some(true) && status.workspace_matches == Some(true))
    {
        return None;
    }
    Some(OtherCli {
        path,
        version: status.version.clone(),
    })
}

fn current_status(desktop: Option<&Path>, version: &str, refresh_path: bool) -> CliStatus {
    let workspace = crate::open_workspace()
        .and_then(|workspace| workspace.workspace_info())
        .ok()
        .map(|info| PathBuf::from(info.path));
    cli::locate_for_terminals(desktop, version, workspace.as_deref(), refresh_path)
}

/// Checks whether this user's `ticketd` is installed and belongs with this app.
#[tauri::command]
pub async fn check_cli(
    app: tauri::AppHandle,
    refresh_path: Option<bool>,
) -> Result<CommandLineStatus, String> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let desktop = std::env::current_exe().ok();
        let status = current_status(desktop.as_deref(), &version, refresh_path.unwrap_or(false));
        let bundled = desktop
            .as_deref()
            .and_then(bundled_cli)
            .map(|cli| BundledStatus {
                platform: std::env::consts::OS,
                installed: status.on_path
                    && status.version_matches == Some(true)
                    && status
                        .path
                        .as_deref()
                        .is_some_and(|path| same_executable(Path::new(path), &cli)),
                in_the_way: other_cli(&status, &cli),
                needs_repair: has_broken_link(),
            });
        CommandLineStatus { status, bundled }
    })
    .await
    .map_err(|error| error.to_string())
}

fn with_path_change<T>(change: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
    let _guard = PATH_CHANGES.lock().map_err(|err| err.to_string())?;
    let desktop = std::env::current_exe().map_err(|err| err.to_string())?;
    change(&desktop)
}

/// The one fix: puts this app's `ticketd` where terminals find it and removes
/// `other`, the copy in the way. On macOS that is one administrator prompt.
#[tauri::command]
pub async fn install_cli(
    app: tauri::AppHandle,
    other: Option<OtherCli>,
) -> Result<CliInstallation, String> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        with_path_change(|desktop| {
            let bundled = checked_bundled_cli(desktop, &version)?;
            if let Some(expected) = &other {
                let status = current_status(Some(desktop), &version, true);
                if other_cli(&status, &bundled).as_ref() != Some(expected) {
                    return Err(
                        "The first ticketd on your PATH changed. Check again before continuing."
                            .into(),
                    );
                }
            }
            install(&bundled, other.as_ref()).map_err(|err| err.to_string())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The folder that needs no password, offered after the person declines it.
#[tauri::command]
pub async fn install_cli_in_user_bin(app: tauri::AppHandle) -> Result<CliInstallation, String> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        with_path_change(|desktop| {
            let bundled = checked_bundled_cli(desktop, &version)?;
            install_in_user_bin(&bundled).map_err(|err| err.to_string())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn checked_bundled_cli(desktop: &Path, version: &str) -> Result<PathBuf, String> {
    let bundled = bundled_cli(desktop).ok_or("This app has no bundled command-line tool.")?;
    if cli::version(&bundled).as_deref() != Some(version) {
        return Err("The bundled CLI does not match this app's version. Reinstall the app.".into());
    }
    Ok(bundled)
}

/// Runs `script` with `sh` after the system's administrator prompt. `Ok(false)`
/// when the person cancels the prompt.
#[cfg(target_os = "macos")]
fn run_as_admin(script: &str, args: &[&std::ffi::OsStr]) -> io::Result<bool> {
    const APPLESCRIPT: &str = r#"on run args
    set commandLine to "/bin/sh -c " & quoted form of (item 1 of args) & " ticketd"
    repeat with argument in items 2 thru -1 of args
        set commandLine to commandLine & " " & quoted form of (contents of argument)
    end repeat
    try
        do shell script commandLine with administrator privileges
        return "done"
    on error messageText number errorCode
        if errorCode is -128 then return "declined"
        error messageText number errorCode
    end try
end run"#;
    let output = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", APPLESCRIPT, "--", script])
        .args(args)
        .output()?;
    match (output.status.success(), output.stdout.as_slice()) {
        (true, b"done\n") => Ok(true),
        (true, b"declined\n") => Ok(false),
        _ => Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        )),
    }
}

#[cfg(target_os = "macos")]
fn is_macos_bundle_cli(cli: &Path) -> bool {
    cli.is_absolute()
        && cli.ends_with("Contents/MacOS/ticketd")
        && cli
            .ancestors()
            .nth(3)
            .and_then(Path::extension)
            .is_some_and(|ext| ext == "app")
}

#[cfg(target_os = "macos")]
fn has_broken_link() -> bool {
    let local = std::env::home_dir().map(|home| home.join(".local/bin"));
    [Some(PathBuf::from("/usr/local/bin")), local]
        .into_iter()
        .flatten()
        .any(|dir| stale_link(&dir.join(CLI_EXE)).is_ok_and(|link| link.is_some()))
}

#[cfg(not(target_os = "macos"))]
fn has_broken_link() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn install(bundled: &Path, other: Option<&OtherCli>) -> io::Result<CliInstallation> {
    let home =
        std::env::home_dir().ok_or_else(|| io::Error::other("The home folder is unavailable."))?;
    install_mac(
        bundled,
        Path::new("/usr/local/bin"),
        &home.join(".local/bin"),
        other,
        run_as_admin,
    )
}

#[cfg(target_os = "macos")]
fn install_in_user_bin(bundled: &Path) -> io::Result<CliInstallation> {
    let home =
        std::env::home_dir().ok_or_else(|| io::Error::other("The home folder is unavailable."))?;
    link_in_user_bin(bundled, &home.join(".local/bin"))
}

/// What the one administrator prompt runs: removes the copy in the way (`$4`,
/// only if it is still the file identified as `$5`, device:inode, when it was
/// checked), then, when `$1` is set, links it at `$2`. `$3` is the broken link
/// of an app that moved, which the new link replaces.
#[cfg(target_os = "macos")]
const FIX_SCRIPT: &str = r#"
    if [ -n "$4" ]; then
        [ "$(/usr/bin/stat -f %d:%i "$4")" = "$5" ] && /bin/rm -- "$4" || exit 1
    fi
    if [ -n "$1" ]; then
        /bin/mkdir -p "$(/usr/bin/dirname "$2")" || exit
        if [ -n "$3" ]; then
            [ -L "$2" ] && [ "$(/usr/bin/readlink "$2")" = "$3" ] &&
            /bin/rm "$2" || exit 1
        fi
        [ ! -e "$2" ] && [ ! -L "$2" ] && /bin/ln -sh "$1" "$2"
    fi
"#;

/// Links this app's copy at `system` and removes `other`, in one administrator
/// prompt (`admin` runs a script and says whether the person approved it).
/// Declining the prompt changes nothing.
#[cfg(target_os = "macos")]
fn install_mac(
    bundled: &Path,
    system: &Path,
    local: &Path,
    other: Option<&OtherCli>,
    admin: impl FnOnce(&str, &[&std::ffi::OsStr]) -> io::Result<bool>,
) -> io::Result<CliInstallation> {
    use std::os::unix::fs::MetadataExt;
    let system_link = system.join(CLI_EXE);
    // A copy already gone needs no removal.
    let other = other.filter(|other| fs::symlink_metadata(&other.path).is_ok());
    if let Some(other) = other
        && is_macos_bundle_cli(&other.path)
    {
        return Err(io::Error::other(format!(
            "{} belongs to another copy of the app. Remove that app, then try again.",
            ticketd_diagnostics::display_path(&other.path)
        )));
    }
    let link_needed = !same_executable(&system_link, bundled);
    let previous = match other {
        // The prompt removes it first, so it is not "already there".
        Some(other) if other.path == system_link => None,
        _ if link_needed => stale_link(&system_link)?,
        _ => None,
    };
    if !link_needed && other.is_none() {
        return Ok(installed(system, None));
    }
    let identity = match other {
        Some(other) => {
            let metadata = fs::symlink_metadata(&other.path)?;
            format!("{}:{}", metadata.dev(), metadata.ino())
        }
        None => String::new(),
    };
    let empty = Path::new("");
    let approved = admin(
        FIX_SCRIPT,
        &[
            if link_needed { bundled } else { empty }.as_os_str(),
            system_link.as_os_str(),
            previous.as_deref().unwrap_or(empty).as_os_str(),
            other
                .map_or(empty, |other| other.path.as_path())
                .as_os_str(),
            identity.as_ref(),
        ],
    )
    .map_err(|error| {
        io::Error::other(format!(
            "Could not update ticketd in {}: {error}",
            ticketd_diagnostics::display_path(system)
        ))
    })?;
    Ok(if approved {
        installed(system, None)
    } else {
        CliInstallation {
            outcome: Outcome::Declined,
            directory: local.to_path_buf(),
            next_step: None,
        }
    })
}

/// A no-clobber link in a folder that needs no password.
#[cfg(target_os = "macos")]
fn link_in_user_bin(bundled: &Path, local: &Path) -> io::Result<CliInstallation> {
    let local_link = local.join(CLI_EXE);
    if !same_executable(&local_link, bundled) {
        fs::create_dir_all(local)?;
        if let Some(previous) = stale_link(&local_link)?
            && fs::read_link(&local_link)? == previous
        {
            fs::remove_file(&local_link)?;
        }
        std::os::unix::fs::symlink(bundled, &local_link)?;
    }
    Ok(installed(local, Some("add_to_path")))
}

#[cfg(target_os = "macos")]
fn stale_link(link: &Path) -> io::Result<Option<PathBuf>> {
    match fs::symlink_metadata(link) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
        Ok(metadata) if metadata.is_symlink() => {
            let target = fs::read_link(link)?;
            if is_macos_bundle_cli(&target)
                && fs::metadata(&target).is_err_and(|err| err.kind() == io::ErrorKind::NotFound)
            {
                Ok(Some(target))
            } else {
                Err(existing_cli(link))
            }
        }
        Ok(_) => Err(existing_cli(link)),
    }
}

#[cfg(target_os = "macos")]
fn existing_cli(link: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!(
            "{} already exists. Move it or remove the older copy, then try again.",
            ticketd_diagnostics::display_path(link)
        ),
    )
}

#[cfg(windows)]
const WINDOWS_USER_PATH_SCRIPT: &str = include_str!("cli_user_path.ps1");

#[cfg(windows)]
fn windows_path_command(script: &str, directory: &Path) -> io::Result<std::process::Command> {
    use std::{os::windows::process::CommandExt, process::Command};

    let system_root = std::env::var_os("SystemRoot")
        .ok_or_else(|| io::Error::other("Windows SystemRoot is unavailable."))?;
    let powershell =
        PathBuf::from(system_root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let mut command = Command::new(powershell);
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("TICKETD_CLI_DIRECTORY", directory)
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    Ok(command)
}

/// Removes the copy in the way. No administrator rights are involved off macOS.
#[cfg(not(target_os = "macos"))]
fn remove_other(other: &OtherCli) -> io::Result<()> {
    fs::remove_file(&other.path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "Couldn't remove {}: {error}",
                ticketd_diagnostics::display_path(&other.path)
            ),
        )
    })
}

#[cfg(windows)]
fn install(bundled: &Path, other: Option<&OtherCli>) -> io::Result<CliInstallation> {
    let directory = bundled
        .parent()
        .ok_or_else(|| io::Error::other("The app folder is unavailable."))?;
    if let Some(other) = other {
        remove_other(other)?;
    }
    let output = windows_path_command(WINDOWS_USER_PATH_SCRIPT, directory)?.output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "Could not update your Windows PATH: {}",
            String::from_utf8_lossy(&output.stderr).trim(),
        )));
    }
    Ok(installed(directory, Some("restart_terminals")))
}

/// The Debian package installs `/usr/bin/ticketd`; the fix only removes a copy
/// that comes before it.
#[cfg(not(any(target_os = "macos", windows)))]
fn install(_bundled: &Path, other: Option<&OtherCli>) -> io::Result<CliInstallation> {
    let other = other.ok_or_else(|| {
        io::Error::other("The Linux Debian package installs ticketd in /usr/bin.")
    })?;
    remove_other(other)?;
    Ok(installed(Path::new("/usr/bin"), None))
}

#[cfg(not(target_os = "macos"))]
fn install_in_user_bin(_bundled: &Path) -> io::Result<CliInstallation> {
    Err(io::Error::other(
        "Only macOS offers a folder that needs no password.",
    ))
}

#[cfg(all(windows, test))]
mod windows_tests {
    use super::*;

    #[test]
    fn installs_with_unusable_temp_and_preserves_the_expandable_user_path() {
        // A file cannot serve as the compiler's temporary directory.
        let blocked_temp = tempfile::NamedTempFile::new().unwrap();
        let script = format!(
            r#"
$ErrorActionPreference = 'Stop'
$registry = [Microsoft.Win32.Registry]::CurrentUser
$testKey = 'Software\TicketdCliPathTest-' + [Guid]::NewGuid().ToString('N')
$key = $registry.CreateSubKey($testKey)
try {{
    $original = '%SystemRoot%\Tools'
    $key.SetValue('Path', $original, 'ExpandString')
    $install = {{
{WINDOWS_USER_PATH_SCRIPT}
    }}
    & $install -EnvironmentKey $testKey
    & $install -EnvironmentKey $testKey
    $path = $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')
    if ($path -cne "$original;$env:TICKETD_CLI_DIRECTORY" -or
        $key.GetValueKind('Path') -ne 'ExpandString') {{
        throw 'Expected the original expandable PATH with the app folder appended once.'
    }}
}} finally {{
    $key.Dispose()
    $registry.DeleteSubKeyTree($testKey)
}}
"#
        );
        let output = windows_path_command(&script, Path::new(r"C:\Program Files\ticketd"))
            .unwrap()
            .env("TEMP", blocked_temp.path())
            .env("TMP", blocked_temp.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[cfg(all(target_os = "macos", test))]
mod tests {
    use super::*;
    use std::{cell::Cell, ffi::OsStr};

    /// A fake administrator prompt: counts the prompts and, when the person
    /// "approves", runs the script as this user, so tests change temporary
    /// folders only.
    struct Prompt {
        approve: bool,
        asked: Cell<u32>,
    }

    impl Prompt {
        fn new(approve: bool) -> Self {
            Prompt {
                approve,
                asked: Cell::new(0),
            }
        }

        fn run(&self, script: &str, args: &[&OsStr]) -> io::Result<bool> {
            self.asked.set(self.asked.get() + 1);
            if !self.approve {
                return Ok(false);
            }
            let output = std::process::Command::new("/bin/sh")
                .args(["-c", script, "ticketd"])
                .args(args)
                .output()?;
            if output.status.success() {
                Ok(true)
            } else {
                Err(io::Error::other("the script failed"))
            }
        }
    }

    struct Machine {
        _root: tempfile::TempDir,
        bundled: PathBuf,
        system: PathBuf,
        local: PathBuf,
    }

    #[allow(clippy::unwrap_used)] // Setup that fails must fail the test.
    fn machine() -> Machine {
        let root = tempfile::tempdir().unwrap();
        let bundled = root.path().join("ticketd.app/Contents/MacOS/ticketd");
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, "bundled").unwrap();
        let system = root.path().join("system/bin");
        let local = root.path().join("user/bin");
        Machine {
            _root: root,
            bundled,
            system,
            local,
        }
    }

    #[allow(clippy::unwrap_used)] // Setup that fails must fail the test.
    fn standalone(dir: &Path, contents: &str) -> OtherCli {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(CLI_EXE);
        fs::write(&path, contents).unwrap();
        OtherCli {
            path,
            version: Some("0.1.0".into()),
        }
    }

    #[test]
    fn a_missing_command_is_linked_with_one_prompt() {
        let m = machine();
        let prompt = Prompt::new(true);

        let result = install_mac(&m.bundled, &m.system, &m.local, None, |s, a| {
            prompt.run(s, a)
        })
        .unwrap();

        assert_eq!(result.outcome, Outcome::Installed);
        assert_eq!(result.directory, m.system);
        assert_eq!(prompt.asked.get(), 1);
        assert_eq!(fs::read_link(m.system.join(CLI_EXE)).unwrap(), m.bundled);
    }

    #[test]
    fn replacing_an_older_copy_removes_and_links_in_one_prompt() {
        let m = machine();
        let older = standalone(&m.system, "older");
        let prompt = Prompt::new(true);

        let result = install_mac(&m.bundled, &m.system, &m.local, Some(&older), |s, a| {
            prompt.run(s, a)
        })
        .unwrap();

        assert_eq!(result.outcome, Outcome::Installed);
        assert_eq!(prompt.asked.get(), 1);
        assert_eq!(fs::read_to_string(&older.path).unwrap(), "bundled");
        assert_eq!(fs::read_link(&older.path).unwrap(), m.bundled);
    }

    #[test]
    fn an_older_copy_in_another_folder_goes_in_the_same_prompt() {
        let m = machine();
        let older = standalone(&m.local, "older");
        let prompt = Prompt::new(true);

        install_mac(&m.bundled, &m.system, &m.local, Some(&older), |s, a| {
            prompt.run(s, a)
        })
        .unwrap();

        assert_eq!(prompt.asked.get(), 1);
        assert!(!older.path.exists());
        assert_eq!(fs::read_link(m.system.join(CLI_EXE)).unwrap(), m.bundled);
    }

    #[test]
    fn an_older_link_is_removed_without_touching_what_it_points_to() {
        let m = machine();
        let target = m._root.path().join("other.app/ticketd-binary");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, "other").unwrap();
        fs::create_dir_all(&m.local).unwrap();
        let link = m.local.join(CLI_EXE);
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let older = OtherCli {
            path: link.clone(),
            version: Some("0.1.0".into()),
        };

        install_mac(&m.bundled, &m.system, &m.local, Some(&older), |s, a| {
            Prompt::new(true).run(s, a)
        })
        .unwrap();

        assert!(fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "other");
    }

    #[test]
    fn when_this_apps_link_is_already_there_only_the_copy_in_the_way_is_removed() {
        let m = machine();
        fs::create_dir_all(&m.system).unwrap();
        std::os::unix::fs::symlink(&m.bundled, m.system.join(CLI_EXE)).unwrap();
        let older = standalone(&m.local, "older");
        let prompt = Prompt::new(true);

        install_mac(&m.bundled, &m.system, &m.local, Some(&older), |s, a| {
            prompt.run(s, a)
        })
        .unwrap();

        assert_eq!(prompt.asked.get(), 1);
        assert!(!older.path.exists());
        assert_eq!(fs::read_link(m.system.join(CLI_EXE)).unwrap(), m.bundled);
    }

    #[test]
    fn nothing_to_fix_asks_for_no_password() {
        let m = machine();
        fs::create_dir_all(&m.system).unwrap();
        std::os::unix::fs::symlink(&m.bundled, m.system.join(CLI_EXE)).unwrap();
        let prompt = Prompt::new(true);

        let result = install_mac(&m.bundled, &m.system, &m.local, None, |s, a| {
            prompt.run(s, a)
        })
        .unwrap();

        assert_eq!(result.outcome, Outcome::Installed);
        assert_eq!(prompt.asked.get(), 0);
    }

    #[test]
    fn declining_the_password_changes_nothing_and_offers_the_user_folder() {
        let m = machine();
        let older = standalone(&m.system, "older");
        let prompt = Prompt::new(false);

        let result = install_mac(&m.bundled, &m.system, &m.local, Some(&older), |s, a| {
            prompt.run(s, a)
        })
        .unwrap();

        assert_eq!(result.outcome, Outcome::Declined);
        assert_eq!(result.directory, m.local);
        assert_eq!(prompt.asked.get(), 1);
        assert_eq!(fs::read_to_string(&older.path).unwrap(), "older");
        assert!(!m.local.exists());
    }

    #[test]
    fn a_copy_replaced_since_it_was_checked_is_left_alone() {
        let m = machine();
        let older = standalone(&m.system, "older");
        let prompt = Prompt::new(true);

        let result = install_mac(
            &m.bundled,
            &m.system,
            &m.local,
            Some(&older),
            |script, args| {
                // Another process puts a different file there while the prompt is open.
                let replacement = older.path.with_file_name("replacement");
                fs::write(&replacement, "someone else's").unwrap();
                fs::rename(replacement, &older.path).unwrap();
                prompt.run(script, args)
            },
        );

        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&older.path).unwrap(), "someone else's");
    }

    #[test]
    fn a_different_copy_at_the_link_that_is_not_in_the_way_stops_before_the_prompt() {
        let m = machine();
        standalone(&m.system, "standalone");
        let prompt = Prompt::new(true);

        let error = install_mac(&m.bundled, &m.system, &m.local, None, |s, a| {
            prompt.run(s, a)
        })
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(prompt.asked.get(), 0);
    }

    #[test]
    fn a_copy_inside_another_app_is_never_removed() {
        let m = machine();
        let other_app = m._root.path().join("Other.app/Contents/MacOS");
        let other = standalone(&other_app, "other app");
        let prompt = Prompt::new(true);

        let error = install_mac(&m.bundled, &m.system, &m.local, Some(&other), |s, a| {
            prompt.run(s, a)
        })
        .unwrap_err();

        assert!(error.to_string().contains("another copy of the app"));
        assert_eq!(prompt.asked.get(), 0);
        assert!(other.path.exists());
    }

    #[test]
    fn the_user_folder_link_follows_an_app_update() {
        let m = machine();

        let installed = link_in_user_bin(&m.bundled, &m.local).unwrap();
        assert_eq!(installed.directory, m.local);
        assert_eq!(installed.next_step, Some("add_to_path"));
        let link = m.local.join("ticketd");
        assert_eq!(fs::read_link(&link).unwrap(), m.bundled);

        let replacement = m.bundled.with_file_name("next");
        fs::write(&replacement, "version 2").unwrap();
        fs::rename(replacement, &m.bundled).unwrap();
        assert_eq!(fs::read_to_string(link).unwrap(), "version 2");
    }

    #[test]
    fn repairs_a_link_after_the_app_moves_and_preserves_an_existing_standalone_copy() {
        let m = machine();
        let previous = m
            ._root
            .path()
            .join("old/ticketd.app/Contents/MacOS/ticketd");
        fs::create_dir_all(&m.local).unwrap();
        let link = m.local.join(CLI_EXE);
        std::os::unix::fs::symlink(previous, &link).unwrap();

        link_in_user_bin(&m.bundled, &m.local).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), m.bundled);
        assert_eq!(fs::read_to_string(&link).unwrap(), "bundled");

        fs::remove_file(&link).unwrap();
        fs::write(&link, "standalone").unwrap();
        assert_eq!(
            link_in_user_bin(&m.bundled, &m.local).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists,
        );
        assert_eq!(fs::read_to_string(&link).unwrap(), "standalone");
    }

    #[test]
    fn a_link_broken_by_moving_the_app_is_replaced_in_the_one_prompt() {
        let m = machine();
        let previous = m
            ._root
            .path()
            .join("old/ticketd.app/Contents/MacOS/ticketd");
        fs::create_dir_all(&m.system).unwrap();
        std::os::unix::fs::symlink(&previous, m.system.join(CLI_EXE)).unwrap();
        let prompt = Prompt::new(true);

        install_mac(&m.bundled, &m.system, &m.local, None, |s, a| {
            prompt.run(s, a)
        })
        .unwrap();

        assert_eq!(prompt.asked.get(), 1);
        assert_eq!(fs::read_link(m.system.join(CLI_EXE)).unwrap(), m.bundled);
    }
}
