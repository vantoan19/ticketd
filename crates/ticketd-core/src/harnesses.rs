//! Harness identities and declared policies, independent of installation and runtime state.

use std::borrow::Cow;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// A stable key stored as plain text in the Workspace and sent over IPC as a string.
/// A well-formed key can outlive its descriptor, so parsing does not require registration.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct HarnessKey(Cow<'static, str>);

impl HarnessKey {
    #[allow(non_upper_case_globals)] // Preserve the original AgentHarness constructor.
    pub const ClaudeCode: Self = Self(Cow::Borrowed("claude-code"));
    #[allow(non_upper_case_globals)]
    pub const Codex: Self = Self(Cow::Borrowed("codex"));

    pub fn as_str(&self) -> &str {
        self.0.as_ref()
    }
}

impl Default for HarnessKey {
    fn default() -> Self {
        Self::ClaudeCode
    }
}

#[derive(Debug, thiserror::Error)]
#[error("invalid harness key '{0}'; use lowercase letters or digits separated by hyphens")]
pub struct InvalidHarnessKey(String);

impl TryFrom<String> for HarnessKey {
    type Error = InvalidHarnessKey;

    fn try_from(key: String) -> Result<Self, Self::Error> {
        if key.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        }) {
            Ok(Self(Cow::Owned(key)))
        } else {
            Err(InvalidHarnessKey(key))
        }
    }
}

impl FromStr for HarnessKey {
    type Err = InvalidHarnessKey;

    fn from_str(key: &str) -> Result<Self, Self::Err> {
        key.to_owned().try_into()
    }
}

impl<'de> Deserialize<'de> for HarnessKey {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .try_into()
            .map_err(serde::de::Error::custom)
    }
}

/// Where the harness looks for its per-user skills.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillLocation {
    ConfigHome(&'static str),
    UserHome(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumePolicy {
    /// The person can explicitly recover by replaying history into a fresh session.
    NativeOrReplay,
    /// Recover only by resuming the harness's own session.
    NativeOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnattendedSupport {
    Unsupported { reason: &'static str },
    Supported(UnattendedCapabilities),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnattendedCapabilities {
    pub commands: CommandControl,
    pub reads: ReadControl,
    pub native_turn_limit: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandControl {
    /// The harness can turn commands off, restrict them to a list, or allow any.
    AllowlistOrAny,
    /// The harness can turn commands off or allow any within its sandbox.
    OffOrAny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadControl {
    /// The harness can grant a file read tool independently of commands.
    Independent,
    /// File reads are available through the shell when commands are allowed.
    RequiresCommands,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionSemantics {
    OwnSettings,
    Ask,
    AcceptEdits,
    ReadOnly,
    FullAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionAvailability {
    /// The adapter can offer this choice according to its current policy and capabilities.
    Adapter,
    /// Offer this choice only once the harness advertises it.
    Native,
}

/// A declared permission choice. The adapter reports which choices actually apply or
/// are available for a given session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PermissionChoice {
    /// The existing mode identifier used in setting picks and stored settings.
    pub id: &'static str,
    pub label: &'static str,
    pub description: Option<&'static str>,
    pub semantics: PermissionSemantics,
    pub availability: PermissionAvailability,
    pub is_default: bool,
}

#[derive(Debug, Clone)]
pub struct HarnessDescriptor {
    pub key: HarnessKey,
    pub name: &'static str,
    pub sign_in_guidance: &'static str,
    pub sign_in_command: &'static str,
    pub help_url: &'static str,
    pub config_home: &'static str,
    pub config_home_env: Option<&'static str>,
    pub skills: SkillLocation,
    /// Names for which writes get this harness's mark, after trimming and folding case.
    pub editing_agent_aliases: &'static [&'static str],
    pub mark_id: &'static str,
    pub resume: ResumePolicy,
    pub unattended: UnattendedSupport,
    pub permissions: &'static [PermissionChoice],
}

pub static CLAUDE_CODE: HarnessDescriptor = HarnessDescriptor {
    key: HarnessKey::ClaudeCode,
    name: "Claude Code",
    sign_in_guidance: "Claude Code isn't signed in. Run `claude /login` in a terminal and sign in.",
    sign_in_command: "claude /login",
    help_url: "https://code.claude.com/docs/en/setup",
    config_home: ".claude",
    config_home_env: Some("CLAUDE_CONFIG_DIR"),
    skills: SkillLocation::ConfigHome("skills"),
    editing_agent_aliases: &["claude", "claude-code", "claude code"],
    mark_id: "claude-code",
    resume: ResumePolicy::NativeOrReplay,
    unattended: UnattendedSupport::Supported(UnattendedCapabilities {
        commands: CommandControl::AllowlistOrAny,
        reads: ReadControl::Independent,
        native_turn_limit: true,
    }),
    permissions: &[
        PermissionChoice {
            id: "default",
            label: "Ask before edits",
            description: None,
            semantics: PermissionSemantics::Ask,
            availability: PermissionAvailability::Adapter,
            is_default: true,
        },
        PermissionChoice {
            id: "acceptEdits",
            label: "Accept edits",
            description: None,
            semantics: PermissionSemantics::AcceptEdits,
            availability: PermissionAvailability::Adapter,
            is_default: false,
        },
        PermissionChoice {
            id: "plan",
            label: "Plan only",
            description: None,
            semantics: PermissionSemantics::ReadOnly,
            availability: PermissionAvailability::Adapter,
            is_default: false,
        },
        PermissionChoice {
            id: "bypassPermissions",
            label: "Full access",
            description: Some("Runs tools and commands without asking"),
            semantics: PermissionSemantics::FullAccess,
            availability: PermissionAvailability::Adapter,
            is_default: false,
        },
    ],
};

pub static CODEX: HarnessDescriptor = HarnessDescriptor {
    key: HarnessKey::Codex,
    name: "Codex",
    sign_in_guidance: "Codex isn't signed in. Run `codex login` in a terminal and sign in.",
    sign_in_command: "codex login",
    help_url: "https://developers.openai.com/codex/cli",
    config_home: ".codex",
    config_home_env: Some("CODEX_HOME"),
    // Codex reads per-user skills from ~/.agents/skills, outside its config home.
    skills: SkillLocation::UserHome(".agents/skills"),
    editing_agent_aliases: &["codex"],
    mark_id: "codex",
    resume: ResumePolicy::NativeOrReplay,
    unattended: UnattendedSupport::Supported(UnattendedCapabilities {
        commands: CommandControl::OffOrAny,
        reads: ReadControl::RequiresCommands,
        native_turn_limit: false,
    }),
    permissions: &[
        PermissionChoice {
            id: "own",
            label: "Codex settings",
            description: None,
            semantics: PermissionSemantics::OwnSettings,
            availability: PermissionAvailability::Adapter,
            is_default: true,
        },
        PermissionChoice {
            id: "full-access",
            label: "Full access",
            description: Some("Never asks, and runs without a sandbox"),
            semantics: PermissionSemantics::FullAccess,
            availability: PermissionAvailability::Adapter,
            is_default: false,
        },
    ],
};

pub static HARNESS_DESCRIPTORS: &[&HarnessDescriptor] = &[&CLAUDE_CODE, &CODEX];

pub fn descriptor(key: &str) -> Option<&'static HarnessDescriptor> {
    find_descriptor(HARNESS_DESCRIPTORS, key)
}

pub fn find_descriptor<'a>(
    catalog: &[&'a HarnessDescriptor],
    key: &str,
) -> Option<&'a HarnessDescriptor> {
    catalog
        .iter()
        .copied()
        .find(|descriptor| descriptor.key.as_str() == key)
}
