//! The export fixture: every shape of event and span ticketd emits, each with planted content
//! in the fields the export does not allow. Whatever a person types, a Harness says or an
//! error quotes must not reach the bundle; a new field is left out until it is allowed on
//! purpose. When code starts emitting a new shape, add it here.

use std::fs;
use std::io::Read;

use ticketd_diagnostics::{Config, DesktopLogs, Facts};

/// Planted in every field that is not allowed; the test looks for it in the bundle.
const SECRET: &str = "SECRET-Quarterly-plan-for-jdoe";

#[test]
fn nothing_planted_in_a_field_the_export_does_not_allow_survives() {
    let logs_dir = tempfile::tempdir().unwrap();
    let out = tempfile::tempdir().unwrap();
    let logs = DesktopLogs::open(
        logs_dir.path(),
        Config {
            filter_override: Some("trace".into()),
            ..Config::default()
        },
    );

    logs.with_default(|| {
        // Events as the desktop, the chat host and the Automation runner emit them today.
        tracing::warn!(target: "ticketd_desktop_lib", error_kind = "offline", error = SECRET, "periodic source refresh could not run");
        tracing::warn!(target: "ticketd_desktop_lib::chats", action = "send", error_kind = "chat_failed", error = SECRET, "a Chat action could not be done");
        tracing::warn!(target: "ticketd_automation_runner", automation_run_id = "run-1", "Automation run ended");
        tracing::warn!(target: "ticketd_automation_runner", automation_run_id = "run-1", error_kind = "io", error = SECRET, "Automation run could not be ended");
        tracing::warn!(target: "ticketd_automation_runner", chat_id = "chat-1", "the agent in a Chat may still be running");
        tracing::info!(target: "ticketd_desktop_lib", version = "0.1.0", "ticketd started");
        tracing::error!(target: "ticketd_desktop_lib", error_kind = "other", error = SECRET, "the Automation runner could not start");
        tracing::warn!(target: "ticketd_desktop_lib", error = SECRET, "could not display startup guidance");
        // A dependency's warning carries its own fields.
        tracing::warn!(target: "hyper::client", url = SECRET, "connection failed");

        // Events from the crash and forwarding work: a panic, a WebView error and a Harness
        // stderr line, with the words of the person or the Harness in their fields.
        tracing::error!(target: "ticketd_diagnostics::crash", location = "crates/core/src/lib.rs:10:5", thread = "main", panic_message = "static literal", "panic");
        tracing::error!(target: "ticketd_diagnostics::crash", location = "crates/core/src/lib.rs:10:5", thread = "main", "panic");
        tracing::warn!(target: "ticketd_diagnostics::desktop", previous_started_at = "2026-11-18T07:45:00.000Z", extra = SECRET, "previous session ended unexpectedly");
        tracing::error!(target: "webview", error_kind = "TypeError", error = SECRET, route = "/tickets", repeat_count = 3, frames = "at render (app.js:1:1)", name = SECRET, stack = SECRET, "uncaught WebView error");
        tracing::debug!(target: "ticketd_chat_host::harness_stderr", harness = "codex", line = SECRET, "harness stderr");
        tracing::info!(target: "ticketd_desktop_lib::diagnostics_commands", bytes = 1024, path = SECRET, "diagnostics exported");

        // Spans carry IDs, and may carry more than they should.
        let pass = tracing::info_span!(target: "ticketd_desktop_lib::sync_scheduler", "sync_pass", source_id = "src-1", title = SECRET);
        let turn = tracing::info_span!(target: "ticketd_chat_host", "chat_turn", chat_id = "chat-1", prompt = SECRET);
        let run = tracing::info_span!(target: "ticketd_automation_runner", "automation_run", automation_run_id = "run-1", ticket_title = SECRET);
        let command = tracing::info_span!(target: "ticketd_desktop_lib", "command", request_id = "req-1", ticket_ref = "TK-1", args = SECRET);
        let desktop_command = tracing::debug_span!(target: "ticketd_desktop_lib", "command", command = "list_tickets", payload = SECRET);
        let chat = tracing::info_span!(target: "ticketd_chat_host", "chat", chat_id = "chat-1", automation_run_id = "run-1", prompt = SECRET);
        let refresh = tracing::info_span!(target: "ticketd_core::source", "source_refresh", ticket_ref = "TK-1", query = SECRET);
        for span in [&pass, &turn, &run, &command, &desktop_command, &chat, &refresh] {
            span.in_scope(|| {
                tracing::warn!(target: "ticketd_core::sync", error_kind = "offline", error = SECRET, body = SECRET, "sync pass failed");
            });
        }
    });

    let exported = logs.export(out.path(), &Facts::default()).unwrap();

    let mut archive = zip::ZipArchive::new(fs::File::open(&exported.path).unwrap()).unwrap();
    let mut all = String::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).unwrap();
        file.read_to_string(&mut all).unwrap();
    }
    assert!(!all.contains("SECRET"), "planted content in the bundle");
    assert!(!all.contains("jdoe"), "planted content in the bundle");
    // The lines themselves were kept: what is left out is the fields, not the events.
    for kept in [
        "periodic source refresh could not run",
        "Automation run ended",
        "sync pass failed",
        "uncaught WebView error",
        "\"chat_id\":\"chat-1\"",
        "\"request_id\":\"req-1\"",
        "\"automation_run_id\":\"run-1\"",
        "\"error_kind\":\"offline\"",
        "\"name\":\"sync_pass\"",
        "\"name\":\"chat_turn\"",
        "\"ticket_ref\":\"TK-1\"",
        "\"source_id\":\"src-1\"",
        "\"location\":\"crates/core/src/lib.rs:10:5\"",
        "\"panic_message\":\"static literal\"",
        "\"previous_started_at\":\"2026-11-18T07:45:00.000Z\"",
        "\"route\":\"/tickets\"",
        "\"repeat_count\":3",
        "\"frames\":\"at render (app.js:1:1)\"",
        "\"error_kind\":\"TypeError\"",
        "\"harness\":\"codex\"",
        "\"command\":\"list_tickets\"",
        "harness stderr",
    ] {
        assert!(all.contains(kept), "{kept} missing from the bundle");
    }
}
