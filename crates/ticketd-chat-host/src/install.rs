//! Finding a harness the user installed. A desktop application started from a
//! launcher often has a shorter `PATH` than the user's shell, so adapters check
//! known install locations as well. Nothing here reads configuration or credentials.

use std::env;
use std::ffi::OsString;
use std::path::PathBuf;

pub(crate) type Version = (u64, u64, u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Os {
    Windows,
    Mac,
    Linux,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Linux
        }
    }
}

/// The parts of the process environment that locate an installation.
#[derive(Debug, Clone, Default)]
pub(crate) struct LaunchEnvironment {
    pub path: Option<OsString>,
    pub home: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub roaming_app_data: Option<PathBuf>,
}

impl LaunchEnvironment {
    pub fn current() -> Self {
        let folder = |name: &str| env::var_os(name).map(PathBuf::from);
        Self {
            path: env::var_os("PATH"),
            home: folder("HOME").or_else(|| folder("USERPROFILE")),
            local_app_data: folder("LOCALAPPDATA"),
            roaming_app_data: folder("APPDATA"),
        }
    }

    /// Every `name` in each `PATH` folder in order, then in the `known` folders.
    pub fn candidates(&self, names: &[&str], known: Vec<Option<PathBuf>>) -> Vec<PathBuf> {
        let mut folders: Vec<PathBuf> = self
            .path
            .as_ref()
            .map(|path| env::split_paths(path).collect())
            .unwrap_or_default();
        folders.extend(known.into_iter().flatten());
        folders
            .iter()
            .flat_map(|folder| names.iter().map(|name| folder.join(name)))
            .collect()
    }
}

/// Reads `major.minor.patch` from version output such as `codex-cli 0.162.1` or
/// `2.1.322 (Claude Code)`.
pub(crate) fn parse_version(output: &str) -> Option<Version> {
    output.split_whitespace().find_map(|word| {
        let release = word.split(['-', '+']).next()?;
        let mut parts = release.split('.').map(str::parse::<u64>);
        match (parts.next()?, parts.next()?, parts.next()?, parts.next()) {
            (Ok(major), Ok(minor), Ok(patch), None) => Some((major, minor, patch)),
            _ => None,
        }
    })
}
