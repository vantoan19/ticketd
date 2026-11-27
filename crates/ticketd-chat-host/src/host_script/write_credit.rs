//! Write credit through the whole host: scripted harness traffic opens shell Steps, and at
//! the marks the **real** `ticketd` CLI runs against the temporary Workspace as the
//! harness's command would, with the Chat and per-call variables in its environment. What
//! the Workspace then says each write is credited to is asserted.
//!
//! The CLI is the executable `cargo build -p ticketd-cli` leaves beside the test binaries
//! (`cargo test --workspace` builds it too). It only ever sees the temporary Workspace:
//! `TICKETD_TEST_WORKSPACE` and `XDG_DATA_HOME` are set in the same command.

use std::path::PathBuf;
use std::process::Command;

use super::{HostScript, fixture};
use ticketd_core::{CHAT_ID_VARIABLE, ChatWriteCredit};

fn ticketd_binary() -> PathBuf {
    let test = std::env::current_exe().expect("the test executable");
    let binary = test
        .parent()
        .and_then(std::path::Path::parent)
        .expect("target/debug")
        .join(if cfg!(windows) {
            "ticketd.exe"
        } else {
            "ticketd"
        });
    assert!(
        binary.exists(),
        "{} is missing: run `cargo build -p ticketd-cli` first",
        binary.display()
    );
    binary
}

/// What the harness's command does: `ticketd activity add` as the Chat's agent.
fn add_activity(h: &HostScript, call_key: Option<&str>, brief: &str) {
    let path = h.workspace_path();
    let mut command = Command::new(ticketd_binary());
    command
        .args(["activity", "add", "T-KQ1", "--brief", brief])
        .env("TICKETD_TEST_WORKSPACE", path)
        .env("XDG_DATA_HOME", path.parent().expect("a folder"))
        .env(CHAT_ID_VARIABLE, h.chat_id())
        .env_remove("CODEX_TOOL_CALL_ID")
        .env_remove("CODEX_THREAD_ID");
    if let Some(key) = call_key {
        command.env("CODEX_TOOL_CALL_ID", key);
    }
    let output = command.output().expect("ticketd runs");
    assert!(
        output.status.success(),
        "ticketd failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// The sub-agent each Activity is credited to, by brief; `None` is the Chat alone.
fn credits(h: &HostScript) -> Vec<(String, Option<String>)> {
    let core = h.core();
    let credits = core.ticket_write_credits("T-KQ1").expect("credits");
    let mut found: Vec<(String, Option<String>)> = core
        .activities("T-KQ1", 100, 0)
        .expect("activities")
        .into_iter()
        .filter_map(|activity| {
            let ChatWriteCredit { sub_agent, .. } = credits.activities.get(&activity.id)?.clone();
            Some((activity.brief, sub_agent))
        })
        .collect();
    found.sort();
    found
}

fn entry(brief: &str, sub_agent: Option<&str>) -> (String, Option<String>) {
    (brief.to_owned(), sub_agent.map(str::to_owned))
}

#[tokio::test(start_paused = true)]
async fn claude_writes_are_credited_by_the_shell_step_windows_open_when_they_commit() {
    let mut h = HostScript::claude()
        .process([
            fixture!("claude", "handshake"),
            fixture!("claude", "sub_agent_shell"),
        ])
        .start();
    let ticket = h.core().create_ticket("Review the rate limiter").unwrap();
    assert_eq!(ticket.reference, "T-KQ1");
    h.send("Review the rate limiter").await;
    h.play_to("the SDK took the input").await;

    // One sub-agent's command is open: its write is that sub-agent's.
    h.play_to("the first sub-agent's command started").await;
    add_activity(&h, None, "Inside one window");
    // No command is open: the Chat's alone.
    h.play_to("the first command ended").await;
    add_activity(&h, None, "Outside every window");
    // Two commands are open, and only one names an Activity: that one's.
    h.play_to("one sub-agent runs ticketd while the other runs tests")
        .await;
    add_activity(&h, None, "Only one names an Activity");
    h.play_to("both sub-agents run ticketd").await;
    // Both name an Activity: the Chat, with the sub-agent unknown.
    add_activity(&h, None, "Either could have written this");
    h.play_all().await;
    h.finish().await;

    assert_eq!(
        credits(&h),
        [
            entry("Either could have written this", None),
            entry("Inside one window", Some("task_a")),
            entry("Only one names an Activity", Some("task_a")),
            entry("Outside every window", None),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn a_codex_write_is_credited_to_the_child_whose_command_the_key_names() {
    let mut h = HostScript::codex()
        .process([
            fixture!("codex", "handshake"),
            fixture!("codex", "sub_agent"),
        ])
        .start();
    h.core().create_ticket("Review the rate limiter").unwrap();
    h.send("Have a sub-agent run echo hi").await;
    h.play_to("the sub-agent runs its command").await;

    // The command's own key names its Step, so its sub-agent.
    add_activity(
        &h,
        Some("exec-00000000-0000-4000-8000-000000000005"),
        "From the child's command",
    );
    // A key no Step has is never guessed from the window that happens to be open.
    add_activity(&h, Some("exec-unknown"), "A command nobody recorded");
    h.play_all().await;
    h.finish().await;

    assert_eq!(
        credits(&h),
        [
            entry("A command nobody recorded", None),
            entry(
                "From the child's command",
                Some("00000000-0000-4000-8000-000000000003")
            ),
        ]
    );
}
