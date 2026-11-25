//! The JSON every command prints follows four rules, because agents parse it:
//! counts are snake_case, a write with nothing to return prints `{"ok":true}`, keys
//! keep the declaration order of the record they describe, and `latest_update` has
//! one shape.

use std::path::Path;
use std::process::Command;

// Clippy only exempts #[test] functions from the unwrap lint, not their helpers.
#[allow(clippy::unwrap_used)]
fn text(dir: &Path, args: &[&str]) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .args(args)
        .env("HOME", dir)
        .env("XDG_DATA_HOME", dir)
        .env("TICKETD_TEST_WORKSPACE", dir.join("workspace.sqlite3"))
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim_end().into()
}

#[allow(clippy::unwrap_used)]
fn json(dir: &Path, args: &[&str]) -> serde_json::Value {
    serde_json::from_str(&text(dir, args)).unwrap()
}

#[test]
fn plan_context_counts_use_the_same_snake_case_keys_as_plan_show() {
    let dir = tempfile::tempdir().unwrap();
    let plan = json(dir.path(), &["plan", "create", "Launch"]);
    let plan_id = plan["id"].as_str().unwrap();
    json(dir.path(), &["create", "One", "--plan", plan_id]);
    json(dir.path(), &["create", "Two", "--plan", plan_id]);
    json(dir.path(), &["change", "T-KQ2", "--status", "In progress"]);
    let context = text(dir.path(), &["plan", "context", plan_id]);
    let shown = text(dir.path(), &["plan", "show", plan_id]);
    let counts = |printed: &str| {
        serde_json::from_str::<serde_json::Value>(printed).unwrap()["counts"].clone()
    };
    assert_eq!(counts(&context), counts(&shown));
    assert_eq!(counts(&context)["todo"], 1);
    assert_eq!(counts(&context)["in_progress"], 1);
    assert!(counts(&context).get("Todo").is_none());
    // Counts print in declaration order, as `plan show` does, and ticket status
    // values keep their display spelling.
    assert!(context.contains(
        r#""counts":{"todo":1,"in_progress":1,"in_review":0,"done":0,"canceled":0,"duplicate":0}"#
    ));
    let printed: serde_json::Value = serde_json::from_str(&context).unwrap();
    assert_eq!(printed["tickets"][1]["status"], "In progress");
}

#[test]
fn writes_with_nothing_to_return_print_ok() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    json(path, &["create", "Ship"]);
    let evidence = json(
        path,
        &[
            "evidence", "add", "T-KQ1", "--kind", "branch", "--name", "B", "--value", "main",
        ],
    );
    let activity = json(path, &["activity", "add", "T-KQ1", "--brief", "Started"]);
    let document = json(path, &["document", "create", "--body", "Hello"]);
    let document = document["id"].as_str().unwrap();
    let ok = r#"{"ok":true}"#;
    assert_eq!(
        text(
            path,
            &[
                "evidence",
                "delete",
                "T-KQ1",
                evidence["id"].as_str().unwrap()
            ]
        ),
        ok
    );
    assert_eq!(
        text(
            path,
            &[
                "activity",
                "delete",
                "T-KQ1",
                activity["id"].as_str().unwrap()
            ]
        ),
        ok
    );
    assert_eq!(text(path, &["document", "tag", document, "design"]), ok);
    assert_eq!(text(path, &["document", "pin", document]), ok);
    let backup = path.join("export.json");
    assert_eq!(
        text(path, &["export", "--file", backup.to_str().unwrap()]),
        ok
    );
}

#[test]
fn document_writes_print_keys_in_the_order_document_show_does() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let document = json(path, &["document", "create", "--body", "Hello"]);
    let id = document["id"].as_str().unwrap();
    for command in ["keep", "trash", "restore"] {
        let printed = text(path, &["document", command, id]);
        assert_eq!(printed, text(path, &["document", "show", id]), "{command}");
        assert!(printed.starts_with(r#"{"id":"#), "{command}");
    }
    // Commands that build a page by hand also follow the record's own order.
    let page = text(path, &["document", "read", id]);
    assert!(
        page.starts_with(&format!(r#"{{"id":"{id}","title":"#)),
        "{page}"
    );
}

#[test]
fn latest_update_rows_carry_one_latest_update() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    json(path, &["create", "First"]);
    json(path, &["activity", "add", "T-KQ1", "--brief", "Hi"]);
    let plain = json(path, &["list"]);
    for rows in [
        json(path, &["list", "--latest-update"]),
        json(path, &["search", "First", "--latest-update"]),
    ] {
        let row = &rows[0];
        assert_eq!(row["latest_update"]["brief"]["text"], "Hi");
        assert_eq!(row["latest_update"].as_object().unwrap().len(), 6);
        let ticket = row["ticket"].as_object().unwrap();
        assert!(!ticket.contains_key("latest_update"));
        // Everything else about the ticket is what a plain list prints.
        let mut expected = plain[0].as_object().unwrap().clone();
        expected.remove("latest_update");
        assert_eq!(*ticket, expected);
    }
    // The raw text keeps the ticket's own order and puts the update after it.
    let raw = text(path, &["list", "--latest-update"]);
    assert!(raw.starts_with(r#"[{"ticket":{"id":"#), "{raw}");
    assert!(
        raw.contains(r#"},"latest_update":{"activity_id":"#),
        "{raw}"
    );
}

#[test]
fn reminders_backups_and_restores_print_json() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    json(path, &["create", "Remember"]);
    assert_eq!(
        text(path, &["reminder", "show", "T-KQ1"]),
        r#"{"reference":"T-KQ1","due_at":null}"#
    );
    let set = json(path, &["reminder", "set", "T-KQ1", "2030-01-01T00:00:00Z"]);
    assert_eq!(set["reference"], "T-KQ1");
    assert!(set["due_at"].as_str().unwrap().starts_with("2030-01-01"));
    assert_eq!(
        text(path, &["reminder", "dismiss", "T-KQ1"]),
        r#"{"dismissed":true}"#
    );
    assert_eq!(
        text(path, &["reminder", "dismiss", "T-KQ1"]),
        r#"{"dismissed":false}"#
    );
    let backup = path.join("backup.sqlite3");
    let backup = backup.to_str().unwrap();
    assert_eq!(json(path, &["backup", backup])["path"], backup);
    let restored = json(path, &["restore-workspace", backup]);
    assert!(restored["restored"].is_string());
    assert!(restored["safety_backup"].is_string());
}

#[test]
fn a_documents_one_line_summary_is_set_changed_and_cleared_and_shown_in_json() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let plain = json(path, &["document", "create", "--body", "Hello"]);
    assert!(plain["summary"].is_null());

    let created = json(
        path,
        &[
            "document",
            "create",
            "--title",
            "Report",
            "--summary",
            "Shipped in a1b2c3d.\nOne open question.",
            "--body",
            "# Report\n\nA long body.",
        ],
    );
    let id = created["id"].as_str().unwrap();
    // A line break is collapsed to a space.
    assert_eq!(created["summary"], "Shipped in a1b2c3d. One open question.");

    let summary_of = |rows: serde_json::Value| rows[0]["summary"].clone();
    assert_eq!(
        json(path, &["document", "show", id])["summary"],
        "Shipped in a1b2c3d. One open question."
    );
    assert_eq!(
        summary_of(json(path, &["document", "search", "Report"])),
        "Shipped in a1b2c3d. One open question."
    );
    let recent = json(path, &["document", "recent"]);
    let row = recent
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == id)
        .unwrap();
    assert_eq!(row["summary"], "Shipped in a1b2c3d. One open question.");
    assert_eq!(
        json(path, &["document", "read", id])["summary"],
        "Shipped in a1b2c3d. One open question."
    );

    // A change of summary alone is a change; the body stays.
    let changed = json(path, &["document", "change", id, "--summary", "Done."]);
    assert_eq!(changed["summary"], "Done.");
    assert_eq!(changed["body"], "# Report\n\nA long body.");
    // A change of body alone keeps the summary.
    let edited = json(path, &["document", "change", id, "--body", "New."]);
    assert_eq!(edited["summary"], "Done.");

    // An empty value clears it.
    let cleared = json(path, &["document", "change", id, "--summary", ""]);
    assert!(cleared["summary"].is_null());
    assert!(json(path, &["document", "show", id])["summary"].is_null());
}
