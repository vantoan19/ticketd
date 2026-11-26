use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

use fs2::FileExt;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::process::Command;

use super::{
    Capability, Definition, Host, ProcessConnector, SourceError, host::validate_handshake,
    redaction::Redactions, wire::Description,
};
use crate::source::{
    CONTRACT_VERSION, ConfigValues, ConformanceOptions, ConformanceReport, Engine, conformance,
};

pub(super) const MANIFEST: &str = "ticketd-source.json";
pub(super) const MANIFEST_LIMIT: u64 = 16 * 1024;
const RECORD_LIMIT: u64 = 1024 * 1024;
const PACKAGE_PREFIX: &str = ".source-package-";
const STAGING_PREFIX: &str = ".source-stage-";
const PACKAGE_DIR: &str = "package";
const OWNERSHIP_MARKER: &str = ".ticketd-source-install";

/// A device-local extension registration. Connections keep their own settings.
#[derive(Serialize, Clone)]
pub struct RegisteredExtension {
    pub id: String,
    pub version: String,
    pub path: PathBuf,
    pub development: bool,
    pub hosts: Vec<String>,
    /// The program and arguments as the manifest names them, such as `node dist/index.js`.
    pub command: String,
    /// The folder an installed extension was added from, when it is known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<PathBuf>,
}

/// An installed extension and whether it still matches what was approved.
#[derive(Serialize, Clone)]
pub struct ExtensionState {
    #[serde(flatten)]
    pub extension: RegisteredExtension,
    /// Its files changed or are missing, so it stays stopped until it is added again.
    pub stopped: bool,
    /// Installed with the app itself rather than added by a person.
    pub bundled: bool,
}

/// The program and arguments given to the OS after consent.
#[derive(Serialize, Clone)]
pub struct ExtensionConsent {
    pub extension: RegisteredExtension,
    pub executable: PathBuf,
    pub args: Vec<String>,
}

/// Snapshot offered for approval. It cannot be modified through the original folder.
pub struct PreparedExtension {
    consent: ExtensionConsent,
    launch: Launch,
    staging: tempfile::TempDir,
}

impl PreparedExtension {
    pub fn consent(&self) -> &ExtensionConsent {
        &self.consent
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Manifest {
    pub id: String,
    pub version: String,
    executable: PathBuf,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: Vec<String>,
    #[serde(default)]
    hosts: Vec<String>,
}

impl Manifest {
    fn validate(&self) -> Result<(), SourceError> {
        let reserved = [
            "local",
            "list",
            "add",
            "publish",
            "resolve",
            "take-ownership",
            "extension",
            "conformance",
        ];
        if !valid_id(&self.id) || reserved.contains(&self.id.as_str()) {
            return Err(SourceError::Protocol(
                "the manifest needs a unique lower-case provider ID made of letters, digits and hyphens".into()
            ));
        }
        if self.version.trim().is_empty()
            || self.version.len() > 100
            || self.version.chars().any(char::is_control)
        {
            return Err(SourceError::Protocol("the manifest needs a version".into()));
        }
        if self.executable.as_os_str().is_empty()
            || self
                .executable
                .components()
                .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
            || !self
                .executable
                .components()
                .any(|part| matches!(part, Component::Normal(_)))
        {
            return Err(SourceError::Protocol(
                "the manifest executable must be a PATH command or a path inside its folder".into(),
            ));
        }
        if self.env.iter().any(|name| {
            name.is_empty()
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        }) {
            return Err(SourceError::Protocol(
                "the manifest contains an invalid environment variable name".into(),
            ));
        }
        if self.hosts.iter().any(|host| {
            host.is_empty()
                || host.chars().any(char::is_whitespace)
                || url::Host::parse(host).is_err()
        }) {
            return Err(SourceError::Protocol(
                "the manifest hosts must be host names or IP addresses".into(),
            ));
        }
        if self.args.iter().any(|arg| arg.contains('\0')) {
            return Err(SourceError::Protocol(
                "the manifest arguments cannot contain a NUL byte".into(),
            ));
        }
        Ok(())
    }

    /// The program and its arguments in one line, quoting any that hold a space.
    fn command_line(&self) -> String {
        std::iter::once(self.executable.display().to_string())
            .chain(self.args.iter().map(|arg| {
                if arg.is_empty() || arg.contains(char::is_whitespace) {
                    format!("{arg:?}")
                } else {
                    arg.clone()
                }
            }))
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub(super) fn read(folder: &Path) -> Result<Self, SourceError> {
        let manifest: Self = serde_json::from_slice(
            &read_limited(&folder.join(MANIFEST), MANIFEST_LIMIT).map_err(storage_error)?,
        )
        .map_err(|error| SourceError::Protocol(format!("invalid {MANIFEST}: {error}")))?;
        manifest.validate()?;
        if Engine::builtin().descriptor(&manifest.id).is_ok() {
            return Err(SourceError::Protocol(
                "the extension ID belongs to a built-in ticket source".into(),
            ));
        }
        Ok(manifest)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub(super) struct Launch {
    pub manifest: Manifest,
    folder: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    development_generation: Option<uuid::Uuid>,
    #[serde(default)]
    mode: LaunchMode,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
enum LaunchMode {
    #[default]
    Development,
    Installed {
        hash: String,
        executable: PathBuf,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        bundled: bool,
        /// The folder the person added it from, shown on its page.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<PathBuf>,
    },
}

impl Launch {
    pub(super) fn load(path: &Path) -> Result<Self, SourceError> {
        let folder = path.canonicalize().map_err(storage_error)?;
        Ok(Self {
            manifest: Manifest::read(&folder)?,
            folder,
            development_generation: Some(uuid::Uuid::new_v4()),
            mode: LaunchMode::Development,
        })
    }

    fn registration(&self) -> RegisteredExtension {
        RegisteredExtension {
            id: self.manifest.id.clone(),
            version: self.manifest.version.clone(),
            path: self.folder.clone(),
            development: self.is_development(),
            hosts: self.manifest.hosts.clone(),
            command: self.manifest.command_line(),
            origin: match &self.mode {
                LaunchMode::Installed { origin, .. } => origin.clone(),
                LaunchMode::Development => None,
            },
        }
    }

    fn is_development(&self) -> bool {
        matches!(self.mode, LaunchMode::Development)
    }

    pub(super) fn is_installed(&self) -> bool {
        matches!(self.mode, LaunchMode::Installed { .. })
    }

    pub(super) fn verify_trust(&self) -> Result<(), SourceError> {
        let LaunchMode::Installed { hash, .. } = &self.mode else {
            return Ok(());
        };
        if self.folder.canonicalize().as_deref().ok() == Some(self.folder.as_path())
            && folder_digest(&self.folder).is_ok_and(|actual| &actual == hash)
        {
            return Ok(());
        }
        Err(SourceError::NotSent(format!(
            "installed source extension '{}' changed or is missing; add it again to approve the folder",
            self.manifest.id
        )))
    }

    pub(super) fn command(&self) -> Result<Command, SourceError> {
        let executable = match &self.mode {
            LaunchMode::Installed { executable, .. } => executable.clone(),
            LaunchMode::Development => {
                let executable = &self.manifest.executable;
                if executable.file_name() == Some(executable.as_os_str()) {
                    executable.clone()
                } else {
                    self.folder.join(executable)
                }
            }
        };
        let mut command = Command::new(executable);
        command
            .args(&self.manifest.args)
            .current_dir(&self.folder)
            .env_clear()
            .envs(std::env::vars_os().filter(|(key, _)| allowed_env(key, &self.manifest.env)));
        if !self.folder.is_dir() {
            return Err(SourceError::NotSent(format!(
                "the linked source extension folder is missing: {}; link it again",
                self.folder.display()
            )));
        }
        Ok(command)
    }

    pub(super) fn redact_environment(&self, command: &Command, redactions: &Redactions) {
        for (key, value) in command.as_std().get_envs() {
            let (Some(key), Some(value)) = (key.to_str(), value.and_then(OsStr::to_str)) else {
                continue;
            };
            if declared_env(key, &self.manifest.env) {
                redactions.register_for_logs([value]);
            }
            if proxy_env(&key.to_ascii_uppercase())
                && let Ok(url) = url::Url::parse(value)
                && let Some(password) = url.password()
            {
                redactions.register([value, password]);
                if let Ok(decoded) = percent_decode_str(password).decode_utf8() {
                    redactions.register([decoded.as_ref()]);
                }
            }
        }
    }
}

fn allowed_env(name: &OsStr, declared: &[String]) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let upper = name.to_ascii_uppercase();
    if upper.starts_with("TICKETD_") {
        return false;
    }
    let allowed = [
        "HOME",
        "USER",
        "LOGNAME",
        "PATH",
        "SHELL",
        "TERM",
        "LANG",
        "LANGUAGE",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SYSTEMROOT",
        "WINDIR",
        "USERPROFILE",
    ];
    upper.starts_with("LC_")
        || allowed.contains(&upper.as_str())
        || proxy_env(&upper)
        || declared_env(name, declared)
}

fn proxy_env(upper: &str) -> bool {
    matches!(
        upper,
        "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY" | "NO_PROXY"
    )
}

fn declared_env(name: &str, declared: &[String]) -> bool {
    declared.iter().any(|variable| {
        if cfg!(windows) {
            variable.eq_ignore_ascii_case(name)
        } else {
            variable == name
        }
    })
}

#[derive(Deserialize, Serialize)]
struct Record {
    launch: Launch,
    hello: Description,
}

struct Cache {
    files: BTreeMap<PathBuf, Vec<u8>>,
    engine: Engine,
    development: BTreeSet<String>,
}

/// Holds connector registrations and subprocess sessions for one ticketd
/// process. Construct one on desktop and one for the duration of a CLI command.
pub struct ExtensionRegistry {
    folder: PathBuf,
    host: Arc<Host>,
    cache: Mutex<Cache>,
}

impl ExtensionRegistry {
    /// The device's registry sits beside its default Workspace file.
    pub fn device() -> Result<Self, crate::Error> {
        let workspace = crate::default_workspace_path()?;
        let folder = workspace.parent().unwrap_or_else(|| Path::new("."));
        #[cfg(debug_assertions)]
        let path = std::env::var_os("TICKETD_SOURCE_EXTENSIONS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| folder.join("extensions"));
        #[cfg(not(debug_assertions))]
        let path = folder.join("extensions");
        let registry = Self::new(path);
        #[cfg(debug_assertions)]
        if std::env::var_os("TICKETD_TEST_WORKSPACE").is_some() {
            registry.set_log_dir(&folder.join("logs"));
            return Ok(registry);
        }
        if let Some(dirs) = directories::BaseDirs::new() {
            // Match the desktop's Tauri log folder so its export can include
            // operations performed by the CLI.
            let identifier = "com.vantoan19.ticketd";
            let logs = if cfg!(target_os = "macos") {
                dirs.home_dir().join("Library/Logs").join(identifier)
            } else {
                dirs.data_local_dir().join(identifier).join("logs")
            };
            registry.set_log_dir(&logs);
        }
        Ok(registry)
    }

    /// Use the same local log directory as the desktop diagnostics host.
    pub fn set_log_dir(&self, path: &Path) {
        self.host.set_log_dir(path);
    }

    /// An explicit registry path is also useful for isolated development fixtures.
    pub fn new(folder: PathBuf) -> Self {
        Self {
            folder,
            host: Arc::new(Host::default()),
            cache: Mutex::new(Cache {
                files: BTreeMap::new(),
                engine: Engine::builtin(),
                development: BTreeSet::new(),
            }),
        }
    }

    /// Lists cached metadata without asking subprocesses to start. A link made
    /// by a CLI while the desktop is open is visible on the next list.
    pub fn engine(&self) -> Result<Engine, SourceError> {
        let mut cache = self.cache.lock().unwrap_or_else(|error| error.into_inner());
        let files = registry_files(&self.folder)?;
        if files != cache.files {
            let mut engine = Engine::builtin();
            let mut development = BTreeSet::new();
            for (path, bytes) in &files {
                let result: Result<_, SourceError> = (|| {
                    let record = decode_record(path.file_stem().and_then(OsStr::to_str), bytes)?;
                    let id = record.launch.manifest.id.clone();
                    let development = record.launch.is_development();
                    engine.register(self.connector(record)?)?;
                    Ok((id, development))
                })();
                match result {
                    Ok((id, true)) => {
                        development.insert(id);
                    }
                    Ok((_, false)) => {}
                    Err(error) => {
                        tracing::warn!(error_kind = error.code(), "could not load source extension")
                    }
                }
            }
            *cache = Cache {
                files,
                engine,
                development,
            };
        }
        Ok(cache.engine.clone())
    }

    pub fn is_development(&self, provider: &str) -> bool {
        self.cache
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .development
            .contains(provider)
    }

    /// Runs read-only checks and, with an explicit destination, one publication.
    pub fn conformance(
        &self,
        provider: &str,
        raw: &ConfigValues,
        options: &ConformanceOptions,
    ) -> Result<ConformanceReport, SourceError> {
        let engine = self.engine()?;
        let record = self.read_record(provider)?;
        record.launch.verify_trust()?;
        let probe = Host::default();
        let refusal = probe.probe(Arc::new(record.launch), &[0]).and_then(|hello| {
            if ticketd_source_sdk::conformance::refused_version(&hello, 0, CONTRACT_VERSION) {
                Ok(())
            } else {
                Err(SourceError::Protocol(format!(
                    "the extension accepted an unsupported contract or did not list contract {CONTRACT_VERSION}"
                )))
            }
        });
        probe.shutdown();
        conformance::run(&engine, provider, raw, refusal, options)
    }

    pub fn retry(&self, connection_id: &str) {
        self.host.retry(connection_id);
    }

    pub fn shutdown(&self) {
        self.host.shutdown();
    }

    /// Register a development folder after a successful handshake.
    pub fn link(&self, path: &Path) -> Result<RegisteredExtension, SourceError> {
        let launch = Launch::load(path)?;
        let _lock = self.lock()?;
        if self
            .read_record(&launch.manifest.id)
            .is_ok_and(|record| record.launch.is_installed())
        {
            return Err(SourceError::NotSent(
                "this source extension is installed; remove it before linking a development folder"
                    .into(),
            ));
        }
        let result = launch.registration();
        self.probe_and_record(launch)?;
        Ok(result)
    }

    /// Copy and inspect a package without executing it or registering it.
    pub fn prepare_add(&self, path: &Path) -> Result<PreparedExtension, SourceError> {
        let source = path.canonicalize().map_err(storage_error)?;
        let staging = tempfile::tempdir().map_err(storage_error)?;
        let staging_path = staging.path().canonicalize().map_err(storage_error)?;
        let package = staging_path.join(PACKAGE_DIR);
        if staging_path.starts_with(&source) {
            return Err(SourceError::Protocol("cannot install this extension folder because it contains the system temporary directory".into()));
        }
        copy_package(&source, &package).map_err(storage_error)?;
        let manifest = Manifest::read(&package)?;
        fs::create_dir_all(&self.folder).map_err(storage_error)?;
        let registry = self.folder.canonicalize().map_err(storage_error)?;
        let folder = registry
            .join(format!(
                "{PACKAGE_PREFIX}{}.{}",
                manifest.id,
                uuid::Uuid::new_v4()
            ))
            .join(PACKAGE_DIR);
        let executable = installed_executable(&manifest, &source, &package, &registry, &folder)?;
        let launch = Launch {
            manifest,
            folder,
            development_generation: None,
            mode: LaunchMode::Installed {
                hash: folder_digest(&package).map_err(storage_error)?,
                executable: executable.clone(),
                bundled: false,
                origin: Some(source.clone()),
            },
        };
        let consent = ExtensionConsent {
            extension: launch.registration(),
            executable,
            args: launch.manifest.args.clone(),
        };
        Ok(PreparedExtension {
            consent,
            launch,
            staging,
        })
    }

    /// Activate the approved copy. Keep the previous package and registration
    /// usable if the new package cannot complete its handshake.
    pub fn add(&self, prepared: PreparedExtension) -> Result<RegisteredExtension, SourceError> {
        let _lock = self.lock()?;
        self.activate(prepared, None)
    }

    /// Install a sidecar supplied by the trusted application as an ordinary
    /// hashed package. Its description is available without launching it.
    pub fn install_bundled(
        &self,
        sidecar: &Path,
        version: &str,
        description: super::SourceDescription,
    ) -> Result<(), SourceError> {
        match sidecar.symlink_metadata() {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => {
                return Err(SourceError::Protocol(
                    "the bundled source executable is not a regular file".into(),
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(storage_error(error)),
        }
        let executable = sidecar.file_name().ok_or_else(|| {
            SourceError::Protocol("the bundled source executable has no name".into())
        })?;
        let _lock = self.lock()?;
        match self.read_record(&description.descriptor.provider) {
            Ok(record) => {
                let bundled = matches!(
                    record.launch.mode,
                    LaunchMode::Installed { bundled: true, .. }
                );
                if !bundled || record.launch.manifest.version == version {
                    return Ok(());
                }
            }
            Err(SourceError::UnknownProvider(_)) => {}
            Err(error) => return Err(error),
        }
        let manifest = Manifest {
            id: description.descriptor.provider.clone(),
            version: version.into(),
            executable: PathBuf::from(".").join(executable),
            args: Vec::new(),
            env: Vec::new(),
            hosts: description.presentation.hosts.clone(),
        };
        let original = tempfile::tempdir().map_err(storage_error)?;
        fs::copy(sidecar, original.path().join(executable)).map_err(storage_error)?;
        let manifest = serde_json::to_vec(&manifest).map_err(|_| {
            SourceError::Protocol("could not encode the bundled source manifest".into())
        })?;
        fs::write(original.path().join(MANIFEST), manifest).map_err(storage_error)?;
        let mut prepared = self.prepare_add(original.path())?;
        if let LaunchMode::Installed {
            bundled, origin, ..
        } = &mut prepared.launch.mode
        {
            *bundled = true;
            *origin = None;
        }
        let hello = Description {
            contract_versions: vec![CONTRACT_VERSION],
            contract_version: Some(CONTRACT_VERSION),
            version: version.into(),
            description: Some(description),
        };
        self.activate(prepared, Some(hello)).map(|_| ())
    }

    /// The caller holds the registry lock from approval through the record write.
    fn activate(
        &self,
        prepared: PreparedExtension,
        cached: Option<Description>,
    ) -> Result<RegisteredExtension, SourceError> {
        let registry = self.folder.canonicalize().map_err(storage_error)?;
        let PreparedExtension {
            consent,
            launch,
            staging,
        } = prepared;
        let Some(destination) = launch
            .folder
            .parent()
            .filter(|path| path.parent() == Some(&registry))
            .map(Path::to_path_buf)
        else {
            return Err(SourceError::Protocol(
                "the extension was prepared for another registry".into(),
            ));
        };
        let id = launch.manifest.id.clone();
        let previous = match self.read_record(&id) {
            Ok(record) => Some(record),
            Err(SourceError::UnknownProvider(_)) => None,
            Err(error) => return Err(error),
        };
        match destination.symlink_metadata() {
            Ok(_) => {
                return Err(SourceError::NotSent(
                    "the source extension install path is already occupied".into(),
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(storage_error(error)),
        }
        // Move ownership and the approved copy into place together. The
        // marker stays outside the package whose digest the person approved.
        let transaction = tempfile::Builder::new()
            .prefix(STAGING_PREFIX)
            .tempdir_in(&registry)
            .map_err(storage_error)?;
        File::create_new(transaction.path().join(OWNERSHIP_MARKER)).map_err(storage_error)?;
        let package = transaction.path().join(PACKAGE_DIR);
        copy_package(&staging.path().join(PACKAGE_DIR), &package).map_err(storage_error)?;
        fs::rename(transaction.path(), &destination).map_err(storage_error)?;
        let _ = transaction.keep();
        let install = match cached {
            Some(hello) => self.write_record(launch, hello),
            None => self.probe_and_record(launch),
        };
        if let Err(error) = install {
            remove_package(&destination);
            return Err(error);
        }
        if let Some(record) = previous {
            self.remove_legacy_package(&record);
        }
        self.reap_packages();
        Ok(consent.extension)
    }

    pub fn list(&self) -> Result<Vec<RegisteredExtension>, SourceError> {
        registry_files(&self.folder)?
            .into_iter()
            .map(|(path, bytes)| {
                Ok(
                    decode_record(path.file_stem().and_then(OsStr::to_str), &bytes)?
                        .launch
                        .registration(),
                )
            })
            .collect()
    }

    /// Every registered extension and whether it still matches what was approved.
    /// An installed folder is hashed, so this reads its files.
    pub fn states(&self) -> Result<Vec<ExtensionState>, SourceError> {
        registry_files(&self.folder)?
            .into_iter()
            .map(|(path, bytes)| {
                let launch =
                    decode_record(path.file_stem().and_then(OsStr::to_str), &bytes)?.launch;
                let bundled = matches!(launch.mode, LaunchMode::Installed { bundled: true, .. });
                Ok(ExtensionState {
                    stopped: !bundled && launch.verify_trust().is_err(),
                    bundled,
                    extension: launch.registration(),
                })
            })
            .collect()
    }

    pub fn remove(&self, id: &str) -> Result<(), SourceError> {
        let _lock = self.lock()?;
        let record = self.read_record(id)?;
        // The atomic record update is authoritative. Deleting its package first
        // would let an interrupted removal strand a registered extension.
        fs::remove_file(self.folder.join(format!("{id}.json"))).map_err(storage_error)?;
        self.remove_legacy_package(&record);
        self.reap_packages();
        Ok(())
    }

    fn lock(&self) -> Result<File, SourceError> {
        let lock = registry_lock(&self.folder)?;
        self.reap_packages();
        Ok(lock)
    }

    /// Only called while holding the registry lock. A damaged or unreadable
    /// registration leaves its package in place for a later recovery.
    fn reap_packages(&self) {
        let Ok(folder) = self.folder.canonicalize() else {
            return;
        };
        let Ok(entries) = fs::read_dir(&folder) else {
            return;
        };
        let mut registered = Vec::new();
        let mut owned = Vec::new();
        for entry in entries {
            let Ok(entry) = entry else {
                return;
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if let Some(id) = name.strip_suffix(".json").filter(|id| valid_id(id)) {
                match self.read_record(id) {
                    Ok(record) => registered.push(record.launch.folder),
                    Err(SourceError::UnknownProvider(_)) => (),
                    Err(_) => return,
                }
            } else if (name.starts_with(STAGING_PREFIX) || package_provider(name).is_some())
                && entry
                    .path()
                    .join(OWNERSHIP_MARKER)
                    .symlink_metadata()
                    .is_ok_and(|metadata| metadata.is_file())
            {
                owned.push(entry.path());
            }
        }
        for path in owned {
            if !registered
                .iter()
                .any(|registered| registered.starts_with(&path))
            {
                remove_package(&path);
            }
        }
    }

    fn remove_legacy_package(&self, record: &Record) {
        if let Ok(folder) = self.folder.canonicalize() {
            let legacy = folder.join(&record.launch.manifest.id);
            if record.launch.is_installed() && record.launch.folder == legacy {
                remove_package(&legacy);
            }
        }
    }

    fn read_record(&self, id: &str) -> Result<Record, SourceError> {
        if !valid_id(id) {
            return Err(SourceError::UnknownProvider(id.to_owned()));
        }
        let path = self.folder.join(format!("{id}.json"));
        let bytes = read_limited(&path, RECORD_LIMIT).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                SourceError::UnknownProvider(id.to_owned())
            } else {
                storage_error(error)
            }
        })?;
        decode_record(Some(id), &bytes)
    }

    fn probe_and_record(&self, launch: Launch) -> Result<(), SourceError> {
        let probe = Host::default();
        let hello = probe.probe(Arc::new(launch.clone()), &[CONTRACT_VERSION])?;
        probe.shutdown();
        self.write_record(launch, hello)
    }

    fn write_record(&self, launch: Launch, hello: Description) -> Result<(), SourceError> {
        launch.verify_trust()?;
        let record_path = self.folder.join(format!("{}.json", launch.manifest.id));
        let mut validation = Engine::builtin();
        let record = Record { launch, hello };
        let bytes = serde_json::to_vec(&record).map_err(|error| {
            SourceError::Protocol(format!(
                "could not cache the extension description: {error}"
            ))
        })?;
        if bytes.len() as u64 > RECORD_LIMIT {
            return Err(SourceError::Protocol(
                "the extension description is too large".into(),
            ));
        }
        validation.register(self.connector(record)?)?;
        fs::create_dir_all(&self.folder).map_err(storage_error)?;
        let mut file = tempfile::NamedTempFile::new_in(&self.folder).map_err(storage_error)?;
        file.write_all(&bytes).map_err(storage_error)?;
        file.as_file().sync_all().map_err(storage_error)?;
        file.persist(&record_path)
            .map_err(|error| storage_error(error.error))?;
        Ok(())
    }

    fn connector(&self, record: Record) -> Result<Box<dyn super::Connector>, SourceError> {
        record.launch.manifest.validate()?;
        validate_handshake(&record.launch, &record.hello)?;
        let mut description = record.hello.description.clone().ok_or_else(|| {
            SourceError::Protocol("the extension did not provide its description".into())
        })?;
        if description
            .presentation
            .icon_svg
            .as_ref()
            .is_some_and(|icon| icon.len() > 16_384)
        {
            return Err(SourceError::Protocol(
                "the extension icon exceeds the size limit".into(),
            ));
        }
        if [Capability::Discover, Capability::Fetch]
            .iter()
            .any(|capability| !description.descriptor.capabilities.contains(capability))
        {
            return Err(SourceError::Protocol(
                "the extension must support discover and fetch".into(),
            ));
        }
        // Consent and Settings use the same manifest declarations.
        description
            .presentation
            .hosts
            .clone_from(&record.launch.manifest.hosts);
        Ok(Box::new(ProcessConnector {
            definition: Definition {
                launch: Arc::new(record.launch),
                cached: Some(Arc::new(record.hello)),
            },
            description,
            connection_id: None,
            credentials: Default::default(),
            permitted_env: None,
            workflow_credentials: None,
            host: self.host.clone(),
            refresh: None,
        }))
    }
}

impl Drop for ExtensionRegistry {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn storage_error(error: io::Error) -> SourceError {
    SourceError::Protocol(format!(
        "could not read or update the source extension registry: {error}"
    ))
}

pub(super) fn read_limited(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::other(
            "source extension file exceeds the size limit",
        ));
    }
    Ok(bytes)
}

fn registry_files(folder: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>, SourceError> {
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(storage_error(error)),
    };
    let mut files = BTreeMap::new();
    for entry in entries {
        let entry = entry.map_err(storage_error)?;
        let path = entry.path();
        if path.extension() == Some(OsStr::new("json"))
            && entry.file_type().map_err(storage_error)?.is_file()
        {
            match read_limited(&path, RECORD_LIMIT) {
                Ok(bytes) => {
                    files.insert(path, bytes);
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => tracing::warn!(%error, "could not read linked source extension"),
            }
        }
    }
    Ok(files)
}

fn decode_record(id: Option<&str>, bytes: &[u8]) -> Result<Record, SourceError> {
    let record: Record = serde_json::from_slice(bytes)
        .map_err(|_| SourceError::Protocol("invalid source extension record".into()))?;
    record.launch.manifest.validate()?;
    if id != Some(record.launch.manifest.id.as_str()) {
        return Err(SourceError::Protocol(
            "the source extension record has the wrong ID".into(),
        ));
    }
    Ok(record)
}

fn valid_id(id: &str) -> bool {
    id.len() <= 64
        && id.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !id.ends_with('-')
}

fn registry_lock(folder: &Path) -> Result<File, SourceError> {
    fs::create_dir_all(folder).map_err(storage_error)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(folder.join(".registry.lock"))
        .map_err(storage_error)?;
    FileExt::lock_exclusive(&file).map_err(storage_error)?;
    Ok(file)
}

fn package_provider(name: &str) -> Option<&str> {
    let (provider, generation) = name.strip_prefix(PACKAGE_PREFIX)?.split_once('.')?;
    (valid_id(provider) && uuid::Uuid::parse_str(generation).is_ok()).then_some(provider)
}

fn remove_package(path: &Path) {
    // Never follow a link or remove anything outside the registry. In-use
    // folders on Windows can be reclaimed by the next registry mutation.
    if let Ok(metadata) = path.symlink_metadata()
        && metadata.is_dir()
        && !metadata.is_symlink()
        && let Err(error) = fs::remove_dir_all(path)
        && error.kind() != io::ErrorKind::NotFound
    {
        tracing::debug!("could not remove an unused source extension package");
    }
}

fn installed_executable(
    manifest: &Manifest,
    source: &Path,
    package: &Path,
    registry: &Path,
    destination: &Path,
) -> Result<PathBuf, SourceError> {
    let name = &manifest.executable;
    let missing = || {
        SourceError::NotSent(format!(
            "could not find the extension executable {:?} in its folder or on PATH",
            name
        ))
    };
    if let Some(executable) = executable_file(&package.join(name)) {
        let relative = executable.strip_prefix(package).map_err(|_| missing())?;
        return Ok(destination.join(relative));
    }
    if name.file_name() != Some(name.as_os_str()) {
        return Err(missing());
    }

    // A PATH executable is an external runtime such as Node. Resolve it now
    // so neither a later PATH change nor a file outside the copied package
    // added to its original folder can change the program we approved.
    let path = std::env::var_os("PATH").ok_or_else(missing)?;
    let executable = std::env::split_paths(&path)
        .filter(|directory| directory.is_absolute())
        .find_map(|directory| executable_file(&directory.join(name)))
        .ok_or_else(missing)?;
    if executable.starts_with(source) || executable.starts_with(registry) {
        return Err(SourceError::Protocol(
            "a PATH executable inside an extension folder must be included in the copied package"
                .into(),
        ));
    }
    Ok(executable)
}

fn executable_file(path: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    let default_executable = path
        .extension()
        .is_none()
        .then(|| path.with_extension("exe"));
    #[cfg(windows)]
    let path = default_executable.as_deref().unwrap_or(path);
    #[cfg(windows)]
    if !path
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    metadata
        .is_file()
        .then(|| path.canonicalize().ok())
        .flatten()
}

fn package_entry(metadata: &fs::Metadata) -> io::Result<()> {
    let kind = metadata.file_type();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & REPARSE_POINT != 0 {
            return Err(io::Error::other(
                "extension folders cannot contain reparse points",
            ));
        }
    }
    if kind.is_file() || kind.is_dir() {
        Ok(())
    } else {
        Err(io::Error::other(
            "extension folders cannot contain symlinks or special files",
        ))
    }
}

fn copy_package(from: &Path, to: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(from)?;
    package_entry(&metadata)?;
    if metadata.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_package(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else {
        fs::copy(from, to)?;
    }
    Ok(())
}

pub(super) fn folder_digest(folder: &Path) -> io::Result<String> {
    fn visit(path: &Path, digest: &mut Sha256) -> io::Result<()> {
        let metadata = fs::symlink_metadata(path)?;
        package_entry(&metadata)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            digest.update(metadata.permissions().mode().to_le_bytes());
        }
        if metadata.is_dir() {
            digest.update(b"d");
            let mut entries = fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
            entries.sort_unstable_by_key(fs::DirEntry::file_name);
            for entry in entries {
                let name: OsString = entry.file_name();
                let name = name.as_encoded_bytes();
                digest.update((name.len() as u64).to_le_bytes());
                digest.update(name);
                visit(&entry.path(), digest)?;
            }
            digest.update(b"e");
        } else {
            digest.update(b"f");
            // Hash the bytes independently so the following path cannot
            // be mistaken for part of this file.
            let mut content = Sha256::new();
            io::copy(&mut File::open(path)?, &mut content)?;
            digest.update(content.finalize());
        }
        Ok(())
    }

    let mut digest = Sha256::new();
    visit(folder, &mut digest)?;
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod bundled_tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn unused_package_generations_do_not_replace_the_installed_copy() {
        let root = tempfile::tempdir().unwrap();
        let registry = ExtensionRegistry::new(root.path().join("registry"));
        let sidecar = root
            .path()
            .join(format!("fixture-source{}", std::env::consts::EXE_SUFFIX));
        fs::write(&sidecar, "first generation").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let description = fixture_description();
        registry
            .install_bundled(&sidecar, "1.0.0", description.clone())
            .unwrap();
        let installed = registry.list().unwrap().remove(0);
        let abandoned = registry.folder.join(format!(
            "{PACKAGE_PREFIX}fixture-source.{}",
            uuid::Uuid::new_v4()
        ));
        let unowned = registry.folder.join(format!(
            "{PACKAGE_PREFIX}fixture-source.{}",
            uuid::Uuid::new_v4()
        ));
        let abandoned_copy = registry.folder.join(format!("{STAGING_PREFIX}interrupted"));
        fs::create_dir_all(&abandoned_copy).unwrap();
        File::create_new(abandoned_copy.join(OWNERSHIP_MARKER)).unwrap();
        fs::create_dir(&abandoned).unwrap();
        File::create_new(abandoned.join(OWNERSHIP_MARKER)).unwrap();
        copy_package(&installed.path, &abandoned.join(PACKAGE_DIR)).unwrap();
        copy_package(&installed.path, &unowned).unwrap();

        // Simulate exiting after the new package was copied, before committing
        // its registration. A second registry must still use the prior copy.
        drop(registry);
        let registry = ExtensionRegistry::new(root.path().join("registry"));
        assert_eq!(registry.list().unwrap()[0].path, installed.path);
        registry
            .read_record("fixture-source")
            .unwrap()
            .launch
            .verify_trust()
            .unwrap();
        registry
            .install_bundled(&sidecar, "1.0.0", description.clone())
            .unwrap();
        assert!(!abandoned.exists());
        assert!(!abandoned_copy.exists());
        assert!(unowned.join(MANIFEST).is_file());

        fs::write(&sidecar, "second generation").unwrap();
        registry
            .install_bundled(&sidecar, "2.0.0", description)
            .unwrap();
        let upgraded = registry.list().unwrap().remove(0);
        assert_eq!(upgraded.version, "2.0.0");
        assert_ne!(upgraded.path, installed.path);
        assert!(!installed.path.exists());
    }

    #[test]
    fn redacts_both_proxy_password_representations() {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/source-extension");
        let launch = Launch::load(&folder).unwrap();
        let mut command = Command::new("unused");
        command.env("HTTPS_PROXY", "http://fixture:proxy%2Bpass@127.0.0.1:8080");
        let redactions = Redactions::default();
        launch.redact_environment(&command, &redactions);
        assert_eq!(
            redactions.text("proxy%2Bpass / proxy+pass"),
            "[redacted] / [redacted]"
        );
    }

    fn fixture_description() -> crate::source::SourceDescription {
        crate::source::SourceDescription {
            descriptor: crate::source::ConnectorDescriptor {
                provider: "fixture-source".into(),
                name: "Fixture Source".into(),
                contract_version: CONTRACT_VERSION,
                capabilities: vec![Capability::Discover, Capability::Fetch],
                schema: crate::source::ConfigSchema { fields: vec![] },
            },
            presentation: crate::source::SourcePresentation::default(),
        }
    }

    #[test]
    fn lists_bundled_metadata_before_the_executable_runs() {
        let root = tempfile::tempdir().unwrap();
        let registry = ExtensionRegistry::new(root.path().join("registry"));
        let name = format!("fixture-source{}", std::env::consts::EXE_SUFFIX);
        let sidecar = root.path().join(&name);
        fs::write(&sidecar, "not an executable").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // The registry checks the mode, while the invalid bytes prove it never launches.
            fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let description = fixture_description();

        registry
            .install_bundled(&sidecar, "1.0.0", description.clone())
            .unwrap();

        let registrations = registry.list().unwrap();
        assert_eq!(registrations.len(), 1);
        assert_eq!(registrations[0].id, "fixture-source");
        assert!(!registrations[0].development);
        assert_eq!(
            registry
                .engine()
                .unwrap()
                .descriptor("fixture-source")
                .unwrap()
                .name,
            "Fixture Source"
        );

        let installed = registrations[0].path.join(name);
        fs::write(&installed, "changed after installation").unwrap();
        registry
            .install_bundled(&sidecar, "1.0.0", description)
            .unwrap();
        assert!(
            registry
                .read_record("fixture-source")
                .unwrap()
                .launch
                .verify_trust()
                .is_err()
        );
    }
}
