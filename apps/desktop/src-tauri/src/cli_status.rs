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
    older: Option<OlderCli>,
}

#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct OlderCli {
    path: PathBuf,
    version: String,
}

#[derive(Serialize)]
pub struct CliInstallation {
    directory: PathBuf,
    next_step: Option<&'static str>,
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

fn older_cli(status: &CliStatus, bundled: &Path) -> Option<OlderCli> {
    let path = PathBuf::from(status.path.as_ref()?);
    let version = status.version.as_ref()?;
    if !status.on_path
        || !path.is_absolute()
        || same_executable(&path, bundled)
        || semver::Version::parse(version).ok()?
            >= semver::Version::parse(&status.app_version).ok()?
    {
        return None;
    }
    Some(OlderCli {
        path,
        version: version.clone(),
    })
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
        let workspace = crate::open_workspace()
            .and_then(|workspace| workspace.workspace_info())
            .ok()
            .map(|info| PathBuf::from(info.path));
        let status = cli::locate_for_terminals(
            desktop.as_deref(),
            &version,
            workspace.as_deref(),
            refresh_path.unwrap_or(false),
        );
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
                older: older_cli(&status, &cli),
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

#[tauri::command]
pub async fn install_cli(app: tauri::AppHandle) -> Result<CliInstallation, String> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        with_path_change(|desktop| {
            let bundled =
                bundled_cli(desktop).ok_or("This app has no bundled command-line tool.")?;
            if cli::version(&bundled).as_deref() != Some(&version) {
                return Err(
                    "The bundled CLI does not match this app's version. Reinstall the app.".into(),
                );
            }
            install(&bundled).map_err(|err| err.to_string())
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn remove_older_cli(app: tauri::AppHandle, older: OlderCli) -> Result<(), String> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        with_path_change(|desktop| {
            let bundled =
                bundled_cli(desktop).ok_or("This app has no bundled command-line tool.")?;
            let status = cli::locate_for_terminals(Some(desktop), &version, None, true);
            if older_cli(&status, &bundled).as_ref() != Some(&older) {
                return Err(
                    "The first ticketd on your PATH changed. Check again before removing it."
                        .into(),
                );
            }
            remove_cli(&older.path).map_err(|error| {
                format!(
                    "Couldn't remove {}: {error}",
                    ticketd_diagnostics::display_path(&older.path)
                )
            })
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Removes an older CLI. On macOS, one in a folder only an administrator can
/// change (such as `/usr/local/bin`) is removed after the system's password prompt.
fn remove_cli(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        #[cfg(target_os = "macos")]
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            if remove_as_admin(path)? {
                Ok(())
            } else {
                Err(io::Error::other("the password prompt was cancelled"))
            }
        }
        result => result,
    }
}

/// Removes `$1` only if it is still the file identified as `$2` (device:inode)
/// when it was checked, not one put in its place since.
#[cfg(target_os = "macos")]
const REMOVE_IF_SAME: &str = r#"[ "$(/usr/bin/stat -f %d:%i "$1")" = "$2" ] && /bin/rm -- "$1""#;

#[cfg(target_os = "macos")]
fn remove_as_admin(path: &Path) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path)?;
    let identity = format!("{}:{}", metadata.dev(), metadata.ino());
    run_as_admin(REMOVE_IF_SAME, &[path.as_os_str(), identity.as_ref()])
        .map_err(|error| io::Error::other(format!("the administrator removal failed: {error}")))
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
fn install(bundled: &Path) -> io::Result<CliInstallation> {
    let home =
        std::env::home_dir().ok_or_else(|| io::Error::other("The home folder is unavailable."))?;
    install_mac(
        bundled,
        Path::new("/usr/local/bin"),
        &home.join(".local/bin"),
        make_admin_link,
    )
}

#[cfg(target_os = "macos")]
fn install_mac(
    bundled: &Path,
    system: &Path,
    local: &Path,
    admin_link: impl FnOnce(&Path, &Path, Option<&Path>) -> io::Result<bool>,
) -> io::Result<CliInstallation> {
    let system_link = system.join(CLI_EXE);
    if same_executable(&system_link, bundled)
        || admin_link(bundled, &system_link, stale_link(&system_link)?.as_deref())?
    {
        return Ok(CliInstallation {
            directory: system.to_path_buf(),
            next_step: None,
        });
    }

    // The user declined the OS prompt. A no-clobber link works without elevation.
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
    Ok(CliInstallation {
        directory: local.to_path_buf(),
        next_step: Some("add_to_path"),
    })
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

#[cfg(target_os = "macos")]
fn make_admin_link(bundled: &Path, link: &Path, previous: Option<&Path>) -> io::Result<bool> {
    const LINK: &str = r#"
        /bin/mkdir -p /usr/local/bin || exit
        if [ -n "$3" ]; then
            [ -L "$2" ] && [ "$(/usr/bin/readlink "$2")" = "$3" ] &&
            /bin/rm "$2" || exit 1
        fi
        [ ! -e "$2" ] && [ ! -L "$2" ] && /bin/ln -sh "$1" "$2"
    "#;
    let previous = previous.unwrap_or_else(|| Path::new(""));
    run_as_admin(
        LINK,
        &[bundled.as_os_str(), link.as_os_str(), previous.as_os_str()],
    )
    .map_err(|error| io::Error::other(format!("Could not create the system CLI link: {error}")))
}

#[cfg(windows)]
fn install(bundled: &Path) -> io::Result<CliInstallation> {
    use std::{os::windows::process::CommandExt, process::Command};

    let directory = bundled
        .parent()
        .ok_or_else(|| io::Error::other("The app folder is unavailable."))?;
    let system_root = std::env::var_os("SystemRoot")
        .ok_or_else(|| io::Error::other("Windows SystemRoot is unavailable."))?;
    let powershell =
        PathBuf::from(system_root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let output = Command::new(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            include_str!("cli_user_path.ps1"),
        ])
        .env("TICKETD_CLI_DIRECTORY", directory)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "Could not update your Windows PATH: {}",
            String::from_utf8_lossy(&output.stderr).trim(),
        )));
    }
    Ok(CliInstallation {
        directory: directory.to_path_buf(),
        next_step: Some("restart_terminals"),
    })
}

#[cfg(not(any(target_os = "macos", windows)))]
fn install(_bundled: &Path) -> io::Result<CliInstallation> {
    Err(io::Error::other(
        "The Linux Debian package installs ticketd in /usr/bin.",
    ))
}

#[cfg(all(target_os = "macos", test))]
mod tests {
    use super::*;

    #[test]
    fn the_admin_removal_only_removes_the_file_that_was_checked() {
        use std::os::unix::fs::MetadataExt;
        let root = tempfile::tempdir().unwrap();
        let older = root.path().join("ticketd");
        fs::write(&older, "older").unwrap();
        let metadata = fs::symlink_metadata(&older).unwrap();
        let checked = format!("{}:{}", metadata.dev(), metadata.ino());
        let remove = |identity: &str| {
            std::process::Command::new("/bin/sh")
                .args(["-c", REMOVE_IF_SAME, "ticketd"])
                .arg(&older)
                .arg(identity)
                .status()
                .unwrap()
                .success()
        };

        assert!(!remove("0:0"));
        assert!(older.exists());
        assert!(remove(&checked));
        assert!(!older.exists());
    }

    #[test]
    fn declining_admin_links_in_user_bin_and_the_link_follows_an_app_update() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("ticketd.app/Contents/MacOS");
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("ticketd");
        fs::write(&source, "version 1").unwrap();
        let local = root.path().join("user/bin");
        let system = root.path().join("system/bin");

        let installed = install_mac(&source, &system, &local, |_, _, _| Ok(false)).unwrap();
        assert_eq!(installed.directory, local);
        assert!(!system.exists());
        let link = local.join("ticketd");
        assert_eq!(fs::read_link(&link).unwrap(), source);

        let replacement = dir.join("next");
        fs::write(&replacement, "version 2").unwrap();
        fs::rename(replacement, source).unwrap();
        assert_eq!(fs::read_to_string(link).unwrap(), "version 2");
    }

    #[test]
    fn repairs_a_link_after_the_app_moves_and_preserves_an_existing_standalone_copy() {
        let root = tempfile::tempdir().unwrap();
        let system = root.path().join("system");
        let local = root.path().join("local");
        let source = root.path().join("Moved app.app/Contents/MacOS/ticketd");
        let previous = root.path().join("ticketd.app/Contents/MacOS/ticketd");
        fs::create_dir(&local).unwrap();
        let link = local.join(CLI_EXE);
        std::os::unix::fs::symlink(previous, &link).unwrap();
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "bundled").unwrap();

        install_mac(&source, &system, &local, |_, _, _| Ok(false)).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), source);
        assert_eq!(fs::read_to_string(&link).unwrap(), "bundled");

        fs::remove_file(&link).unwrap();
        fs::write(&link, "standalone").unwrap();
        assert_eq!(
            install_mac(&source, &system, &local, |_, _, _| Ok(false))
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::AlreadyExists,
        );
        assert_eq!(fs::read_to_string(&link).unwrap(), "standalone");
    }
}
