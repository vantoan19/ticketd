use std::path::Path;
use std::process::Command;
use ticketd_core::FORMAT_VERSION;

// Clippy only exempts #[test] functions from the unwrap lint, not their helpers.
#[allow(clippy::unwrap_used)]
fn run(dir: &Path, args: &[&str]) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .args(args)
        .env("HOME", dir)
        .env("XDG_DATA_HOME", dir)
        .env("TICKETD_TEST_WORKSPACE", dir.join("workspace.sqlite3"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn workspace_prints_its_path_and_both_format_versions_as_json() {
    let dir = tempfile::tempdir().unwrap();
    // Create the workspace at the CLI's own format, the way any other command would.
    run(dir.path(), &["create", "First"]);
    let printed: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["workspace"])).unwrap();
    assert_eq!(
        printed["path"],
        // SQLite reports the resolved path (/private/var on macOS).
        std::fs::canonicalize(dir.path().join("workspace.sqlite3"))
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert_eq!(printed["format_version"], FORMAT_VERSION);
    assert_eq!(printed["supported_format_version"], FORMAT_VERSION);
    assert_eq!(printed.as_object().unwrap().len(), 3);
}

#[test]
fn workspace_does_not_create_a_missing_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let printed: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["workspace"])).unwrap();
    assert_eq!(printed["format_version"], serde_json::Value::Null);
    assert_eq!(printed["supported_format_version"], FORMAT_VERSION);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn workspace_does_not_migrate_an_older_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("workspace.sqlite3");
    run(dir.path(), &["create", "First"]);
    // Rewrite the "user version" field of the SQLite header (bytes 60..64) to 19.
    let mut bytes = std::fs::read(&file).unwrap();
    bytes[60..64].copy_from_slice(&19_u32.to_be_bytes());
    std::fs::write(&file, &bytes).unwrap();
    let printed: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["workspace"])).unwrap();
    assert_eq!(printed["format_version"], 19);
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
    // No pre-migration copy was made either.
    let files: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
    assert!(files.iter().all(|entry| {
        !entry
            .as_ref()
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("pre-migration")
    }));
}

/// The Settings quick reference shows these forms with placeholders filled in.
#[test]
fn settings_quick_reference_commands_run() {
    let dir = tempfile::tempdir().unwrap();
    let checkout = dir.path().join("checkout");
    std::fs::create_dir(&checkout).unwrap();
    let project: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["project", "create", "Reference", checkout.to_str().unwrap()],
    ))
    .unwrap();
    let project = project["id"].as_str().unwrap();
    run(
        dir.path(),
        &["create", "Quick reference", "--project", project],
    );
    let note = dir.path().join("note.md");
    std::fs::write(&note, "Finding").unwrap();

    run(
        dir.path(),
        &["list", "--project", project, "--availability", "ready"],
    );
    run(
        dir.path(),
        &[
            "context",
            "T-1",
            "--relationships",
            "--activities",
            "--evidence",
        ],
    );
    run(
        dir.path(),
        &[
            "activity",
            "add",
            "T-1",
            "--file",
            note.to_str().unwrap(),
            "--agent",
            "codex",
        ],
    );
}

#[test]
fn documents_can_be_created_edited_and_reopened_via_cli() {
    let dir = tempfile::tempdir().unwrap();
    let created: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["document", "create", "--body", "First thought"],
    ))
    .unwrap();
    let id = created["id"].as_str().unwrap();
    run(
        dir.path(),
        &["document", "change", id, "--title", "A title"],
    );
    let opened: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "open", id])).unwrap();
    assert_eq!(opened["title"], "A title");
    assert_eq!(opened["body"], "First thought");
    let recent: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "recent"])).unwrap();
    assert_eq!(recent[0]["id"], id);
    run(dir.path(), &["document", "trash", id]);
    let recent: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "recent"])).unwrap();
    assert_eq!(recent.as_array().unwrap().len(), 0);
    let trashed: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "trash-list"])).unwrap();
    assert_eq!(trashed[0]["id"], id);
    let opened: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "open", id])).unwrap();
    assert_eq!(opened["trashed"], true);
    run(dir.path(), &["document", "restore", id]);
    let restored: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "show", id])).unwrap();
    assert_eq!(restored["body"], "First thought");
    assert_eq!(restored["trashed"], false);
}

#[test]
fn document_ticket_and_backlinks_are_available_to_agents() {
    let dir = tempfile::tempdir().unwrap();
    let document: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["document", "create", "--body", "Investigation"],
    ))
    .unwrap();
    let id = document["id"].as_str().unwrap();
    let ticket: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "create-ticket", id, "Task"])).unwrap();
    let links: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "backlinks", id])).unwrap();
    assert_eq!(links[0]["source_reference"], ticket["reference"]);
}

#[test]
fn documents_can_be_searched_pinned_and_tagged_via_cli() {
    let dir = tempfile::tempdir().unwrap();
    let created: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["document", "create", "--body", "A compass in the forest"],
    ))
    .unwrap();
    let id = created["id"].as_str().unwrap();
    run(dir.path(), &["document", "pin", id]);
    run(dir.path(), &["document", "tag", id, "research"]);
    let results: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["document", "search", "compass", "--tag", "research"],
    ))
    .unwrap();
    assert_eq!(results[0]["id"], id);
    let pins: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "pins"])).unwrap();
    assert_eq!(pins[0]["id"], id);
}

#[test]
fn document_read_returns_bounded_text_and_continuation() {
    let dir = tempfile::tempdir().unwrap();
    let created: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["document", "create", "--body", "abécdef"],
    ))
    .unwrap();
    let id = created["id"].as_str().unwrap();
    let result: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "read", id, "--limit", "3"])).unwrap();
    assert_eq!(result["body"], "abé");
    assert_eq!(result["next_offset"], 3);
    assert_eq!(result["id"], id);
}

#[test]
fn activity_details_can_be_found_and_kept_through_cli() {
    let dir = tempfile::tempdir().unwrap();
    run(dir.path(), &["create", "Outcome"]);
    let details = dir.path().join("details.md");
    std::fs::write(&details, "distinct findings").unwrap();
    let activity: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &[
            "activity",
            "add",
            "T-1",
            "--brief",
            "Update",
            "--details-file",
            details.to_str().unwrap(),
        ],
    ))
    .unwrap();
    let id = activity["supporting_document_id"].as_str().unwrap();
    let hidden: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "search", "distinct"])).unwrap();
    assert_eq!(hidden.as_array().unwrap().len(), 0);
    let included: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["document", "search", "distinct", "--include-support"],
    ))
    .unwrap();
    assert_eq!(included[0]["origin_ticket"], "T-1");
    run(dir.path(), &["document", "keep", id]);
    let found: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "search", "distinct"])).unwrap();
    assert_eq!(found[0]["id"], id);
}

#[test]
fn plan_progress_recent_context_and_spec_recency_work_through_cli() {
    let dir = tempfile::tempdir().unwrap();
    let invoke = |args: &[&str]| -> serde_json::Value {
        serde_json::from_str(&run(dir.path(), args)).unwrap()
    };
    let plan = invoke(&["plan", "create", "Plan"]);
    let id = plan["id"].as_str().unwrap();
    assert_eq!(
        invoke(&["list", "--plan", id, "--latest-update"]),
        serde_json::json!([])
    );
    invoke(&["create", "Work", "--plan", id]);
    for n in 1..=22 {
        invoke(&["activity", "add", "T-1", "--brief", &format!("Report {n}")]);
    }
    let list = invoke(&["list", "--plan", id, "--latest-update"]);
    assert_eq!(list[0]["latest_update"]["brief"]["text"], "Report 22");
    let context = invoke(&["context", "T-1", "--activities"]);
    assert_eq!(
        context["activities"]["items"][0]["brief"]["text"],
        "Report 22"
    );
    assert_eq!(
        context["activities"]["items"][19]["brief"]["text"],
        "Report 3"
    );
    assert_eq!(context["activities"]["next_offset"], 20);
    let earlier = invoke(&["document", "create", "--title", "Earlier", "--body", "a"]);
    let latest = invoke(&["document", "create", "--title", "Latest", "--body", "b"]);
    invoke(&["plan", "spec", id, earlier["id"].as_str().unwrap()]);
    let recent = invoke(&["document", "recent"]);
    assert_eq!(recent[0]["id"], latest["id"]);
    assert_eq!(recent[1]["id"], earlier["id"]);
}

#[test]
fn document_trash_cli_pages_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let invoke = |args: &[&str]| -> serde_json::Value {
        serde_json::from_str(&run(dir.path(), args)).unwrap()
    };
    for title in ["One", "Two", "Three"] {
        let doc = invoke(&[
            "document",
            "create",
            "--title",
            title,
            "--body",
            "Large body",
        ]);
        invoke(&["document", "trash", doc["id"].as_str().unwrap()]);
    }
    let first = invoke(&["document", "trash-list", "--limit", "2"]);
    let second = invoke(&["document", "trash-list", "--limit", "2", "--offset", "2"]);
    assert_eq!(first.as_array().unwrap().len(), 2);
    assert_eq!(second.as_array().unwrap().len(), 1);
    assert!(first[0].get("body").is_none());
    assert_ne!(first[0]["id"], second[0]["id"]);
}
