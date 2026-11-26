//! Desktop-only updater. The WebView can request a check or confirm installation
//! of the current verified package, but cannot supply an endpoint or installer.
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_updater::{Error, Update, Updater, UpdaterExt};

use crate::chat_commands::ChatBridge;
use crate::chats::Stopping;

const CHANGE_EVENT: &str = "ticketd://update-state";
const STARTUP_DELAY: Duration = Duration::from_secs(10);
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const RELEASES: &str = "https://github.com/vantoan19/ticketd/releases";

#[derive(Clone, serde::Serialize)]
pub struct UpdateInfo {
    version: String,
    release_url: String,
    upgrades_workspace: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Phase {
    Unavailable,
    Idle,
    Checking,
    UpToDate {
        checked_at: u64,
    },
    CheckFailed,
    Downloading {
        update: UpdateInfo,
    },
    DownloadFailed {
        update: UpdateInfo,
        error: &'static str,
        verification_failed: bool,
    },
    ManualInstall {
        update: UpdateInfo,
    },
    Ready {
        update: UpdateInfo,
    },
}

impl Phase {
    fn for_public_key(key: Option<&str>) -> Self {
        if key.is_some_and(|key| !key.trim().is_empty()) {
            Self::Idle
        } else {
            Self::Unavailable
        }
    }

    fn may_check(&self, automatic: bool, manual: bool) -> bool {
        !matches!(self, Self::Unavailable) && (automatic || manual)
    }

    /// Keep the verified release visible until another verified release replaces it.
    fn report(&mut self, next: Self) {
        if !matches!(self, Self::Ready { .. }) || matches!(next, Self::Ready { .. }) {
            *self = next;
        }
    }

    fn notice(&self) -> Option<&UpdateInfo> {
        match self {
            Self::DownloadFailed { update, .. }
            | Self::ManualInstall { update }
            | Self::Ready { update } => Some(update),
            _ => None,
        }
    }
}

#[derive(Clone, serde::Serialize)]
pub struct Snapshot {
    revision: u64,
    automatic: bool,
    dismissed: bool,
    install_on_quit: bool,
    #[serde(flatten)]
    phase: Phase,
}

struct ReadyUpdate {
    offer: Update,
    bytes: Vec<u8>,
    /// Whether installing it raises the workspace format (see `should_install_on_quit`).
    upgrades_workspace: bool,
}

struct Session {
    snapshot: Snapshot,
    dismissed: Option<String>,
    sequence: u64,
    check: Option<tauri::async_runtime::JoinHandle<()>>,
    ready: Option<ReadyUpdate>,
    installing: bool,
    check_error: Option<&'static str>,
    download_error: Option<&'static str>,
}

impl Session {
    fn publish(&mut self, app: &AppHandle) {
        self.snapshot.revision += 1;
        self.snapshot.dismissed = self
            .snapshot
            .phase
            .notice()
            .is_some_and(|info| self.dismissed.as_ref() == Some(&info.version));
        if let Err(error) = app.emit(CHANGE_EVENT, &self.snapshot) {
            tracing::warn!(%error, "could not publish update state");
        }
    }

    fn check_failed(&mut self, app: &AppHandle, error_kind: &'static str, error: &str) {
        if self.check_error != Some(error_kind) {
            tracing::warn!(error_kind, error, "update check failed");
            self.check_error = Some(error_kind);
        }
        self.finish(app, Phase::CheckFailed);
    }

    fn finish(&mut self, app: &AppHandle, phase: Phase) {
        self.check = None;
        self.snapshot.phase.report(phase);
        self.publish(app);
    }
}

pub struct Updates {
    // Presence of a per-device marker disables automatic checks. We never write
    // this preference into the synced Workspace.
    disabled_file: Result<PathBuf, String>,
    session: Mutex<Session>,
}

impl Updates {
    fn lock(&self) -> MutexGuard<'_, Session> {
        self.session
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

pub fn start(app: &AppHandle) {
    let phase = Phase::for_public_key(
        app.config()
            .plugins
            .0
            .get("updater")
            .and_then(|config| config["pubkey"].as_str()),
    );
    let available = !matches!(phase, Phase::Unavailable);
    let disabled_file = app
        .path()
        .app_config_dir()
        .map(|dir| dir.join("automatic-updates-off"))
        .map_err(|error| error.to_string());
    let automatic = match disabled_file
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|path| path.try_exists().map_err(|error| error.to_string()))
    {
        Ok(disabled) => !disabled,
        Err(error) => {
            tracing::warn!(%error, "could not read automatic update preference");
            // If we don't know the saved choice, wait for an explicit check.
            false
        }
    };
    app.manage(Updates {
        disabled_file,
        session: Mutex::new(Session {
            snapshot: Snapshot {
                revision: 0,
                automatic: available && automatic,
                dismissed: false,
                install_on_quit: matches!(std::env::consts::OS, "macos" | "windows"),
                phase,
            },
            dismissed: None,
            sequence: 0,
            check: None,
            ready: None,
            installing: false,
            check_error: None,
            download_error: None,
        }),
    });

    if !available {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut timer =
            tokio::time::interval_at(tokio::time::Instant::now() + STARTUP_DELAY, CHECK_INTERVAL);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            timer.tick().await;
            start_check(&app, false);
        }
    });
}

#[tauri::command]
pub fn updates_state(updates: State<'_, Updates>) -> Snapshot {
    updates.lock().snapshot.clone()
}

#[tauri::command]
pub fn updates_set_automatic(app: AppHandle, enabled: bool) -> Result<Snapshot, String> {
    let updates = app.state::<Updates>();
    let mut session = updates.lock();
    if matches!(session.snapshot.phase, Phase::Unavailable) || session.snapshot.automatic == enabled
    {
        return Ok(session.snapshot.clone());
    }
    let path = updates
        .disabled_file
        .as_ref()
        .map_err(ToString::to_string)?;
    save_preference(path, enabled).map_err(|error| {
        tracing::warn!(%error, "could not save automatic update preference");
        error.to_string()
    })?;
    session.snapshot.automatic = enabled;
    if !enabled && let Some(check) = session.check.take() {
        check.abort();
        session.sequence += 1;
        if matches!(
            session.snapshot.phase,
            Phase::Checking | Phase::Downloading { .. }
        ) {
            session.snapshot.phase = Phase::Idle;
        }
        tracing::info!("update request cancelled");
    }
    session.publish(&app);
    Ok(session.snapshot.clone())
}

fn save_preference(path: &Path, enabled: bool) -> io::Result<()> {
    if enabled {
        match std::fs::remove_file(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    } else {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::File::create(path)?;
        Ok(())
    }
}

#[tauri::command]
pub fn updates_check(app: AppHandle) {
    start_check(&app, true);
}

fn start_check(app: &AppHandle, manual: bool) {
    let updates = app.state::<Updates>();
    let mut session = updates.lock();
    if session.installing
        || session.check.is_some()
        || !session
            .snapshot
            .phase
            .may_check(session.snapshot.automatic, manual)
    {
        return;
    }
    session.sequence += 1;
    let sequence = session.sequence;
    let worker_app = app.clone();
    session.check = Some(tauri::async_runtime::spawn(async move {
        check(worker_app, sequence).await;
    }));
    if session.ready.is_none() {
        session.snapshot.phase = Phase::Checking;
        session.publish(app);
    }
}

fn updater(app: &AppHandle) -> tauri_plugin_updater::Result<Updater> {
    let builder = app
        .updater_builder()
        .timeout(Duration::from_secs(120))
        .configure_client(|client| client.https_only(true))
        .version_comparator(|current, release| {
            release.version.pre.is_empty() && release.version > current
        });
    // Only debug builds can opt into a loopback feed. The public key still
    // comes from the bundle's build-time configuration, like a release key.
    #[cfg(debug_assertions)]
    let builder = if let Ok(endpoint) = std::env::var("TICKETD_TEST_UPDATE_ENDPOINT") {
        let url = Url::parse(&endpoint)?;
        if !is_test_url(&url) {
            return Err(Error::InsecureTransportProtocol);
        }
        builder
            .no_proxy()
            .configure_client(|client| client.https_only(false))
            .endpoints(vec![url])?
    } else {
        builder
    };
    builder.build()
}

#[cfg(debug_assertions)]
fn is_test_url(url: &Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
}

fn allows_download(url: &Url) -> bool {
    #[cfg(debug_assertions)]
    if std::env::var("TICKETD_TEST_UPDATE_ENDPOINT").is_ok() && is_test_url(url) {
        return true;
    }
    url.scheme() == "https"
}

async fn check(app: AppHandle, sequence: u64) {
    tracing::info!("update check started");
    let result = match updater(&app) {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let updates = app.state::<Updates>();
    let (offer, info) = {
        let mut session = updates.lock();
        if session.sequence != sequence {
            return;
        }
        let offer = match result {
            Ok(Some(offer)) => offer,
            Ok(None) => {
                let checked_at = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                tracing::info!("update check found no newer release");
                session.check_error = None;
                session.download_error = None;
                session.finish(&app, Phase::UpToDate { checked_at });
                return;
            }
            Err(error) => {
                let (error_kind, error) = check_failure(&error);
                session.check_failed(&app, error_kind, error);
                return;
            }
        };
        session.check_error = None;
        let info = UpdateInfo {
            release_url: format!("{RELEASES}/tag/v{}", offer.version),
            version: offer.version.clone(),
            upgrades_workspace: upgrades_workspace(
                &offer.raw_json,
                ticketd_core::FORMAT_VERSION,
            ),
        };
        tracing::info!(version = %info.version, "update check found newer release");
        if session.ready.as_ref().is_some_and(|ready| {
            !semver::Version::parse(&offer.version)
                .ok()
                .zip(semver::Version::parse(&ready.offer.version).ok())
                .is_some_and(|(offered, current)| offered.cmp_precedence(&current).is_gt())
        }) {
            session.check = None;
            return;
        }
        if !can_install() {
            tracing::info!(version = %info.version, "update requires manual installation");
            session.finish(&app, Phase::ManualInstall { update: info });
            return;
        }
        session.snapshot.phase.report(Phase::Downloading {
            update: info.clone(),
        });
        session.publish(&app);
        (offer, info)
    };

    let result = if allows_download(&offer.download_url) {
        offer.download(|_, _| {}, || {}).await
    } else {
        Err(Error::InsecureTransportProtocol)
    };
    let mut session = updates.lock();
    if session.sequence != sequence {
        return;
    }
    let phase = match result {
        Ok(bytes) => {
            tracing::info!(version = %info.version, bytes = bytes.len(), "update downloaded and verified");
            if session.dismissed.as_ref() == Some(&info.version) {
                session.dismissed = None;
            }
            session.download_error = None;
            session.ready = Some(ReadyUpdate {
                offer,
                bytes,
                upgrades_workspace: info.upgrades_workspace,
            });
            Phase::Ready { update: info }
        }
        Err(error) => {
            let (error_kind, error) = download_failure(&error);
            if session.download_error != Some(error_kind) {
                tracing::warn!(version = %info.version, error_kind, error, "update download failed");
                session.download_error = Some(error_kind);
            }
            Phase::DownloadFailed {
                update: info,
                error,
                verification_failed: error_kind == "signature",
            }
        }
    };
    session.finish(&app, phase);
}

// HTTP and feed errors can quote private proxy URLs or arbitrary server text.
// Record their kind and a local description, and never log the remote input.
fn check_failure(error: &Error) -> (&'static str, &'static str) {
    match error {
        Error::Reqwest(error) if error.is_timeout() => ("timeout", "update request timed out"),
        Error::Reqwest(error) if error.is_decode() => {
            ("invalid_manifest", "update manifest is not valid JSON")
        }
        Error::Reqwest(_) => ("request", "could not reach the update server"),
        Error::Serialization(_) => ("invalid_manifest", "update manifest is invalid"),
        Error::ReleaseNotFound => (
            "release_not_found",
            "update server did not return a release",
        ),
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => (
            "target_not_found",
            "release has no update for this platform",
        ),
        _ => ("check_failed", "updater could not check for a release"),
    }
}

fn download_failure(error: &Error) -> (&'static str, &'static str) {
    match error {
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => {
            ("signature", "The update signature could not be verified.")
        }
        Error::InsecureTransportProtocol => {
            ("insecure_url", "The update download link is insecure.")
        }
        Error::Reqwest(error) if error.is_timeout() => {
            ("timeout", "The update download timed out.")
        }
        _ => (
            "download_failed",
            "The update download could not be completed.",
        ),
    }
}

#[tauri::command]
pub fn updates_dismiss(app: AppHandle, version: String) {
    let updates = app.state::<Updates>();
    let mut session = updates.lock();
    if session
        .snapshot
        .phase
        .notice()
        .is_some_and(|update| update.version == version)
    {
        session.dismissed = Some(version);
        session.publish(&app);
    }
}

fn ready_for(session: &Session, version: &str) -> bool {
    matches!(&session.snapshot.phase, Phase::Ready { update } if update.version == version)
}

#[tauri::command]
pub async fn updates_restart_details(app: AppHandle, version: String) -> Result<Stopping, String> {
    if !ready_for(&app.state::<Updates>().lock(), &version) {
        return Err("This update is no longer ready. Check for updates again.".into());
    }
    tauri::async_runtime::spawn_blocking(move || app.state::<ChatBridge>().chats().stopping())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn updates_install(app: AppHandle, version: String) -> Result<(), String> {
    let install_app = app.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || install(&install_app, Some(&version)))
            .await
            .map_err(|error| error.to_string())?;
    result?;
    #[cfg(not(target_os = "windows"))]
    app.request_restart();
    Ok(())
}

/// Whether installing the update raises the workspace format. The release's
/// manifest names the format it ships; a manifest that doesn't (a release from
/// before it did, or one assembled by hand) is treated as raising it, so the
/// person gets the warning rather than a failed check.
fn upgrades_workspace(manifest: &serde_json::Value, installed: i64) -> bool {
    manifest["format_version"]
        .as_i64()
        .filter(|format| *format > 0)
        .is_none_or(|format| format > installed)
}

/// Quitting installs a ready update only where that needs no prompt, and only
/// when it keeps the workspace format: a format change is named in the restart
/// prompt first (ADR 0019), so it installs only from Restart to update.
fn should_install_on_quit(platform: &str, upgrades_workspace: Option<bool>) -> bool {
    matches!(platform, "macos" | "windows") && upgrades_workspace == Some(false)
}

pub fn install_on_quit(app: &AppHandle) {
    if app.try_state::<Updates>().is_some() {
        // We are already exiting. `install` decides under the session lock and
        // logs any failure before shutdown continues.
        let _ = install(app, None);
    }
}

pub fn install_in_progress(app: &AppHandle) -> bool {
    app.try_state::<Updates>()
        .is_some_and(|updates| updates.lock().installing)
}

fn install(app: &AppHandle, requested_version: Option<&str>) -> Result<(), String> {
    let updates = app.state::<Updates>();
    let ready = {
        let mut session = updates.lock();
        if session.installing
            || requested_version.is_some_and(|version| !ready_for(&session, version))
        {
            return Err("This update is no longer ready. Check for updates again.".into());
        }
        // On quit (no requested version), decide on the update taken here, so a
        // download that finished since can't bypass the format notice.
        if requested_version.is_none()
            && !should_install_on_quit(
                std::env::consts::OS,
                session.ready.as_ref().map(|ready| ready.upgrades_workspace),
            )
        {
            return Ok(());
        }
        let Some(ready) = session.ready.take() else {
            return Err("This update is no longer ready. Check for updates again.".into());
        };
        if let Some(check) = session.check.take() {
            check.abort();
            session.sequence += 1;
        }
        session.installing = true;
        ready
    };

    let version = ready.offer.version.as_str();
    tracing::info!(version, "update install started");
    #[cfg(windows)]
    let result = install_windows(app, &ready, requested_version.is_some());
    #[cfg(not(windows))]
    let result = install_package(&ready);
    match result {
        Ok(()) => {
            tracing::info!(version, "update installed");
            Ok(())
        }
        Err(error) => {
            let (error_kind, summary) = install_failure(&error);
            tracing::warn!(
                version,
                error_kind,
                error = summary,
                "update install failed"
            );
            let error = match error {
                Error::PreviousAppNotRestored(path) => format!(
                    "The previous app was left at {}.",
                    ticketd_diagnostics::display_path(&path)
                ),
                other => other.to_string(),
            };
            let mut session = updates.lock();
            session.installing = false;
            session.ready = Some(ready);
            Err(error)
        }
    }
}

fn install_failure(error: &Error) -> (&'static str, &'static str) {
    match error {
        Error::PreviousAppNotRestored(_) => (
            "previous_app_not_restored",
            "could not restore the previous app",
        ),
        Error::InvalidUpdaterFormat | Error::BinaryNotFoundInArchive => {
            ("invalid_package", "update package format is invalid")
        }
        Error::TempDirNotFound | Error::TempDirNotOnSameMountPoint => (
            "temporary_directory",
            "could not prepare a temporary directory",
        ),
        Error::AuthenticationFailed => (
            "authentication",
            "installer authentication failed or was cancelled",
        ),
        Error::DebInstallFailed => ("deb_install_failed", "dpkg could not install the update"),
        Error::Io(_) => ("io", "the update installer encountered an I/O error"),
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => download_failure(error),
        _ => ("install_failed", "updater could not install the package"),
    }
}

#[cfg(windows)]
fn install_windows(
    app: &AppHandle,
    ready: &ReadyUpdate,
    restart: bool,
) -> tauri_plugin_updater::Result<()> {
    // The plugin exits directly after handing off to MSI. Normal quit already
    // drained the Chats. Restart now must do the same here.
    if restart {
        crate::chat_commands::shutdown(app);
    }
    let result = ready
        .offer
        .clone()
        .restart_after_install(restart)
        .install(&ready.bytes);
    if restart && result.is_err() {
        crate::chat_commands::cancel_shutdown(app);
    }
    result
}

#[cfg(target_os = "linux")]
const PKEXEC: &str = "/usr/bin/pkexec";
#[cfg(target_os = "linux")]
const DPKG: &str = "/usr/bin/dpkg";

#[cfg(target_os = "linux")]
fn can_install() -> bool {
    Path::new(PKEXEC).is_file() && Path::new(DPKG).is_file()
}

#[cfg(not(target_os = "linux"))]
fn can_install() -> bool {
    true
}

#[cfg(target_os = "linux")]
fn install_package(ready: &ReadyUpdate) -> tauri_plugin_updater::Result<()> {
    // The plugin's Linux installer falls back to sudo (including after an
    // admin prompt is cancelled). Only the system admin prompt is used here.
    ready.offer.verify(&ready.bytes)?;
    let directory = tempfile::tempdir()?;
    let package = directory.path().join("ticketd.deb");
    std::fs::write(&package, &ready.bytes)?;
    let status = std::process::Command::new(PKEXEC)
        .args([DPKG, "-i"])
        .arg(&package)
        .status()?;
    match status.code() {
        Some(0) => Ok(()),
        Some(126 | 127) => Err(Error::AuthenticationFailed),
        _ => Err(Error::DebInstallFailed),
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
fn install_package(ready: &ReadyUpdate) -> tauri_plugin_updater::Result<()> {
    ready.offer.install(&ready.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quitting_installs_only_an_already_verified_update_on_unattended_platforms() {
        for platform in ["macos", "windows"] {
            assert!(should_install_on_quit(platform, Some(false)));
            assert!(!should_install_on_quit(platform, None));
            assert!(
                !should_install_on_quit(platform, Some(true)),
                "a format change installs only after the restart prompt names it"
            );
        }
        assert!(!should_install_on_quit("linux", Some(false)));
    }

    #[test]
    fn the_manifest_names_whether_an_update_raises_the_workspace_format() {
        let manifest = |format: serde_json::Value| serde_json::json!({ "format_version": format });
        assert!(!upgrades_workspace(&manifest(5.into()), 5));
        assert!(!upgrades_workspace(&manifest(4.into()), 5));
        assert!(upgrades_workspace(&manifest(6.into()), 5));
    }

    #[test]
    fn a_manifest_without_a_usable_format_is_assumed_to_raise_it() {
        assert!(upgrades_workspace(&serde_json::json!({}), 5));
        for format in [
            serde_json::json!(null),
            serde_json::json!("6"),
            serde_json::json!(0),
            serde_json::json!(-1),
        ] {
            assert!(upgrades_workspace(
                &serde_json::json!({ "format_version": format }),
                5
            ));
        }
    }

    #[test]
    fn a_ready_version_remains_visible_until_the_replacement_is_verified() {
        let update = |version: &str| UpdateInfo {
            version: version.into(),
            release_url: format!("{RELEASES}/tag/v{version}"),
            upgrades_workspace: false,
        };
        let mut phase = Phase::Ready {
            update: update("0.2.0"),
        };
        phase.report(Phase::Downloading {
            update: update("0.3.0"),
        });
        assert_eq!(phase.notice().unwrap().version, "0.2.0");
        phase.report(Phase::DownloadFailed {
            update: update("0.3.0"),
            error: "The update signature could not be verified.",
            verification_failed: true,
        });
        assert!(matches!(&phase, Phase::Ready { update } if update.version == "0.2.0"));
        phase.report(Phase::UpToDate { checked_at: 1 });
        assert_eq!(phase.notice().unwrap().version, "0.2.0");
        phase.report(Phase::Ready {
            update: update("0.3.0"),
        });
        assert_eq!(phase.notice().unwrap().version, "0.3.0");
    }

    #[test]
    fn builds_without_an_embedded_key_skip_scheduled_and_manual_checks() {
        for key in [None, Some(""), Some("  ")] {
            let phase = Phase::for_public_key(key);
            assert!(!phase.may_check(true, false));
            assert!(!phase.may_check(true, true));
        }
        let phase = Phase::for_public_key(Some("embedded public key"));
        assert!(phase.may_check(true, false));
        assert!(!phase.may_check(false, false));
        assert!(phase.may_check(false, true));
    }
}
