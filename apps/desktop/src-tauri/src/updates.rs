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
    #[serde(flatten)]
    phase: Phase,
}

struct ReadyUpdate {
    offer: Update,
    bytes: Vec<u8>,
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
        let phase = if self.ready.is_some() {
            self.snapshot.phase.clone()
        } else {
            Phase::CheckFailed
        };
        self.finish(app, phase);
    }

    fn finish(&mut self, app: &AppHandle, phase: Phase) {
        self.check = None;
        self.snapshot.phase = phase;
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
                automatic,
                dismissed: false,
                phase: Phase::Idle,
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
    if session.snapshot.automatic == enabled {
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
    if session.installing || session.check.is_some() || (!manual && !session.snapshot.automatic) {
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
                session.ready = None;
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
        let Some(format) = offer.raw_json["format_version"]
            .as_i64()
            .filter(|value| *value > 0)
        else {
            session.check_failed(
                &app,
                "missing_format_version",
                "update manifest has no workspace format version",
            );
            return;
        };
        session.check_error = None;
        let info = UpdateInfo {
            release_url: format!("{RELEASES}/tag/v{}", offer.version),
            version: offer.version.clone(),
            upgrades_workspace: format > ticketd_core::FORMAT_VERSION,
        };
        tracing::info!(version = %info.version, "update check found newer release");
        if session.ready.as_ref().is_some_and(|ready| {
            ready.offer.version == offer.version && ready.offer.signature == offer.signature
        }) {
            session.finish(&app, Phase::Ready { update: info });
            return;
        }
        session.ready = None;
        if !can_install() {
            tracing::info!(version = %info.version, "update requires manual installation");
            session.finish(&app, Phase::ManualInstall { update: info });
            return;
        }
        session.snapshot.phase = Phase::Downloading {
            update: info.clone(),
        };
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
            session.ready = Some(ReadyUpdate { offer, bytes });
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
    let result = tauri::async_runtime::spawn_blocking(move || install(&install_app, &version))
        .await
        .map_err(|error| error.to_string())?;
    result?;
    #[cfg(not(target_os = "windows"))]
    app.request_restart();
    Ok(())
}

fn install(app: &AppHandle, version: &str) -> Result<(), String> {
    let updates = app.state::<Updates>();
    let ready = {
        let mut session = updates.lock();
        if !ready_for(&session, version) || session.installing {
            return Err("This update is no longer ready. Check for updates again.".into());
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

    tracing::info!(version, "update install started");
    match install_package(&ready) {
        Ok(()) => {
            tracing::info!(version, "update installed");
            Ok(())
        }
        Err(error) => {
            let error = match error {
                Error::PreviousAppNotRestored(path) => format!(
                    "The previous app was left at {}.",
                    ticketd_diagnostics::display_path(&path)
                ),
                other => other.to_string(),
            };
            tracing::warn!(version, %error, "update install failed");
            let mut session = updates.lock();
            session.installing = false;
            session.ready = Some(ready);
            Err(error)
        }
    }
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

#[cfg(not(target_os = "linux"))]
fn install_package(ready: &ReadyUpdate) -> tauri_plugin_updater::Result<()> {
    ready.offer.install(&ready.bytes)
}
