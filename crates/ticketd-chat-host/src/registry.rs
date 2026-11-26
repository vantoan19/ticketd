//! Built-in Chat plug-ins. Listing a plug-in or reading a Step starts no process.
use std::path::PathBuf;
use std::sync::Arc;

use ticketd_core::harnesses::{ANTIGRAVITY, CLAUDE_CODE, CODEX, HarnessDescriptor};

use crate::codex::steps::read_codex_steps;
use crate::{CodexAdapter, HarnessAdapter, Problem, StepReader, read_claude_steps};

pub struct HostResources {
    /// The application directory where its bundled sidecars are installed.
    pub executable_directory: Option<PathBuf>,
}

pub struct Registration {
    pub descriptor: &'static HarnessDescriptor,
    pub make_adapter: fn(&HostResources) -> Result<Arc<dyn HarnessAdapter>, Problem>,
    pub read_steps: StepReader,
    /// Where the program is installed, found the way Chats find it. Starts nothing.
    pub find: fn() -> Option<PathBuf>,
    /// Set while the program is asked its version, so the question has no side effects.
    pub version_environment: &'static [(&'static str, &'static str)],
}

/// A program found on this computer, and the version it reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installation {
    pub executable: PathBuf,
    /// What `--version` printed, when it answered.
    pub version: Option<String>,
}

impl Registration {
    /// Whether the program is installed, and its version. Only asks the program for
    /// its version: no session is opened and no sign-in is checked, so this is safe to
    /// run while Chat is off.
    pub async fn installation(&self) -> Option<Installation> {
        let executable = (self.find)()?;
        Some(read_installation(executable, self.version_environment).await)
    }
}

async fn read_installation(executable: PathBuf, environment: &[(&str, &str)]) -> Installation {
    let version = crate::stdio::version_output(&executable, environment)
        .await
        .ok()
        .map(|output| output.trim().to_owned())
        .filter(|output| !output.is_empty());
    Installation {
        executable,
        version,
    }
}

pub static REGISTRATIONS: &[Registration] = &[
    Registration {
        descriptor: &CLAUDE_CODE,
        make_adapter: crate::claude::make_adapter,
        read_steps: read_claude_steps,
        find: crate::claude::find,
        version_environment: &[],
    },
    Registration {
        descriptor: &CODEX,
        make_adapter: make_codex,
        read_steps: read_codex_steps,
        find: crate::codex::find,
        version_environment: &[],
    },
    Registration {
        descriptor: &ANTIGRAVITY,
        make_adapter: crate::antigravity::make_adapter,
        read_steps: crate::antigravity::read_steps,
        find: crate::antigravity::executable,
        version_environment: &[("AGY_CLI_DISABLE_AUTO_UPDATE", "1")],
    },
];

fn make_codex(_: &HostResources) -> Result<Arc<dyn HarnessAdapter>, Problem> {
    Ok(Arc::new(CodexAdapter::new()))
}

pub fn registration(key: &str) -> Option<&'static Registration> {
    REGISTRATIONS
        .iter()
        .find(|entry| entry.descriptor.key.as_str() == key)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use ticketd_core::harnesses::HARNESS_DESCRIPTORS;

    #[test]
    fn the_core_catalog_and_host_registry_have_the_same_unique_keys() {
        let registered: HashSet<_> = REGISTRATIONS
            .iter()
            .map(|entry| entry.descriptor.key.as_str())
            .collect();
        let catalog: HashSet<_> = HARNESS_DESCRIPTORS
            .iter()
            .map(|descriptor| descriptor.key.as_str())
            .collect();
        assert_eq!(registered.len(), REGISTRATIONS.len());
        assert_eq!(catalog.len(), HARNESS_DESCRIPTORS.len());
        assert_eq!(registered, catalog);
        for descriptor in HARNESS_DESCRIPTORS {
            let entry = registration(descriptor.key.as_str()).expect("registered harness");
            assert!(std::ptr::eq(*descriptor, entry.descriptor));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_found_program_is_asked_only_its_version() {
        use std::os::unix::fs::PermissionsExt;
        let folder = tempfile::tempdir().expect("folder");
        let program = folder.path().join("agent");
        // It would answer anything else with a failure: only `--version` is allowed.
        std::fs::write(
            &program,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"agent-cli 0.98.0\"; else exit 3; fi\n",
        )
        .expect("script");
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755))
            .expect("permissions");
        let found = read_installation(program.clone(), &[]).await;
        assert_eq!(found.executable, program);
        assert_eq!(found.version.as_deref(), Some("agent-cli 0.98.0"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_program_that_will_not_say_its_version_is_still_found() {
        use std::os::unix::fs::PermissionsExt;
        let folder = tempfile::tempdir().expect("folder");
        let program = folder.path().join("agent");
        std::fs::write(&program, "#!/bin/sh\nexit 1\n").expect("script");
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755))
            .expect("permissions");
        let found = read_installation(program.clone(), &[]).await;
        assert_eq!(found.executable, program);
        assert_eq!(found.version, None);
    }
}
