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
}

pub static REGISTRATIONS: &[Registration] = &[
    Registration {
        descriptor: &CLAUDE_CODE,
        make_adapter: crate::claude::make_adapter,
        read_steps: read_claude_steps,
    },
    Registration {
        descriptor: &CODEX,
        make_adapter: make_codex,
        read_steps: read_codex_steps,
    },
    Registration {
        descriptor: &ANTIGRAVITY,
        make_adapter: crate::antigravity::make_adapter,
        read_steps: crate::antigravity::read_steps,
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
        assert_eq!(registered.len(), REGISTRATIONS.len());
        assert_eq!(registered.len(), HARNESS_DESCRIPTORS.len());
        for descriptor in HARNESS_DESCRIPTORS {
            let entry = registration(descriptor.key.as_str()).expect("registered harness");
            assert!(std::ptr::eq(*descriptor, entry.descriptor));
        }
    }
}
