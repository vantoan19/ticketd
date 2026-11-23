use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

use fs2::FileExt;
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

const MANIFEST: &str = "ticketd-source.json";
const MANIFEST_LIMIT: u64 = 16 * 1024;
const RECORD_LIMIT: u64 = 1024 * 1024;

/// A device-local extension registration. Connections keep their own settings.
#[derive(Serialize)]
pub struct RegisteredExtension {
    pub id: String,
    pub version: String,
    pub path: PathBuf,
    pub development: bool,
    pub hosts: Vec<String>,
}

/// The program and arguments given to the OS after consent.
#[derive(Serialize)]
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

    fn read(folder: &Path) -> Result<Self, SourceError> {
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
    },
}

impl Launch {
    pub(super) fn load(path: &Path) -> Result<Self, SourceError> {
        let folder = path.canonicalize().map_err(storage_error)?;
        Ok(Self {
            manifest: Manifest::read(&folder)?,
            folder,
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
                redactions.register([value]);
            }
            if proxy_env(&key.to_ascii_uppercase())
                && let Ok(url) = url::Url::parse(value)
                && let Some(password) = url.password()
            {
                redactions.register([value, password]);
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
            if hello.contract_version.is_none()
                && hello.contract_versions.contains(&CONTRACT_VERSION)
                && !hello.contract_versions.contains(&0)
            {
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
        let _lock = registry_lock(&self.folder)?;
        if self
            .read_record(&launch.manifest.id)
            .is_ok_and(|record| record.launch.is_installed())
            || self
                .folder
                .join(&launch.manifest.id)
                .symlink_metadata()
                .is_ok()
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
        let package = staging_path.join("package");
        if staging_path.starts_with(&source) {
            return Err(SourceError::Protocol("cannot install this extension folder because it contains the system temporary directory".into()));
        }
        copy_package(&source, &package).map_err(storage_error)?;
        let manifest = Manifest::read(&package)?;
        fs::create_dir_all(&self.folder).map_err(storage_error)?;
        let registry = self.folder.canonicalize().map_err(storage_error)?;
        let folder = registry.join(&manifest.id);
        let executable = installed_executable(&manifest, &source, &package, &registry, &folder)?;
        let launch = Launch {
            manifest,
            folder,
            mode: LaunchMode::Installed {
                hash: folder_digest(&package).map_err(storage_error)?,
                executable: executable.clone(),
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
        let _lock = registry_lock(&self.folder)?;
        let registry = self.folder.canonicalize().map_err(storage_error)?;
        let PreparedExtension {
            consent,
            launch,
            staging,
        } = prepared;
        if launch.folder.parent() != Some(&registry) {
            return Err(SourceError::Protocol(
                "the extension was prepared for another registry".into(),
            ));
        }
        let destination = launch.folder.clone();
        if destination.symlink_metadata().is_ok()
            && !self
                .read_record(&launch.manifest.id)
                .is_ok_and(|record| record.launch.is_installed())
        {
            return Err(SourceError::NotSent(
                "the source extension install path is already occupied".into(),
            ));
        }
        // Move within one filesystem, even when the system temporary folder
        // lives on a different volume.
        let transaction = tempfile::tempdir_in(&registry).map_err(storage_error)?;
        let package = transaction.path().join("package");
        copy_package(&staging.path().join("package"), &package).map_err(storage_error)?;
        let previous = transaction.path().join("previous");
        let had_previous = move_if_present(&destination, &previous)?;
        let install = fs::rename(&package, &destination)
            .map_err(storage_error)
            .and_then(|()| self.probe_and_record(launch));
        if let Err(error) = install {
            if let Err(rollback) = restore_package(&destination, &previous, had_previous) {
                let retained = transaction.keep();
                return Err(SourceError::Protocol(format!(
                    "{error}; could not restore the previous extension: {rollback}; staged files remain in {}",
                    retained.display()
                )));
            }
            return Err(error);
        }
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

    pub fn remove(&self, id: &str) -> Result<(), SourceError> {
        let _lock = registry_lock(&self.folder)?;
        let record = self.read_record(id)?;
        let transaction = tempfile::tempdir_in(&self.folder).map_err(storage_error)?;
        let removed = transaction.path().join("removed");
        let folder = self.folder.join(id);
        let moved = record.launch.is_installed() && move_if_present(&folder, &removed)?;
        if let Err(error) = fs::remove_file(self.folder.join(format!("{id}.json"))) {
            if moved && let Err(rollback) = fs::rename(&removed, &folder) {
                let retained = transaction.keep();
                return Err(SourceError::Protocol(format!(
                    "{error}; could not restore the extension: {rollback}; staged files remain in {}",
                    retained.display()
                )));
            }
            return Err(storage_error(error));
        }
        Ok(())
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
        let record_path = self.folder.join(format!("{}.json", launch.manifest.id));
        let probe = Host::default();
        let hello = probe.probe(Arc::new(launch.clone()), &[CONTRACT_VERSION])?;
        probe.shutdown();
        launch.verify_trust()?;
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

fn read_limited(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
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

fn move_if_present(from: &Path, to: &Path) -> Result<bool, SourceError> {
    match fs::rename(from, to) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(storage_error(error)),
    }
}

fn restore_package(destination: &Path, previous: &Path, had_previous: bool) -> io::Result<()> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.is_dir() && !metadata.is_symlink() => {
            fs::remove_dir_all(destination)?
        }
        Ok(_) => fs::remove_file(destination)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    if had_previous {
        fs::rename(previous, destination)?;
    }
    Ok(())
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

fn folder_digest(folder: &Path) -> io::Result<String> {
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
