//! Finding the user's installed Codex and judging what its version supports.
//! Nothing here reads Codex's configuration or credentials.

use std::path::{Path, PathBuf};

use crate::install::Version;
pub(super) use crate::install::{LaunchEnvironment, Os, parse_version};
use crate::{Capabilities, Capability, SteeringBehavior};

/// The oldest Codex this adapter supports. 0.162.x cannot start its Windows sandbox
/// whenever another Codex process holds a runtime file open (fixed in 0.163.0, PR
/// #51822), which would fail every unattended command there. The app-server methods
/// ticketd uses are unchanged through 0.169.0 (#387).
pub(super) const MINIMUM_VERSION: Version = (0, 163, 0);

/// Where Codex may be, most specific first: `PATH` in order, then known locations.
pub(super) fn candidates(os: Os, environment: &LaunchEnvironment) -> Vec<PathBuf> {
    let names: &[&str] = match os {
        // The npm package installs a `.cmd` shim.
        Os::Windows => &["codex.exe", "codex.cmd"],
        Os::Mac | Os::Linux => &["codex"],
    };
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
    environment.candidates(names, known)
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

pub(super) fn version_requirement() -> String {
    let (major, minor, patch) = MINIMUM_VERSION;
    format!("Codex {major}.{minor}.{patch} or newer (run `codex update`)")
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
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

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

        assert!(capabilities(Some("0.163.0")).steering.behavior().is_some());
        // The floor is 0.163.0: the Windows sandbox of 0.162.x fails to start.
        assert!(matches!(
            capabilities(Some("0.162.1")).steering,
            Capability::Unsupported { reason } if reason == "Codex 0.163.0 or newer (run `codex update`)"
        ));
        assert!(matches!(
            capabilities(Some("0.100.0")).steering,
            Capability::Unsupported { .. }
        ));
    }
}
