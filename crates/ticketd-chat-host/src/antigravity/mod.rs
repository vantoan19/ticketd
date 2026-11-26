//! A person's Chat on their installed Antigravity ACP server.
mod models;
mod runtime;
mod settings;
mod steps;

#[cfg(test)]
pub(crate) mod tests;

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use ticketd_core::ChatAttachmentContent;
use ticketd_core::harnesses::ANTIGRAVITY;

use crate::install::{LaunchEnvironment, Os, is_executable, parse_version};
use crate::stdio::{Serving, spawn_configured, version_output};
use crate::{
    Capabilities, Capability, Harness, HarnessAdapter, HarnessOptions, Inspection, LoginState,
    OpenRequest, OpenedRuntime, Problem, ProblemKind, Refusal, Setting,
};

pub(crate) use steps::read_steps;

const MINIMUM_VERSION: (u64, u64, u64) = (1, 5, 2);
const REQUIREMENT: &str = "Antigravity CLI 1.5.2 or newer";

pub(crate) fn make_adapter(_: &crate::HostResources) -> Result<Arc<dyn HarnessAdapter>, Problem> {
    Ok(Arc::new(Antigravity))
}

struct Antigravity;

pub(crate) fn executable() -> Option<PathBuf> {
    let environment = LaunchEnvironment::current();
    let names: &[&str] = if Os::current() == Os::Windows {
        &["agy.exe"]
    } else {
        &["agy"]
    };
    let installed = environment
        .home
        .as_ref()
        .map(|home| home.join(".local/bin"));
    environment
        .candidates(names, vec![installed])
        .into_iter()
        .find_map(|path| {
            if is_executable(&path) {
                std::path::absolute(path).ok()
            } else {
                None
            }
        })
}

fn capabilities() -> Capabilities {
    // ACP v1 updates only name the session when two Prompt RPCs overlap.
    Capabilities {
        steering: Capability::Unsupported {
            reason: "Antigravity follow-ups queue until the turn ends".to_owned(),
        },
    }
}

fn problem(kind: ProblemKind, message: impl Into<String>) -> Problem {
    Problem {
        kind,
        message: message.into(),
        detail: None,
        resets_at: None,
    }
}

#[async_trait]
impl HarnessAdapter for Antigravity {
    fn harness(&self) -> Harness {
        &ANTIGRAVITY
    }

    fn attachment_refusal(&self, _: &[ChatAttachmentContent]) -> Option<Refusal> {
        // Only the ACP handshake establishes whether this runtime accepts images.
        None
    }

    async fn inspect(&self) -> Inspection {
        let Some(executable) = executable() else {
            return Inspection::NotInstalled;
        };
        let version =
            match version_output(&executable, &[("AGY_CLI_DISABLE_AUTO_UPDATE", "1")]).await {
                Ok(version) => version.trim().to_owned(),
                Err(reason) => return Inspection::ProbeFailed { reason },
            };
        match parse_version(&version) {
            Some(found) if found >= MINIMUM_VERSION => Inspection::Installed {
                executable,
                version: Some(version),
                // Only a session result establishes sign-in. Inspection starts no session.
                login: LoginState::Unknown,
                capabilities: capabilities(),
            },
            Some(_) => Inspection::Incompatible {
                executable,
                version: Some(version),
                requirement: REQUIREMENT.to_owned(),
            },
            None => Inspection::ProbeFailed {
                reason: "Antigravity did not report a readable version".to_owned(),
            },
        }
    }

    async fn options(&self) -> Result<HarnessOptions, String> {
        let listed = match self.inspect().await {
            Inspection::Installed { executable, .. } => models::listed(&executable).await,
            Inspection::NotInstalled => Err("Antigravity CLI (agy) was not found".to_owned()),
            Inspection::Incompatible { requirement, .. } => {
                Err(format!("Install {requirement} to list models"))
            }
            Inspection::ProbeFailed { reason } => Err(reason),
        };
        let (models, model_list_error) = match listed {
            Ok(models) => (models, None),
            Err(reason) => (Vec::new(), Some(reason)),
        };
        Ok(HarnessOptions {
            models,
            model_list_error,
            permission: self.permission_before_session(None, None),
        })
    }

    fn permission_before_session(
        &self,
        recorded: Option<&str>,
        picked: Option<&str>,
    ) -> Option<Setting> {
        let record = settings::Record::read(recorded);
        Some(settings::permission(
            &[],
            picked
                .or(record.permission.as_deref())
                .or(Some(settings::OWN)),
        ))
    }

    fn record_permission(&self, recorded: Option<&str>, value: &str) -> Option<String> {
        let mut record = settings::Record::read(recorded);
        record.permission = Some(value.to_owned());
        serde_json::to_string(&record).ok()
    }

    async fn open(&self, request: OpenRequest) -> Result<OpenedRuntime, Problem> {
        if request.unattended.is_some() {
            return Err(problem(
                ProblemKind::PermissionUnavailable,
                "Antigravity is available only for Chats you drive.",
            ));
        }
        let executable = match self.inspect().await {
            Inspection::Installed { executable, .. } => executable,
            Inspection::NotInstalled => {
                return Err(problem(
                    ProblemKind::NotInstalled,
                    "Antigravity CLI (agy) was not found",
                ));
            }
            Inspection::Incompatible { requirement, .. } => {
                return Err(problem(ProblemKind::IncompatibleVersion, requirement));
            }
            Inspection::ProbeFailed { reason } => return Err(problem(ProblemKind::Other, reason)),
        };
        let folder = &request.working_directory;
        let recorded = settings::Record::read(request.recorded_settings.as_deref());
        let permission = request
            .settings
            .permission
            .clone()
            .or(recorded.permission)
            .unwrap_or_else(|| settings::OWN.to_owned());
        let args: &[&str] = if permission == settings::FULL {
            &["acp", "--dangerously-skip-permissions"]
        } else {
            &["acp"]
        };
        let io = spawn_configured(
            &executable,
            args,
            Serving::of(&request),
            self.harness(),
            Some(folder),
            |command| {
                command
                    .current_dir(folder)
                    .env("AGY_CLI_DISABLE_AUTO_UPDATE", "1");
            },
        )
        .map_err(|error| {
            problem(
                ProblemKind::Other,
                format!("Could not start Antigravity: {error}"),
            )
        })?;
        runtime::open(io, request, permission).await
    }
}
