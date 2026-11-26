//! Adding an extension from a person's folder: why a folder is refused before
//! anything is shown, and the one approval the app and the CLI both end in.

use std::{path::Path, sync::Mutex};

use serde::Serialize;

use super::registry::{
    ExtensionConsent, ExtensionRegistry, MANIFEST, MANIFEST_LIMIT, Manifest, PreparedExtension,
    RegisteredExtension, read_limited,
};
use crate::source::SourceError;

/// What the manifest of this version of ticketd can say. A folder with anything
/// else was written for a newer ticketd.
const KNOWN_FIELDS: [&str; 6] = ["id", "version", "executable", "args", "env", "hosts"];

/// Why a folder cannot be added. Said before any consent, because nothing in
/// the folder has been run and there is nothing to approve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum FolderRefusal {
    /// The chosen path is not a folder.
    NotAFolder,
    /// There is no `ticketd-source.json` in it.
    NoManifest,
    /// Its manifest uses fields this ticketd does not know.
    NeedsNewerTicketd,
    /// The manifest is there but cannot be used; the message says what to fix.
    Invalid { message: String },
}

impl FolderRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotAFolder => "not_a_folder",
            Self::NoManifest => "no_manifest",
            Self::NeedsNewerTicketd => "needs_newer_ticketd",
            Self::Invalid { .. } => "invalid_manifest",
        }
    }
}

impl std::fmt::Display for FolderRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAFolder => write!(formatter, "This isn't a folder"),
            Self::NoManifest => write!(formatter, "This folder has no {MANIFEST}"),
            Self::NeedsNewerTicketd => write!(formatter, "It needs a newer ticketd"),
            Self::Invalid { message } => write!(formatter, "{MANIFEST} can't be used: {message}"),
        }
    }
}

impl std::error::Error for FolderRefusal {}

/// The sentence inside the error, without the prefix its kind adds.
fn message(error: &SourceError) -> String {
    match error {
        SourceError::Protocol(message) | SourceError::NotSent(message) => message.clone(),
        other => other.to_string(),
    }
}

/// Reads only the manifest: runs nothing in the folder.
pub fn check_extension_folder(path: &Path) -> Result<(), FolderRefusal> {
    if !path.is_dir() {
        return Err(FolderRefusal::NotAFolder);
    }
    if !path.join(MANIFEST).is_file() {
        return Err(FolderRefusal::NoManifest);
    }
    let invalid = |text: &str| FolderRefusal::Invalid {
        message: text.into(),
    };
    let bytes = read_limited(&path.join(MANIFEST), MANIFEST_LIMIT)
        .map_err(|_| invalid("it is too large or cannot be read"))?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| invalid("it is not valid JSON"))?;
    let Some(fields) = value.as_object() else {
        return Err(invalid("it must be a JSON object"));
    };
    if fields.keys().any(|key| !KNOWN_FIELDS.contains(&key.as_str())) {
        return Err(FolderRefusal::NeedsNewerTicketd);
    }
    Manifest::read(path)
        .map(drop)
        .map_err(|error| FolderRefusal::Invalid {
            message: message(&error),
        })
}

/// What the person is asked to approve, and the token that approves exactly it.
#[derive(Serialize)]
pub struct PendingConsent {
    pub token: String,
    #[serde(flatten)]
    pub consent: ExtensionConsent,
}

/// The one folder copy the app is asking about. The copy cannot change through
/// the original folder, so approving it approves what was shown.
#[derive(Default)]
pub struct PendingExtensions {
    pending: Mutex<Option<(String, PreparedExtension)>>,
}

impl PendingExtensions {
    /// Copies and inspects the folder (running nothing) and holds it for approval.
    /// A newer request replaces an older one that was never answered.
    pub fn prepare(
        &self,
        registry: &ExtensionRegistry,
        path: &Path,
    ) -> Result<PendingConsent, AddError> {
        check_extension_folder(path)?;
        let prepared = registry.prepare_add(path).map_err(AddError::Source)?;
        let consent = ExtensionConsent {
            extension: prepared.consent().extension.clone(),
            executable: prepared.consent().executable.clone(),
            args: prepared.consent().args.clone(),
        };
        let token = uuid::Uuid::new_v4().to_string();
        *self.slot() = Some((token.clone(), prepared));
        Ok(PendingConsent { token, consent })
    }

    /// Approves what `prepare` showed, the way `ticketd source extension add` does.
    pub fn approve(
        &self,
        registry: &ExtensionRegistry,
        token: &str,
    ) -> Result<RegisteredExtension, AddError> {
        let prepared = {
            let mut slot = self.slot();
            match slot.take() {
                Some((held, prepared)) if held == token => prepared,
                other => {
                    *slot = other;
                    return Err(AddError::Expired);
                }
            }
        };
        registry.add(prepared).map_err(AddError::Source)
    }

    /// Drops the copy without registering it.
    pub fn cancel(&self, token: &str) {
        let mut slot = self.slot();
        if slot.as_ref().is_some_and(|(held, _)| held == token) {
            *slot = None;
        }
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<(String, PreparedExtension)>> {
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

/// Why an add did not finish.
#[derive(Debug)]
pub enum AddError {
    Refused(FolderRefusal),
    /// The consent being approved is not the one last shown.
    Expired,
    Source(SourceError),
}

impl From<FolderRefusal> for AddError {
    fn from(refusal: FolderRefusal) -> Self {
        Self::Refused(refusal)
    }
}

impl std::fmt::Display for AddError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(refusal) => refusal.fmt(formatter),
            Self::Expired => write!(formatter, "This request is out of date. Choose the folder again"),
            Self::Source(error) => write!(formatter, "{}", message(error)),
        }
    }
}

impl std::error::Error for AddError {}
