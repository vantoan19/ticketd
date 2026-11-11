//! Finding the user's installed Codex and judging what its version supports.
//!
//! A desktop application started from a launcher often has a shorter `PATH` than the
//! user's shell, so the usual install locations are checked as well. Nothing here
//! reads Codex's configuration or credentials.

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::{Capabilities, Capability, SteeringBehavior};

/// The oldest Codex whose app-server protocol this adapter was written against.
pub(super) const MINIMUM_VERSION: Version = (0, 162, 1);

pub(super) type Version = (u64, u64, u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Os {
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
pub(super) struct LaunchEnvironment {
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
}

/// Where Codex may be, most specific first: `PATH` in order, then known locations.
pub(super) fn candidates(os: Os, environment: &LaunchEnvironment) -> Vec<PathBuf> {
    let names: &[&str] = match os {
        // The npm package installs a `.cmd` shim.
        Os::Windows => &["codex.exe", "codex.cmd"],
        Os::Mac | Os::Linux => &["codex"],
    };
    let mut folders: Vec<PathBuf> = environment
        .path
        .as_ref()
        .map(|path| env::split_paths(path).collect())
        .unwrap_or_default();
    let home = |relative: &str| environment.home.as_ref().map(|home| home.join(relative));
    // ponytail: version-manager folders (nvm, fnm, volta) are not searched; a user
    // with such a setup selects the executable explicitly. Add them on demand.
    let known: Vec<Option<PathBuf>> = match os {
        Os::Windows => vec![
            environment
                .local_app_data
                .as_ref()
                .map(|data| data.join("Programs/OpenAI/Codex/bin")),
            environment
                .roaming_app_data
                .as_ref()
                .map(|data| data.join("npm")),
        ],
        Os::Mac => vec![
            Some(PathBuf::from("/opt/homebrew/bin")),
            Some(PathBuf::from("/usr/local/bin")),
            home(".local/bin"),
            home(".npm-global/bin"),
        ],
        Os::Linux => vec![
            home(".local/bin"),
            home(".npm-global/bin"),
            Some(PathBuf::from("/usr/local/bin")),
            Some(PathBuf::from("/usr/bin")),
            Some(PathBuf::from("/home/linuxbrew/.linuxbrew/bin")),
        ],
    };
    folders.extend(known.into_iter().flatten());
    folders
        .iter()
        .flat_map(|folder| names.iter().map(|name| folder.join(name)))
        .collect()
}

pub(super) fn locate(
    os: Os,
    environment: &LaunchEnvironment,
    is_file: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    candidates(os, environment)
        .into_iter()
        .find(|candidate| is_file(candidate))
}

/// Reads `major.minor.patch` from `codex --version` output such as `codex-cli 0.162.1`.
pub(super) fn parse_version(output: &str) -> Option<Version> {
    output.split_whitespace().find_map(|word| {
        let release = word.split(['-', '+']).next()?;
        let mut parts = release.split('.').map(str::parse::<u64>);
        match (parts.next()?, parts.next()?, parts.next()?, parts.next()) {
            (Ok(major), Ok(minor), Ok(patch), None) => Some((major, minor, patch)),
            _ => None,
        }
    })
}

pub(super) fn version_requirement() -> String {
    let (major, minor, patch) = MINIMUM_VERSION;
    format!(
        "Codex {major}.{minor}.{patch} or newer, the oldest version whose app-server \
         protocol ticketd was written against. Update Codex, then recheck."
    )
}

/// What a session on this Codex version supports. An unreadable version is unknown,
/// not unsupported.
pub(super) fn capabilities(version: Option<&str>) -> Capabilities {
    fn gate<B>(version: Option<&str>, behavior: B, method: &str) -> Capability<B> {
        match version.and_then(parse_version) {
            Some(found) if found >= MINIMUM_VERSION => Capability::Supported {
                behavior,
                evidence: format!(
                    "`{method}` is in the app-server protocol of Codex {}; not yet \
                     confirmed against a live session",
                    version.unwrap_or_default()
                ),
            },
            Some(_) => Capability::Unsupported {
                reason: version_requirement(),
            },
            None => Capability::Unknown {
                reason: "Codex did not report a version ticketd can read".to_owned(),
            },
        }
    }
    Capabilities {
        // The documentation describes steering as appending input to the active turn.
        steering: gate(
            version,
            SteeringBehavior {
                interrupts_tools: false,
            },
            "turn/steer",
        ),
        native_resume: gate(version, (), "thread/resume"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_wins_over_known_locations_and_a_short_launcher_path_still_finds_codex() {
        let environment = LaunchEnvironment {
            path: Some(OsString::from("/launcher/bin")),
            home: Some(PathBuf::from("/home/sam")),
            ..LaunchEnvironment::default()
        };
        let in_home = PathBuf::from("/home/sam/.local/bin/codex");
        let on_path = PathBuf::from("/launcher/bin/codex");

        let from_known = locate(Os::Linux, &environment, |path| path == in_home);
        let from_path = locate(Os::Linux, &environment, |path| {
            path == in_home || path == on_path
        });

        assert_eq!(from_known, Some(in_home.clone()));
        assert_eq!(from_path, Some(on_path.clone()));
        assert_eq!(locate(Os::Linux, &environment, |_| false), None);
    }

    #[test]
    fn windows_checks_the_installer_and_npm_locations() {
        let environment = LaunchEnvironment {
            local_app_data: Some(PathBuf::from("L")),
            roaming_app_data: Some(PathBuf::from("R")),
            ..LaunchEnvironment::default()
        };

        let candidates = candidates(Os::Windows, &environment);

        assert_eq!(
            candidates,
            vec![
                PathBuf::from("L/Programs/OpenAI/Codex/bin/codex.exe"),
                PathBuf::from("L/Programs/OpenAI/Codex/bin/codex.cmd"),
                PathBuf::from("R/npm/codex.exe"),
                PathBuf::from("R/npm/codex.cmd"),
            ]
        );
    }

    #[test]
    fn reads_versions_and_gates_capabilities_without_guessing() {
        assert_eq!(parse_version("codex-cli 0.162.1\n"), Some((0, 162, 1)));
        assert_eq!(parse_version("codex-cli 1.2.3-beta.1"), Some((1, 2, 3)));
        assert_eq!(parse_version("codex-cli unknown"), None);

        assert!(capabilities(Some("0.162.1")).steering.behavior().is_some());
        assert!(matches!(
            capabilities(Some("0.100.0")).steering,
            Capability::Unsupported { .. }
        ));
        assert!(matches!(
            capabilities(None).native_resume,
            Capability::Unknown { .. }
        ));
    }
}
