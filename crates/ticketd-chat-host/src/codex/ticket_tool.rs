//! ticketd's own tool for an unattended Codex agent: it runs the bundled `ticketd`
//! command line in ticketd's process space and returns what it printed. Codex's
//! sandbox is not involved, so the agent can read and change tickets, Documents and
//! Activities with its shell off and its files read-only (#387).
//!
//! The agent chooses the arguments and nothing else: the program is the one ticketd
//! found, the arguments go in as an array (no shell), the working directory is the
//! step's folder, and the environment is what a Claude Code agent's shell gets (the
//! run's and the Chat's IDs, so writes are credited to the run). The CLI has no
//! argument that selects another Workspace except `restore-workspace`, which is
//! refused here.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;

use crate::stdio::{Serving, command};

/// The request Codex sends to run a tool the client declared on `thread/start`.
pub(super) const CALL_METHOD: &str = "item/tool/call";
pub(super) const NAME: &str = "ticketd";

const MAX_ARGUMENTS: usize = 64;
const MAX_ARGUMENT_BYTES: usize = 64 * 1024;
const MAX_STDIN_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const RUN_TIMEOUT: Duration = Duration::from_secs(120);

/// What the agent is told in the thread's developer instructions.
pub(super) const INSTRUCTIONS: &str = "ticketd tool for this run: you have no shell command \
for ticketd. To read or change tickets, Documents, Activities and Plans, call the `ticketd` \
tool. Its `arguments` are the arguments you would give the `ticketd` command, one string each \
(for example [\"skills\", \"get\", \"chat\"] or [\"show\", \"T-1\"]); its `stdin` is the text a \
command reads where its guide says `-` (for example `--body-file -`). Wherever the ticketd \
context or guide tells you to run a `ticketd` command, call the tool with those arguments \
instead. Never run `ticketd` in a shell command.";

/// The dynamic tool declared on `thread/start`.
pub(super) fn spec() -> Value {
    json!({
        "type": "function",
        "name": NAME,
        "description": "Run the ticketd command line against this run's ticketd Workspace and \
                        return its output. Use it to read and change tickets, Documents, \
                        Activities and Plans.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "arguments": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "description": "The ticketd command's arguments, one string each, \
                                    without the program name."
                },
                "stdin": {
                    "type": "string",
                    "description": "Text for a command that reads standard input (`-`)."
                }
            },
            "required": ["arguments"],
            "additionalProperties": false
        }
    })
}

/// Everything the tool needs to run the CLI for one run.
#[derive(Debug)]
pub(super) struct TicketTool {
    pub cli: PathBuf,
    /// The step's folder.
    pub working_directory: PathBuf,
    pub chat_id: String,
    /// `None` for a Chat the person took over from a run.
    pub run_id: Option<String>,
}

struct Call {
    arguments: Vec<String>,
    stdin: Option<String>,
}

/// Checks the agent's tool input, which is untrusted.
fn parse(input: &Value) -> Result<Call, String> {
    let fields = input.as_object().ok_or("the input must be an object")?;
    if let Some(unknown) = fields
        .keys()
        .find(|key| !["arguments", "stdin"].contains(&key.as_str()))
    {
        return Err(format!("unknown field `{unknown}`"));
    }
    let list = fields
        .get("arguments")
        .and_then(Value::as_array)
        .ok_or("`arguments` must be a list of strings")?;
    if list.is_empty() || list.len() > MAX_ARGUMENTS {
        return Err(format!("give 1 to {MAX_ARGUMENTS} arguments"));
    }
    let arguments = list
        .iter()
        .map(|argument| match argument.as_str() {
            Some(text) if text.len() <= MAX_ARGUMENT_BYTES && !text.contains('\0') => {
                Ok(text.to_owned())
            }
            _ => Err("each argument must be a string without NUL under 64 KiB".to_owned()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    // The first argument is the subcommand: `ticketd` has no option that comes first
    // and changes what it acts on.
    match (arguments[0].as_str(), arguments.get(1).map(String::as_str)) {
        ("restore-workspace", _) => {
            return Err(
                "`restore-workspace` replaces the Workspace and is not available to an agent"
                    .into(),
            );
        }
        ("skills", Some("install")) => {
            return Err(
                "`skills install` writes outside this step and is not available to an agent".into(),
            );
        }
        _ => {}
    }
    let stdin = match fields.get("stdin") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.len() <= MAX_STDIN_BYTES => Some(text.clone()),
        Some(_) => return Err("`stdin` must be a string under 1 MiB".into()),
    };
    Ok(Call { arguments, stdin })
}

fn response(success: bool, text: String) -> Value {
    json!({"success": success, "contentItems": [{"type": "inputText", "text": text}]})
}

/// `text` cut to `MAX_OUTPUT_BYTES` at a character boundary.
fn bounded(text: &str) -> String {
    if text.len() <= MAX_OUTPUT_BYTES {
        return text.to_owned();
    }
    let mut end = MAX_OUTPUT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[output cut at {MAX_OUTPUT_BYTES} bytes]", &text[..end])
}

impl TicketTool {
    /// Runs the CLI for one tool call and returns the `DynamicToolCallResponse`.
    /// Anything wrong with the input or the process is the agent's answer, not an
    /// error of the protocol.
    pub async fn run(&self, input: &Value) -> Value {
        let call = match parse(input) {
            Ok(call) => call,
            Err(reason) => return response(false, format!("ticketd tool: {reason}")),
        };
        match self.execute(call).await {
            Ok(done) => done,
            Err(reason) => response(false, format!("ticketd tool: {reason}")),
        }
    }

    async fn execute(&self, call: Call) -> Result<Value, String> {
        let arguments: Vec<&str> = call.arguments.iter().map(String::as_str).collect();
        let serving = Serving::Chat {
            chat_id: &self.chat_id,
            run_id: self.run_id.as_deref(),
            ticketd_cli: None,
        };
        let mut process = command(&self.cli, &arguments, serving);
        process.current_dir(&self.working_directory);
        let mut child = process
            .spawn()
            .map_err(|error| format!("could not start the ticketd command line: {error}"))?;
        let mut stdin = child.stdin.take();
        // Written from its own task: a command that prints before it reads cannot
        // stall on a full pipe. Dropping the pipe ends the command's input.
        let input = call.stdin.unwrap_or_default();
        tokio::spawn(async move {
            if let Some(stdin) = stdin.as_mut() {
                let _ = stdin.write_all(input.as_bytes()).await;
            }
        });
        // The child is killed when this future is dropped at the deadline.
        let output = timeout(RUN_TIMEOUT, child.wait_with_output())
            .await
            .map_err(|_| format!("the command took over {} seconds", RUN_TIMEOUT.as_secs()))?
            .map_err(|error| format!("the command could not be read: {error}"))?;
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        let errors = String::from_utf8_lossy(&output.stderr);
        if !errors.trim().is_empty() {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(&errors);
        }
        if !output.status.success() {
            text.push_str(&format!("\n[exit {}]", output.status));
        }
        Ok(response(output.status.success(), bounded(&text)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(input: Value) -> String {
        match parse(&input) {
            Ok(_) => panic!("{input} should be refused"),
            Err(reason) => reason,
        }
    }

    #[test]
    fn the_agent_chooses_arguments_and_stdin_only() {
        let call = parse(&json!({"arguments": ["show", "T-1"], "stdin": "body"})).unwrap();
        assert_eq!(call.arguments, ["show", "T-1"]);
        assert_eq!(call.stdin.as_deref(), Some("body"));
        assert!(
            parse(&json!({"arguments": ["list"]}))
                .unwrap()
                .stdin
                .is_none()
        );

        refused(json!({"arguments": ["list"], "cwd": "/"}));
        refused(json!({"arguments": ["list"], "program": "sh"}));
        refused(json!({"arguments": "list"}));
        refused(json!({"arguments": []}));
        refused(json!({"arguments": ["list", 7]}));
        refused(json!({"arguments": ["list\0"]}));
        refused(json!({"arguments": ["list"], "stdin": 3}));
        refused(json!("show T-1"));
        refused(json!({"arguments": vec!["x"; MAX_ARGUMENTS + 1]}));
    }

    #[test]
    fn what_would_leave_the_runs_workspace_or_the_step_is_refused() {
        for input in [
            json!({"arguments": ["restore-workspace", "backup.db"]}),
            json!({"arguments": ["restore-workspace", "backup.db", "--target", "x.db"]}),
            json!({"arguments": ["skills", "install"]}),
        ] {
            assert!(refused(input).contains("not available to an agent"));
        }
        assert!(parse(&json!({"arguments": ["skills", "get", "chat"]})).is_ok());
    }

    #[test]
    fn the_declared_tool_takes_the_same_input_it_checks() {
        let spec = spec();
        assert_eq!(spec["name"], NAME);
        assert_eq!(spec["inputSchema"]["required"], json!(["arguments"]));
        assert_eq!(spec["inputSchema"]["additionalProperties"], json!(false));
    }

    /// Runs this test program as the "CLI": its arguments are real, and so are its
    /// exit status and output streams.
    fn tool() -> TicketTool {
        TicketTool {
            cli: std::env::current_exe().unwrap(),
            working_directory: std::env::temp_dir(),
            chat_id: "chat-1".into(),
            run_id: Some("run-1".into()),
        }
    }

    #[tokio::test]
    async fn a_command_that_succeeds_returns_its_output() {
        let done = tool().run(&json!({"arguments": ["--list"]})).await;
        assert_eq!(done["success"], json!(true));
        let text = done["contentItems"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("a_command_that_succeeds_returns_its_output"),
            "{text}"
        );
    }

    #[tokio::test]
    async fn a_command_that_fails_says_so_with_its_message() {
        let done = tool().run(&json!({"arguments": ["--no-such-flag"]})).await;
        assert_eq!(done["success"], json!(false));
        assert!(
            done["contentItems"][0]["text"]
                .as_str()
                .unwrap()
                .contains("[exit")
        );
    }

    #[tokio::test]
    async fn a_missing_program_is_the_agents_answer_not_a_crash() {
        let missing = TicketTool {
            cli: PathBuf::from("/no/such/ticketd"),
            ..tool()
        };
        let done = missing.run(&json!({"arguments": ["list"]})).await;
        assert_eq!(done["success"], json!(false));
    }

    #[test]
    fn long_output_is_cut_on_a_character_boundary() {
        let long = "é".repeat(MAX_OUTPUT_BYTES);
        let cut = bounded(&long);
        assert!(cut.len() < long.len());
        assert!(cut.ends_with("bytes]"));
    }
}
