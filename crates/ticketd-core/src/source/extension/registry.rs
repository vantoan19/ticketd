use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    fs::{self, File},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::process::Command;

use super::{
    Capability, Definition, Host, ProcessConnector, SourceError, host::validate_handshake,
    wire::Description,
};
use crate::source::{
    CONTRACT_VERSION, ConfigValues, ConformanceOptions, ConformanceReport, Engine, conformance,
};

const MANIFEST: &str = "ticketd-source.json";
const MANIFEST_LIMIT: u64 = 16 * 1024;
const RECORD_LIMIT: u64 = 1024 * 1024;

/// What was registered by the development link command. Connections keep
/// settings elsewhere, and this record never enters a Workspace.
#[derive(Serialize)]
pub struct LinkedExtension {
    pub id: String,
    pub version: String,
    pub path: PathBuf,
    pub development: bool,
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
            "github",
            "local",
            "list",
            "add",
            "publish",
            "resolve",
            "take-ownership",
            "extension",
            "conformance",
        ];
        if self.id.len() > 64
            || !self
                .id
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_lowercase)
            || !self
                .id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || self.id.ends_with('-')
            || reserved.contains(&self.id.as_str())
        {
            return Err(SourceError::Protocol(
                "the manifest needs a unique lower-case provider ID made of letters, digits and hyphens".into()
            ));
        }
        if self.version.trim().is_empty() || self.version.len() > 100 {
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
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub(super) struct Launch {
    pub manifest: Manifest,
    folder: PathBuf,
    folder_hash: String,
}

impl Launch {
    pub(super) fn load(path: &Path) -> Result<Self, SourceError> {
        let folder = path.canonicalize().map_err(storage_error)?;
        let manifest: Manifest = serde_json::from_slice(
            &read_limited(&folder.join(MANIFEST), MANIFEST_LIMIT).map_err(storage_error)?,
        )
        .map_err(|error| SourceError::Protocol(format!("invalid {MANIFEST}: {error}")))?;
        manifest.validate()?;
        let folder_hash = folder_digest(&folder).map_err(storage_error)?;
        Ok(Self {
            manifest,
            folder,
            folder_hash,
        })
    }

    pub(super) fn command(&self) -> Result<Command, SourceError> {
        let executable = &self.manifest.executable;
        let executable = if executable.file_name() == Some(executable.as_os_str()) {
            executable.clone()
        } else {
            self.folder.join(executable)
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
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
    ];
    upper.starts_with("LC_")
        || allowed.contains(&upper.as_str())
        || declared.iter().any(|variable| {
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
        #[cfg(debug_assertions)]
        if let Some(path) = std::env::var_os("TICKETD_SOURCE_EXTENSIONS_DIR") {
            return Ok(Self::new(path.into()));
        }
        let workspace = crate::default_workspace_path()?;
        let folder = workspace.parent().unwrap_or_else(|| Path::new("."));
        Ok(Self::new(folder.join("extensions")))
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
                let result = (|| {
                    let record: Record = serde_json::from_slice(bytes).map_err(|_| {
                        SourceError::Protocol("invalid linked extension record".into())
                    })?;
                    let id = record.launch.manifest.id.clone();
                    if path.file_stem().and_then(OsStr::to_str) != Some(&id) {
                        return Err(SourceError::Protocol(
                            "the linked extension file has the wrong ID".into(),
                        ));
                    }
                    engine.register(self.connector(record)?)?;
                    Ok(id)
                })();
                match result {
                    Ok(id) => {
                        development.insert(id);
                    }
                    Err(error) => tracing::warn!(
                        error_kind = error.code(),
                        "could not load linked source extension"
                    ),
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
        if !self.is_development(provider) {
            return Err(SourceError::UnknownProvider(provider.to_owned()));
        }
        let path = self.folder.join(format!("{provider}.json"));
        let bytes = read_limited(&path, RECORD_LIMIT).map_err(storage_error)?;
        let record: Record = serde_json::from_slice(&bytes)
            .map_err(|_| SourceError::Protocol("invalid linked extension record".into()))?;
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

    /// Registers a development folder after a successful handshake. The
    /// description and the folder hash are cached in one atomic record.
    pub fn link(&self, path: &Path) -> Result<LinkedExtension, SourceError> {
        let launch = Launch::load(path)?;
        let record_path = self.folder.join(format!("{}.json", launch.manifest.id));
        let previous = read_limited(&record_path, RECORD_LIMIT)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Record>(&bytes).ok());
        let result = LinkedExtension {
            id: launch.manifest.id.clone(),
            version: launch.manifest.version.clone(),
            path: launch.folder.clone(),
            development: true,
        };
        if let Some(previous) = previous
            && previous.launch == launch
        {
            let mut validation = Engine::builtin();
            validation.register(self.connector(previous)?)?;
            return Ok(result);
        }

        // Linking is its own short probe. Its process is stopped even when
        // negotiation fails, before writing any registry data.
        let probe = Host::default();
        let hello = probe.probe(Arc::new(launch.clone()), &[CONTRACT_VERSION])?;
        probe.shutdown();
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
        Ok(result)
    }

    fn connector(&self, record: Record) -> Result<Box<dyn super::Connector>, SourceError> {
        record.launch.manifest.validate()?;
        validate_handshake(&record.launch, &record.hello)?;
        let description = record.hello.description.clone().ok_or_else(|| {
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
        Ok(Box::new(ProcessConnector {
            definition: Definition {
                launch: Arc::new(record.launch),
                cached: Some(Arc::new(record.hello)),
            },
            description,
            connection_id: None,
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

fn folder_digest(folder: &Path) -> io::Result<String> {
    fn visit(folder: &Path, digest: &mut Sha256) -> io::Result<()> {
        let mut entries = fs::read_dir(folder)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_unstable_by_key(fs::DirEntry::file_name);
        for entry in entries {
            let file_type = entry.file_type()?;
            let name: OsString = entry.file_name();
            let name = name.as_encoded_bytes();
            digest.update((name.len() as u64).to_le_bytes());
            digest.update(name);
            if file_type.is_dir() {
                digest.update(b"d");
                visit(&entry.path(), digest)?;
            } else if file_type.is_file() {
                digest.update(b"f");
                // Hash the bytes independently so the following path cannot
                // be mistaken for part of this file.
                let mut content = Sha256::new();
                io::copy(&mut File::open(entry.path())?, &mut content)?;
                digest.update(content.finalize());
            } else if file_type.is_symlink() {
                digest.update(b"s");
                digest.update(Sha256::digest(
                    fs::read_link(entry.path())?.as_os_str().as_encoded_bytes(),
                ));
            }
        }
        digest.update(b"e");
        Ok(())
    }

    let mut digest = Sha256::new();
    visit(folder, &mut digest)?;
    Ok(format!("{:x}", digest.finalize()))
}
