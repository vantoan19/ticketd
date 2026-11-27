//! What a shell Step's `ticketd` calls would write, told to the core so a write made while
//! the Step runs can be credited to the agent that ran it (`ChatWriteCredit`).
//!
//! The host never changes a command and never matches what a command printed. It only
//! reads the command the harness reported, to tell the core which Steps are shell Steps
//! and what the plain `ticketd` calls among them could write.

use ticketd_core::{ChatPlannedWrite, ChatPlannedWriteKind, ChatToolState};

use crate::tool_steps::{StepAction, ToolEvidence, read_tool_steps};

/// The longest word of a call kept as something that could name a ticket.
const REFERENCE_WORD_LIMIT: usize = 64;

/// `None` when the Step is not a shell Step; otherwise what its plain `ticketd` calls could
/// write (empty when it names none, or is not only `ticketd` calls).
pub(crate) fn shell_step_writes(
    harness: &str,
    name: &str,
    input: &str,
    state: ChatToolState,
) -> Option<Vec<ChatPlannedWrite>> {
    let evidence = ToolEvidence {
        name,
        input,
        output: None,
        state,
        working_directory: "",
    };
    let command = read_tool_steps(harness, evidence)
        .into_iter()
        .find_map(|step| match step.action {
            StepAction::Run(_) => step.command,
            _ => None,
        })?;
    Some(
        command
            .ticketd_calls
            .iter()
            .flatten()
            .filter_map(|call| planned_write(call))
            .collect(),
    )
}

/// What one `ticketd` call (its arguments after the program) could write.
fn planned_write(arguments: &[String]) -> Option<ChatPlannedWrite> {
    let kind = match arguments.first()?.as_str() {
        "change"
            if arguments
                .iter()
                .any(|word| word == "--status" || word.starts_with("--status=")) =>
        {
            ChatPlannedWriteKind::Status
        }
        "activity" if arguments.get(1).is_some_and(|word| word == "add") => {
            ChatPlannedWriteKind::Activity
        }
        // These move statuses or add Activities among other things.
        "batch" | "write" | "create" | "plan" => ChatPlannedWriteKind::Other,
        _ => return None,
    };
    let references = arguments
        .iter()
        .skip(1)
        .filter(|word| {
            !word.starts_with('-')
                && word.len() <= REFERENCE_WORD_LIMIT
                && !word.contains(char::is_whitespace)
        })
        .cloned()
        .collect();
    Some(ChatPlannedWrite { kind, references })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bash(command: &str) -> String {
        serde_json::json!({ "command": command }).to_string()
    }

    fn writes(command: &str) -> Option<Vec<ChatPlannedWrite>> {
        shell_step_writes("claude-code", "Bash", &bash(command), ChatToolState::Running)
    }

    #[test]
    fn a_plain_activity_call_names_an_activity_and_its_ticket() {
        let found = writes(r#"ticketd activity add T-UB237 --brief "Added a test" --agent claude-code"#)
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, ChatPlannedWriteKind::Activity);
        assert!(found[0].references.contains(&"T-UB237".to_owned()));
    }

    #[test]
    fn a_change_with_a_status_names_a_status_move() {
        let found = writes("ticketd change T-UB237 --status Done").unwrap();
        assert_eq!(found[0].kind, ChatPlannedWriteKind::Status);
        // A change without a status moves nothing.
        assert_eq!(writes("ticketd change T-UB237 --title Renamed").unwrap(), []);
    }

    #[test]
    fn reads_and_other_commands_name_no_write_but_are_still_shell_steps() {
        assert_eq!(writes("ticketd show T-UB237").unwrap(), []);
        assert_eq!(writes("npm test -- rate-limit").unwrap(), []);
    }

    #[test]
    fn a_batch_may_write_either() {
        let found = writes("ticketd batch --file plan.json").unwrap();
        assert_eq!(found[0].kind, ChatPlannedWriteKind::Other);
    }

    #[test]
    fn a_step_that_is_not_a_shell_command_is_not_a_window() {
        let read = serde_json::json!({ "file_path": "/work/app/README.md" }).to_string();
        assert_eq!(
            shell_step_writes("claude-code", "Read", &read, ChatToolState::Running),
            None
        );
    }
}
