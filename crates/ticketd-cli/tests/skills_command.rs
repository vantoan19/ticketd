use serde_json::{Value, json};
use std::path::Path;
use std::process::{Command, Output};

#[allow(clippy::unwrap_used)]
fn invoke(directory: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .args(args)
        .current_dir(directory)
        .env(
            "TICKETD_TEST_WORKSPACE",
            directory.join("workspace.sqlite3"),
        )
        .output()
        .unwrap()
}

#[allow(clippy::unwrap_used)]
fn run(directory: &Path, args: &[&str]) -> String {
    let output = invoke(directory, args);
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[allow(clippy::unwrap_used)]
fn data(directory: &Path, args: &[&str]) -> Value {
    serde_json::from_str(&run(directory, args)).unwrap()
}

#[test]
fn version_and_nested_help_start_without_opening_a_workspace() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        run(dir.path(), &["--version"]).trim(),
        concat!("ticketd ", env!("CARGO_PKG_VERSION"))
    );
    run(dir.path(), &["skills", "install", "--help"]);
    run(dir.path(), &["source", "resolve", "--help"]);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn bundled_guides_work_without_opening_or_creating_a_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let list = data(dir.path(), &["skills", "list"]);
    assert_eq!(list["version"], env!("CARGO_PKG_VERSION"));
    assert!(!list["guides"].as_array().unwrap().is_empty());
    assert_eq!(
        run(dir.path(), &["skills", "get"]),
        run(dir.path(), &["skills", "get", "core"])
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

    let workspace = dir.path().join("workspace.sqlite3");
    std::fs::write(&workspace, "not a database").unwrap();
    for guide in list["guides"].as_array().unwrap() {
        let content = run(
            dir.path(),
            &["skills", "get", guide["name"].as_str().unwrap()],
        );
        assert!(content.starts_with(&format!(
            "ticketd CLI version: {}\n",
            env!("CARGO_PKG_VERSION")
        )));
    }
    let unknown = invoke(dir.path(), &["skills", "get", "../unknown"]);
    assert_eq!(unknown.status.code(), Some(1));
    assert!(unknown.stdout.is_empty());
    assert!(String::from_utf8_lossy(&unknown.stderr).contains("ticketd skills list"));
    assert_eq!(
        std::fs::read_to_string(&workspace).unwrap(),
        "not a database"
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn installation_is_repeatable_and_preserves_differing_files_until_explicit_replacement() {
    let dir = tempfile::tempdir().unwrap();
    // Relative destinations work for either harness and can contain spaces.
    let destination = "agent skills/ticketd";
    let skill = dir.path().join(destination).join("SKILL.md");
    run(dir.path(), &["skills", "install", destination]);
    let bundled = std::fs::read(&skill).unwrap();
    assert_eq!(bundled, include_bytes!("../../../skills/ticketd/SKILL.md"));
    run(dir.path(), &["skills", "install", destination]);
    let other = skill.with_file_name("custom.md");
    std::fs::write(&other, "keep this context").unwrap();
    std::fs::write(&skill, "user-edited skill").unwrap();

    let conflict = invoke(dir.path(), &["skills", "install", destination]);
    assert_eq!(conflict.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&conflict.stderr).contains("--replace"));
    assert_eq!(
        std::fs::read_to_string(&skill).unwrap(),
        "user-edited skill"
    );

    let replaced = run(dir.path(), &["skills", "install", destination, "--replace"]);
    assert_eq!(std::fs::read(&skill).unwrap(), bundled);
    assert_eq!(
        std::fs::read_to_string(&other).unwrap(),
        "keep this context"
    );
    // The replaced copy is saved beside the new one; the output names it.
    let backup = std::fs::read_dir(skill.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.to_string_lossy().contains("SKILL.md.backup-"))
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&backup).unwrap(),
        "user-edited skill"
    );
    let backup_name = backup.file_name().unwrap().to_string_lossy();
    assert!(replaced.contains(backup_name.as_ref()));
    assert!(!dir.path().join("workspace.sqlite3").exists());
}

#[test]
fn agent_installation_needs_a_known_agent_and_exactly_one_target() {
    let dir = tempfile::tempdir().unwrap();
    let unknown = invoke(dir.path(), &["skills", "install", "--agent", "nope"]);
    assert_eq!(unknown.status.code(), Some(1));
    let message = String::from_utf8_lossy(&unknown.stderr);
    assert!(message.contains("claude-code") && message.contains("codex"));
    assert!(!invoke(dir.path(), &["skills", "install"]).status.success());
    assert!(
        !invoke(dir.path(), &["skills", "install", "x", "--agent", "codex"])
            .status
            .success()
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn installation_refuses_a_directory_in_place_of_the_skill_file() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("ticketd/SKILL.md")).unwrap();
    let result = invoke(dir.path(), &["skills", "install", "ticketd", "--replace"]);
    assert_eq!(result.status.code(), Some(1));
    assert!(dir.path().join("ticketd/SKILL.md").is_dir());
    assert!(!dir.path().join("workspace.sqlite3").exists());
}

#[allow(clippy::unwrap_used)]
fn json_examples(guide: &str) -> Vec<Value> {
    guide
        .replace("\r\n", "\n")
        .split("```json\n")
        .skip(1)
        .map(|block| serde_json::from_str(block.split("```").next().unwrap()).unwrap())
        .collect()
}

#[allow(clippy::unwrap_used)]
fn write_request(directory: &Path, request: &Value, id: &str) -> Value {
    std::fs::write(
        directory.join("request.json"),
        serde_json::to_vec(request).unwrap(),
    )
    .unwrap();
    data(directory, &["write", "request.json", "--request-id", id])
}

#[test]
fn published_write_examples_support_retries_guards_and_atomic_dependencies() {
    let dir = tempfile::tempdir().unwrap();
    let project = data(dir.path(), &["project", "create", "Examples", "."]);
    let document = data(
        dir.path(),
        &["document", "create", "--body", "Original detail"],
    );
    let guide = run(dir.path(), &["skills", "get", "writes"]);
    let mut ticket = Value::Null;

    for mut request in json_examples(&guide) {
        match request["operation"].as_str().unwrap() {
            "create_ticket" => {
                request["project_id"] = project["id"].clone();
                let result = write_request(dir.path(), &request, "example-create");
                assert_eq!(
                    result,
                    write_request(dir.path(), &request, "example-create")
                );
                ticket = result["value"].clone();
                assert_eq!(ticket["project_id"], project["id"]);
                assert_eq!(data(dir.path(), &["list"]).as_array().unwrap().len(), 1);
            }
            "change_ticket" => {
                request["reference"] = ticket["reference"].clone();
                request["patch"]["expected_body"] = ticket["body"].clone();
                let result = write_request(dir.path(), &request, "example-ticket-edit");
                assert_eq!(result["value"]["body"], "Revised body");
                assert_eq!(
                    result,
                    write_request(dir.path(), &request, "example-ticket-edit")
                );
                // A new operation with the old guard must not overwrite current content.
                let conflict = invoke(
                    dir.path(),
                    &["write", "request.json", "--request-id", "stale-ticket-edit"],
                );
                assert!(!conflict.status.success());
                assert_eq!(
                    data(dir.path(), &["show", ticket["reference"].as_str().unwrap()])["body"],
                    "Revised body"
                );
            }
            "change_document" => {
                request["id"] = document["id"].clone();
                request["patch"]["expected_updated_at"] = document["updated_at"].clone();
                let result = write_request(dir.path(), &request, "example-document-edit");
                assert_eq!(result["value"]["body"], "Revised detail");
            }
            "batch" => {
                for operation in request["operations"].as_array_mut().unwrap() {
                    if operation["operation"] == "create" {
                        operation["project_id"] = project["id"].clone();
                    }
                }
                let result = write_request(dir.path(), &request, "example-batch");
                assert_eq!(result, write_request(dir.path(), &request, "example-batch"));
                assert_eq!(data(dir.path(), &["list"]).as_array().unwrap().len(), 3);
                let last = result["value"].as_array().unwrap().last().unwrap();
                let second = data(dir.path(), &["show", last["reference"].as_str().unwrap()]);
                assert_eq!(second["availability"], "Blocked");
                assert_eq!(second["tags"], json!(["example"]));
                assert_eq!(
                    second["prerequisites"][0]["reference"],
                    result["value"][0]["reference"]
                );
            }
            operation => panic!("unexercised write example: {operation}"),
        }
    }
}
