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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct UnattendedCapabilities {
    pub commands: CommandControl,
    pub reads: ReadControl,
    pub edits_in_step_folder_only: bool,
    pub tool_note: Option<&'static str>,
    pub native_turn_limit: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandControl {
    /// The harness can turn commands off, restrict them to a list, or allow any.
    AllowlistOrAny,
    /// The harness can turn commands off or allow any within its sandbox.
    OffOrAny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadControl {
    /// The harness can grant a file read tool independently of commands.
    Independent,
    /// File reads are available through the shell when commands are allowed.
    RequiresCommands,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionSemantics {
    OwnSettings,
    Ask,
    AcceptEdits,
    ReadOnly,
    FullAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionAvailability {
    /// The adapter can offer this choice according to its current policy and capabilities.
    Adapter,
    /// Offer this choice only once the harness advertises it.
    Native,
}

/// A declared permission choice. The adapter reports which choices actually apply or
/// are available for a given session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PermissionChoice {
    /// The existing mode identifier used in setting picks and stored settings.
    pub id: &'static str,
    pub label: &'static str,
    pub description: Option<&'static str>,
    pub semantics: PermissionSemantics,
    pub availability: PermissionAvailability,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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
    /// What the harness lets ticketd show and do of the sub-agents it starts.
    pub sub_agents: SubAgentSupport,
}

/// What a harness reports about the sub-agents it starts, and what ticketd can do to them
/// (ADR 0022). A view offers only what is declared here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubAgentSupport {
    /// It reports what a sub-agent was asked.
    pub brief: bool,
    /// It reports a sub-agent's own messages and reasoning.
    pub text: bool,
    /// It reports when a sub-agent finishes.
    pub end: bool,
    /// One sub-agent can be stopped without the others.
    pub stop: bool,
    /// A sub-agent that was lost can be resumed.
    pub resume: bool,
    /// The environment variable the harness sets on each command it runs, naming that one
    /// command (Codex's `CODEX_TOOL_CALL_ID`, which is the command Step's item ID). The CLI
    /// records it with a write, so the write is credited to the exact agent that ran the
    /// command. `None`: the harness gives no such key.
    pub call_variable: Option<&'static str>,
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
        edits_in_step_folder_only: false,
        tool_note: Some(
            "Claude Code may still run shell commands that only read in the step’s folder, such as listing it or printing a file there, with “Read files” and “Run commands” off. ticketd cannot switch that off.",
        ),
        native_turn_limit: true,
    }),
    permissions: &[
        PermissionChoice {
            id: "default",
            label: "Ask before edits",
            description: Some("Reads freely; asks before it edits a file or runs a command."),
            semantics: PermissionSemantics::Ask,
            availability: PermissionAvailability::Adapter,
            is_default: true,
        },
        PermissionChoice {
            id: "acceptEdits",
            label: "Accept edits",
            description: Some("Edits files in this folder without asking; asks before commands."),
            semantics: PermissionSemantics::AcceptEdits,
            availability: PermissionAvailability::Adapter,
            is_default: false,
        },
        PermissionChoice {
            id: "plan",
            label: "Plan only",
            description: Some("Reads and plans; changes nothing."),
            semantics: PermissionSemantics::ReadOnly,
            availability: PermissionAvailability::Adapter,
            is_default: false,
        },
        PermissionChoice {
            id: "bypassPermissions",
            label: "Full access",
            description: Some(
                "Edits and runs commands without asking, anywhere your account can reach.",
            ),
            semantics: PermissionSemantics::FullAccess,
            availability: PermissionAvailability::Adapter,
            is_default: false,
        },
    ],
    // Stop for one sub-agent (`stopTask`, background only) is added with its command.
    sub_agents: SubAgentSupport {
        brief: true,
        text: true,
        end: true,
        stop: false,
        resume: true,
        // Claude Code gives a sub-agent's command no key of its own: its writes are
        // credited by commit order.
        call_variable: None,
    },
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
        edits_in_step_folder_only: true,
        tool_note: Some(
            "With Run commands on, Codex can read any file you can. Your global AGENTS.md, personal skills and “always allow” rules still apply.",
        ),
        native_turn_limit: false,
    }),
    permissions: &[
        PermissionChoice {
            id: "own",
            label: "Codex settings",
            description: Some(
                "Follows your Codex settings for what it asks and what it can touch.",
            ),
            semantics: PermissionSemantics::OwnSettings,
            availability: PermissionAvailability::Adapter,
            is_default: true,
        },
        PermissionChoice {
            id: "full-access",
            label: "Full access",
            description: Some(
                "Edits and runs commands without asking or a sandbox, anywhere your account can reach.",
            ),
            semantics: PermissionSemantics::FullAccess,
            availability: PermissionAvailability::Adapter,
            is_default: false,
        },
    ],
    // Codex does not report what a child was asked.
    sub_agents: SubAgentSupport {
        brief: false,
        text: true,
        end: true,
        stop: false,
        resume: false,
        call_variable: Some("CODEX_TOOL_CALL_ID"),
    },
};

pub static ANTIGRAVITY: HarnessDescriptor = HarnessDescriptor {
    key: HarnessKey(Cow::Borrowed("antigravity")),
    name: "Antigravity",
    sign_in_guidance: "Antigravity isn't signed in. Run `agy` in a terminal and sign in.",
    sign_in_command: "agy",
    help_url: "https://antigravity.google/docs/ide/extensions/acp/",
    config_home: ".gemini",
    config_home_env: None,
    skills: SkillLocation::ConfigHome("config/skills"),
    editing_agent_aliases: &["antigravity", "agy"],
    mark_id: "antigravity",
    resume: ResumePolicy::NativeOnly,
    unattended: UnattendedSupport::Unsupported {
        reason: "Antigravity is available only for Chats you drive.",
    },
    permissions: &[
        PermissionChoice {
            id: "own",
            label: "Antigravity settings",
            description: Some(
                "Follows your Antigravity settings for what it asks and what it can touch.",
            ),
            semantics: PermissionSemantics::OwnSettings,
            availability: PermissionAvailability::Adapter,
            is_default: true,
        },
        PermissionChoice {
            id: "default",
            label: "Ask for approval",
            description: Some("Reads freely; asks before it edits a file or runs a command."),
            semantics: PermissionSemantics::Ask,
            availability: PermissionAvailability::Native,
            is_default: false,
        },
        PermissionChoice {
            id: "accept-edits",
            label: "Accept edits",
            description: Some("Edits files in this folder without asking; asks before commands."),
            semantics: PermissionSemantics::AcceptEdits,
            availability: PermissionAvailability::Native,
            is_default: false,
        },
        PermissionChoice {
            id: "plan",
            label: "Plan only",
            description: Some("Reads and plans; changes nothing."),
            semantics: PermissionSemantics::ReadOnly,
            availability: PermissionAvailability::Native,
            is_default: false,
        },
        PermissionChoice {
            id: "full-access",
            label: "Full access",
            description: Some(
                "Edits and runs commands without asking, anywhere your account can reach.",
            ),
            semantics: PermissionSemantics::FullAccess,
            availability: PermissionAvailability::Adapter,
            is_default: false,
        },
    ],
    // Antigravity reports neither a sub-agent's messages nor when it ends.
    sub_agents: SubAgentSupport {
        brief: true,
        text: false,
        end: false,
        stop: false,
        resume: false,
        // `ANTIGRAVITY_SOURCE_METADATA` carries the tool call ID inside JSON; reading it
        // lands with Antigravity's sub-agents.
        call_variable: None,
    },
};

pub static HARNESS_DESCRIPTORS: &[&HarnessDescriptor] = &[&CLAUDE_CODE, &CODEX, &ANTIGRAVITY];

/// The per-command variables the harnesses declare, in catalog order.
pub fn call_variables() -> impl Iterator<Item = &'static str> {
    HARNESS_DESCRIPTORS
        .iter()
        .filter_map(|descriptor| descriptor.sub_agents.call_variable)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    /// Every mode a Chat can pick says in one sentence what it can touch, so the
    /// Permissions menu never shows a bare name next to a described one.
    #[test]
    fn every_permission_mode_has_a_one_sentence_description() {
        for harness in HARNESS_DESCRIPTORS {
            for choice in harness.permissions {
                let text = choice.description.unwrap_or_else(|| {
                    panic!("{} / {} has no description", harness.name, choice.label)
                });
                assert!(text.ends_with('.'), "{}: {text}", choice.label);
                assert_eq!(text.matches(". ").count(), 0, "one sentence: {text}");
            }
        }
    }
}
