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
            "T-KQ1",
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
            "T-KQ1",
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
fn a_document_can_be_attached_to_a_ticket_and_detached_without_editing_its_description() {
    let dir = tempfile::tempdir().unwrap();
    let ticket: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["create", "Task"])).unwrap();
    let reference = ticket["reference"].as_str().unwrap();
    let document: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["document", "create", "--body", "Investigation"],
    ))
    .unwrap();
    let id = document["id"].as_str().unwrap();
    let attached: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &[
            "document",
            "link-ticket",
            id,
            reference,
            "--request-id",
            "r-1",
        ],
    ))
    .unwrap();
    assert_eq!(attached["body"], ticket["body"]);
    let context: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["context", reference, "--documents"])).unwrap();
    assert_eq!(context["documents"]["items"][0]["id"], id);
    let incoming: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "incoming", id])).unwrap();
    assert_eq!(incoming[0]["explicit"], true);
    run(dir.path(), &["document", "unlink-ticket", id, reference]);
    let context: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["context", reference, "--documents"])).unwrap();
    assert!(context["documents"]["items"].as_array().unwrap().is_empty());
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
            "T-KQ1",
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
    assert_eq!(included[0]["origin_ticket"], "T-KQ1");
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
        invoke(&[
            "activity",
            "add",
            "T-KQ1",
            "--brief",
            &format!("Report {n}"),
        ]);
    }
    let list = invoke(&["list", "--plan", id, "--latest-update"]);
    assert_eq!(list[0]["latest_update"]["brief"]["text"], "Report 22");
    let context = invoke(&["context", "T-KQ1", "--activities"]);
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

#[test]
fn context_documents_include_mentioned_documents_with_their_source() {
    let dir = tempfile::tempdir().unwrap();
    run(dir.path(), &["create", "Task"]);
    let document: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["document", "create", "--body", "Investigation"],
    ))
    .unwrap();
    let id = document["id"].as_str().unwrap();
    run(
        dir.path(),
        &[
            "activity",
            "add",
            "T-KQ1",
            "--brief",
            &format!("See [it](ticketd://document/{id})"),
        ],
    );
    let context: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["context", "T-KQ1", "--documents"])).unwrap();
    let item = &context["documents"]["items"][0];
    assert_eq!(item["id"], id);
    assert_eq!(item["source"], "update");
    assert!(item["activity_id"].is_string());
}

#[test]
fn linking_activity_details_to_a_ticket_keeps_them_through_cli() {
    let dir = tempfile::tempdir().unwrap();
    run(dir.path(), &["create", "Outcome"]);
    let details = dir.path().join("details.md");
    std::fs::write(&details, "linked findings").unwrap();
    let activity: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &[
            "activity",
            "add",
            "T-KQ1",
            "--brief",
            "Update",
            "--details-file",
            details.to_str().unwrap(),
        ],
    ))
    .unwrap();
    let id = activity["supporting_document_id"].as_str().unwrap();
    run(dir.path(), &["document", "link-ticket", id, "T-KQ1"]);
    let found: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["document", "search", "linked"])).unwrap();
    assert_eq!(found[0]["id"], id);
}

#[test]
fn project_create_detects_the_remote_and_show_and_list_include_it() {
    let dir = tempfile::tempdir().unwrap();
    let checkout = dir.path().join("checkout");
    git_checkout(&checkout, "git@ghe.example.com:Team/Package.git");
    let created: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["project", "create", "Package", checkout.to_str().unwrap()],
    ))
    .unwrap();
    assert_eq!(created["remote"], "ghe.example.com/Team/Package");
    let id = created["id"].as_str().unwrap();
    let shown: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["project", "show", id])).unwrap();
    let listed: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["project", "list"])).unwrap();
    assert_eq!(shown["remote"], created["remote"]);
    assert_eq!(listed[0]["remote"], created["remote"]);
}

#[test]
fn project_remote_flags_override_detection_and_edit_the_remote() {
    let dir = tempfile::tempdir().unwrap();
    let alpha = dir.path().join("alpha");
    let beta = dir.path().join("beta");
    for checkout in [&alpha, &beta] {
        git_checkout(checkout, "git@ghe.example.com:Team/Package.git");
    }
    let alpha: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &[
            "project",
            "create",
            "Alpha",
            alpha.to_str().unwrap(),
            "--remote",
            "ghe.example.com/Other/Package",
        ],
    ))
    .unwrap();
    assert_eq!(alpha["remote"], "ghe.example.com/Other/Package");

    let beta_path = beta.to_str().unwrap();
    let beta: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["project", "create", "Beta", beta_path, "--no-remote"],
    ))
    .unwrap();
    assert_eq!(beta["remote"], serde_json::Value::Null);

    let id = beta["id"].as_str().unwrap();
    let edited: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &[
            "project",
            "edit",
            id,
            "Beta",
            beta_path,
            "--remote",
            "ghe.example.com/Team/Package",
        ],
    ))
    .unwrap();
    assert_eq!(edited["remote"], "ghe.example.com/Team/Package");

    let cleared: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["project", "edit", id, "Beta", beta_path, "--clear-remote"],
    ))
    .unwrap();
    assert_eq!(cleared["remote"], serde_json::Value::Null);
}

#[test]
fn project_register_warns_about_a_remote_mismatch_and_still_registers() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("original");
    let other = dir.path().join("other");
    let matching = dir.path().join("matching");
    let expected = "ghe.example.com/Team/Package";
    let different = "ghe.example.com/Other/Fork";
    std::fs::create_dir(&original).unwrap();
    git_checkout(&other, "git@ghe.example.com:Other/Fork.git");
    git_checkout(&matching, "git@ghe.example.com:TEAM/package.git");
    let project: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &[
            "project",
            "create",
            "Package",
            original.to_str().unwrap(),
            "--remote",
            expected,
        ],
    ))
    .unwrap();
    let id = project["id"].as_str().unwrap();

    for (path, mismatch) in [(&other, true), (&matching, false)] {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(["project", "register", id, path.to_str().unwrap()])
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path())
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .output()
            .unwrap();
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(output.status.success(), "{stderr}");
        assert_eq!(stderr.contains("warning:"), mismatch, "{stderr}");
        if mismatch {
            assert!(
                stderr.contains(expected) && stderr.contains(different),
                "{stderr}"
            );
        }
        let registered: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(registered["remote"], expected);
        let canonical = std::fs::canonicalize(path).unwrap();
        assert!(
            registered["paths"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == canonical.to_str().unwrap())
        );
    }
}

#[cfg(unix)]
#[test]
fn project_writes_return_saved_json_when_stderr_is_closed() {
    use std::{os::unix::net::UnixStream, process::Stdio};

    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("original");
    let other = dir.path().join("other");
    let remote = "ghe.example.com/Team/Package";
    std::fs::create_dir(&original).unwrap();
    git_checkout(&other, "git@ghe.example.com:Other/Fork.git");

    let run_with_closed_stderr = |args: &[&str]| -> serde_json::Value {
        let (reader, writer) = UnixStream::pair().unwrap();
        drop(reader);
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path())
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .stderr(Stdio::from(std::os::fd::OwnedFd::from(writer)))
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}: {}", output.status);
        serde_json::from_slice(&output.stdout).unwrap()
    };
    let created = run_with_closed_stderr(&[
        "project",
        "create",
        "Package",
        original.to_str().unwrap(),
        "--remote",
        remote,
    ]);
    assert_eq!(created["remote"], remote);
    let id = created["id"].as_str().unwrap();
    let registered = run_with_closed_stderr(&["project", "register", id, other.to_str().unwrap()]);
    let canonical = std::fs::canonicalize(other).unwrap();
    assert!(
        registered["paths"]
            .as_array()
            .unwrap()
            .iter()
            .any(|path| path == canonical.to_str().unwrap())
    );
    let persisted: serde_json::Value =
        serde_json::from_str(&run(dir.path(), &["project", "show", id])).unwrap();
    assert_eq!(registered, persisted);
}

#[allow(clippy::unwrap_used)]
fn git_checkout(path: &Path, origin: &str) {
    std::fs::create_dir(path).unwrap();
    for args in [
        &["init", "--quiet", "--template="][..],
        &["remote", "add", "origin", origin][..],
    ] {
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(path)
                .args(args)
                .status()
                .unwrap()
                .success()
        );
    }
}

#[test]
fn project_commands_refuse_a_checkout_folder_registered_elsewhere() {
    let dir = tempfile::tempdir().unwrap();
    let taken = dir.path().join("taken");
    let free = dir.path().join("free");
    std::fs::create_dir(&taken).unwrap();
    std::fs::create_dir(&free).unwrap();
    run(
        dir.path(),
        &["project", "create", "Alpha", taken.to_str().unwrap()],
    );
    let beta: serde_json::Value = serde_json::from_str(&run(
        dir.path(),
        &["project", "create", "Beta", free.to_str().unwrap()],
    ))
    .unwrap();
    let beta = beta["id"].as_str().unwrap();
    let failing: [&[&str]; 2] = [
        &["project", "create", "Gamma", taken.to_str().unwrap()],
        &["project", "register", beta, taken.to_str().unwrap()],
    ];
    for args in failing {
        let output = Command::new(env!("CARGO_BIN_EXE_ticketd"))
            .args(args)
            .env("HOME", dir.path())
            .env("XDG_DATA_HOME", dir.path())
            .env(
                "TICKETD_TEST_WORKSPACE",
                dir.path().join("workspace.sqlite3"),
            )
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("This folder is registered to Alpha."),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn a_write_through_the_cli_is_marked_for_sync() {
    use ticketd_core::{Workspace, sync::RecordKind};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    run(dir.path(), &["create", "First"]);
    let mut workspace = Workspace::open(&path).unwrap();
    let first = workspace.dirty_records().unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].kind, RecordKind::Ticket);
    assert!(workspace.clear_dirty(&first[0]).unwrap());
    drop(workspace);

    // The desktop is not running: the CLI's own process leaves the mark.
    run(dir.path(), &["create", "Second"]);

    let dirty = Workspace::open(&path).unwrap().dirty_records().unwrap();
    assert_eq!(dirty.len(), 1);
    assert_ne!(dirty[0].id, first[0].id);
}

/// The desktop's warm session (ADR 0016) lets go of the Workspace when a restore in
/// another process asks: the CLI gets it within its two-second wait, and on Windows
/// replaces a file the session had open.
#[test]
fn restore_takes_the_workspace_from_a_warm_session_in_another_process() {
    let dir = tempfile::tempdir().unwrap();
    run(dir.path(), &["create", "Before"]);
    let backup = dir.path().join("backup.sqlite3");
    run(dir.path(), &["backup", backup.to_str().unwrap()]);
    run(dir.path(), &["create", "After the backup"]);
    let session =
        ticketd_core::WorkspaceSession::for_file(dir.path().join("workspace.sqlite3")).unwrap();
    assert_eq!(
        session.workspace().unwrap().list_tickets().unwrap().len(),
        2
    );

    run(dir.path(), &["restore-workspace", backup.to_str().unwrap()]);

    let titles: Vec<_> = session
        .workspace()
        .unwrap()
        .list_tickets()
        .unwrap()
        .into_iter()
        .map(|ticket| ticket.title)
        .collect();
    assert_eq!(titles, ["Before"]);
}

#[test]
fn document_lists_carry_each_rows_plans_tickets_and_unopened_state() {
    let dir = tempfile::tempdir().unwrap();
    let json = |args: &[&str]| -> serde_json::Value {
        serde_json::from_str(&run(dir.path(), args)).unwrap()
    };
    let plan = json(&["plan", "create", "Launch"]);
    let plan = plan["id"].as_str().unwrap();
    run(dir.path(), &["create", "Ship it"]);
    let created = json(&[
        "document",
        "create",
        "--title",
        "Launch notes",
        "--body",
        "steps",
    ]);
    let id = created["id"].as_str().unwrap();
    run(dir.path(), &["plan", "spec", plan, id]);
    run(dir.path(), &["document", "link-ticket", id, "T-KQ1"]);
    run(dir.path(), &["document", "pin", id]);

    for rows in [
        json(&["document", "recent"]),
        json(&["document", "pins"]),
        json(&["document", "search", "steps"]),
    ] {
        let row = &rows[0];
        assert_eq!(row["id"], id);
        assert_eq!(
            row["plans"],
            serde_json::json!([{"id": plan, "name": "Launch", "archived": false, "spec": true}])
        );
        assert_eq!(
            row["tickets"],
            serde_json::json!([{"reference": "T-KQ1", "title": "Ship it", "status": "Todo"}])
        );
        assert_eq!(row["opened"], true);
    }
}
