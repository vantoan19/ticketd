use rusqlite::Connection;
use ticketd_core::FORMAT_VERSION;
use ticketd_core::{
    BackupCheck, EvidenceInput, EvidenceKind, SafetyBackupKind, Workspace, WorkspaceSummary,
};

// Clippy only exempts #[test] functions from the unwrap lint, not their helpers.
#[allow(clippy::unwrap_used)]
fn populated(path: &std::path::Path) -> Workspace {
    let mut workspace = Workspace::open(path).unwrap();
    let first = workspace.create_ticket("First").unwrap();
    let second = workspace.create_ticket("Second").unwrap();
    workspace.create_ticket("Trashed").unwrap();
    workspace.set_trashed("T-KQ3", true, None).unwrap();
    workspace
        .add_activity(&first.reference, "A note", None)
        .unwrap();
    workspace
        .add_activity(&second.reference, "Another", None)
        .unwrap();
    workspace
        .add_evidence(
            &first.reference,
            EvidenceInput {
                kind: EvidenceKind::Verification,
                name: "Tests".into(),
                value: "passed".into(),
                editing_agent: None,
            },
        )
        .unwrap();
    workspace.create_project("App", "/tmp/app").unwrap();
    workspace.create_plan("Release").unwrap();
    workspace.create_plan("Cleanup").unwrap();
    workspace
}

#[test]
fn a_valid_backup_is_summarized_beside_the_workspace_without_changing_either() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    let mut workspace = populated(&path);
    workspace.backup(&backup).unwrap();
    workspace.create_ticket("After the backup").unwrap();
    let before = std::fs::read(&backup).unwrap();
    let inspection = workspace.inspect_backup(&backup).unwrap();
    let BackupCheck::Valid {
        format_version,
        summary,
    } = inspection.check
    else {
        panic!("expected a valid backup, got {:?}", inspection.check);
    };
    assert_eq!(i64::from(format_version), FORMAT_VERSION);
    assert_eq!(
        (
            summary.tickets,
            summary.activities,
            summary.evidence,
            summary.projects,
            summary.plans
        ),
        (2, 2, 1, 1, 2)
    );
    assert!(summary.last_change.is_some());
    assert_eq!(inspection.current.tickets, 3);
    assert_eq!(inspection.path, backup.display().to_string());
    assert_eq!(std::fs::read(&backup).unwrap(), before);
    assert_eq!(workspace.list_tickets().unwrap().len(), 3);
}

#[test]
fn document_counts_and_changes_are_visible_in_backup_review() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    workspace
        .create_document(Some("Before"), "Context")
        .unwrap();
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    workspace
        .create_document(Some("After"), "More context")
        .unwrap();
    let inspection = workspace.inspect_backup(&backup).unwrap();
    let BackupCheck::Valid { summary, .. } = inspection.check else {
        panic!("valid backup")
    };
    assert_eq!(summary.documents, 1);
    assert_eq!(inspection.current.documents, 2);
    assert!(summary.last_change.is_some());
    assert_eq!(workspace.workspace_info().unwrap().documents, 2);
}

#[test]
fn a_pre_document_backup_reports_zero_documents() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let backup = dir.path().join("old.sqlite3");
    ticketd_core::create_workspace_at_format_version(&backup, 1).unwrap();
    let BackupCheck::Valid { summary, .. } = workspace.inspect_backup(&backup).unwrap().check
    else {
        panic!("expected a valid old backup")
    };
    assert_eq!(summary.documents, 0);
}

#[test]
fn an_empty_workspace_has_no_last_change() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    let workspace = Workspace::open(&path).unwrap();
    workspace.backup(&backup).unwrap();
    let inspection = workspace.inspect_backup(&backup).unwrap();
    let expected = WorkspaceSummary {
        last_change: None,
        tickets: 0,
        activities: 0,
        documents: 0,
        evidence: 0,
        projects: 0,
        plans: 0,
    };
    assert_eq!(inspection.current, expected);
    assert_eq!(
        inspection.check,
        BackupCheck::Valid {
            format_version: FORMAT_VERSION as u32,
            summary: expected
        }
    );
}

#[test]
fn a_newer_format_names_both_versions() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let newer = dir.path().join("newer.sqlite3");
    let connection = Connection::open(&newer).unwrap();
    connection
        .execute_batch(&format!(
            "CREATE TABLE tickets (number INTEGER PRIMARY KEY); PRAGMA user_version = {};",
            FORMAT_VERSION + 1
        ))
        .unwrap();
    drop(connection);
    assert_eq!(
        workspace.inspect_backup(&newer).unwrap().check,
        BackupCheck::NewerFormat {
            backup_version: (FORMAT_VERSION + 1) as u32,
            supported_version: FORMAT_VERSION as u32
        }
    );
}

#[test]
fn files_that_are_not_ticketd_backups_are_named_as_such() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let text = dir.path().join("notes.sqlite3");
    std::fs::write(&text, b"this is not a database at all, just text").unwrap();
    let unrelated = dir.path().join("other.sqlite3");
    let connection = Connection::open(&unrelated).unwrap();
    connection
        .execute_batch("CREATE TABLE photos (id INTEGER); PRAGMA user_version = 20;")
        .unwrap();
    drop(connection);
    // An unrelated database from a newer program is not "a newer ticketd".
    let unrelated_newer = dir.path().join("unrelated-newer.sqlite3");
    Connection::open(&unrelated_newer)
        .unwrap()
        .execute_batch("CREATE TABLE photos (id INTEGER); PRAGMA user_version = 30;")
        .unwrap();
    let blank = dir.path().join("blank.sqlite3");
    Connection::open(&blank)
        .unwrap()
        .execute_batch("PRAGMA user_version = 0; CREATE TABLE t (x);")
        .unwrap();
    for file in [&text, &unrelated, &unrelated_newer, &blank] {
        assert_eq!(
            workspace.inspect_backup(file).unwrap().check,
            BackupCheck::NotTicketd,
            "{}",
            file.display()
        );
    }
}

#[test]
fn a_backup_missing_tables_lists_them() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let damaged = dir.path().join("damaged.sqlite3");
    let connection = Connection::open(&damaged).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE tickets (number INTEGER PRIMARY KEY, id TEXT, title TEXT, status TEXT); PRAGMA user_version = 5;",
        )
        .unwrap();
    drop(connection);
    let BackupCheck::MissingTables { tables } = workspace.inspect_backup(&damaged).unwrap().check
    else {
        panic!("expected missing tables");
    };
    assert!(tables.contains(&"ticket_history".to_owned()));
    assert!(tables.contains(&"notes".to_owned()));
}

#[test]
fn the_current_workspace_file_cannot_be_restored_over_itself() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let workspace = populated(&path);
    assert_eq!(
        workspace.inspect_backup(&path).unwrap().check,
        BackupCheck::CurrentWorkspace
    );
}

#[test]
fn a_missing_file_is_an_error_and_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let missing = dir.path().join("missing.sqlite3");
    assert!(workspace.inspect_backup(&missing).is_err());
    assert!(!missing.exists());
}

#[test]
fn safety_backups_list_restore_and_migration_copies_newest_first() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    let workspace = populated(&path);
    assert!(workspace.safety_backups().unwrap().is_empty());
    workspace.backup(&backup).unwrap();
    drop(workspace);
    let safety = Workspace::restore(&path, &backup).unwrap();
    std::fs::write(dir.path().join("workspace.sqlite3.lock.bak"), b"x").unwrap();
    let migration = dir
        .path()
        .join("workspace.sqlite3.pre-migration-abc.sqlite3");
    std::fs::copy(&backup, &migration).unwrap();
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    std::fs::File::options()
        .write(true)
        .open(&migration)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let workspace = Workspace::open(&path).unwrap();
    let listed = workspace.safety_backups().unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].kind, SafetyBackupKind::Safety);
    assert_eq!(
        std::fs::canonicalize(&listed[0].path).unwrap(),
        std::fs::canonicalize(&safety).unwrap()
    );
    assert_eq!(listed[1].kind, SafetyBackupKind::PreMigration);
    assert!(listed[0].saved_at > listed[1].saved_at);
    assert!(listed[0].size_bytes > 0);
    assert!(listed[0].saved_at.ends_with('Z'));
}

#[test]
fn a_truncated_backup_is_never_called_valid_or_newer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    let workspace = populated(&path);
    workspace.backup(&backup).unwrap();
    let bytes = std::fs::read(&backup).unwrap();
    let truncated = dir.path().join("truncated.sqlite3");
    std::fs::write(&truncated, &bytes[..bytes.len() / 3]).unwrap();
    let check = workspace.inspect_backup(&truncated).unwrap().check;
    assert!(
        matches!(check, BackupCheck::Damaged { .. } | BackupCheck::NotTicketd),
        "{check:?}"
    );
}

#[test]
fn restore_accepts_what_inspection_calls_valid_and_refuses_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let unrelated = dir.path().join("other.sqlite3");
    Connection::open(&unrelated)
        .unwrap()
        .execute_batch("CREATE TABLE photos (id INTEGER); PRAGMA user_version = 30;")
        .unwrap();
    let workspace = populated(&path);
    assert_eq!(
        workspace.inspect_backup(&unrelated).unwrap().check,
        BackupCheck::NotTicketd
    );
    drop(workspace);
    let error = Workspace::restore(&path, &unrelated).unwrap_err();
    assert!(error.to_string().contains("not a ticketd"), "{error}");
}

#[test]
fn backup_inspection_rejects_missing_context_index() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    let connection = Connection::open(&backup).unwrap();
    connection
        .execute_batch("DROP TABLE context_mentions")
        .unwrap();
    drop(connection);
    let BackupCheck::MissingTables { tables } = workspace.inspect_backup(&backup).unwrap().check
    else {
        panic!("expected missing tables")
    };
    assert!(tables.contains(&"context_mentions".to_owned()));
}

#[test]
fn incomplete_context_schema_cannot_replace_healthy_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let workspace = populated(&path);
    for table in [
        "document_tags",
        "document_pins",
        "activity_mentions",
        "document_fts",
        "ticket_graph_fts",
        "plan_graph_fts",
    ] {
        let backup = dir.path().join(format!("{table}.sqlite3"));
        workspace.backup(&backup).unwrap();
        Connection::open(&backup)
            .unwrap()
            .execute_batch(&format!("DROP TABLE {table}"))
            .unwrap();
        let BackupCheck::MissingTables { tables } =
            workspace.inspect_backup(&backup).unwrap().check
        else {
            panic!("missing {table} accepted")
        };
        assert!(tables.contains(&table.to_owned()));
        assert!(Workspace::restore(&path, &backup).is_err());
        assert_eq!(workspace.list_tickets().unwrap().len(), 2);
    }
}

/// Data safety comes first: a Workspace that earlier builds left without a schema object
/// of its format version can still be backed up. Inspecting or restoring that backup
/// still names what is missing, which protects the Workspace a restore would replace.
#[test]
fn a_workspace_missing_a_schema_object_can_still_be_backed_up_but_not_restored_from() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    let workspace = populated(&path);
    Connection::open(&path)
        .unwrap()
        .execute_batch("ALTER TABLE inbox_entries DROP COLUMN editing_agent")
        .unwrap();

    workspace.backup(&backup).unwrap();

    let BackupCheck::MissingTables { tables } = workspace.inspect_backup(&backup).unwrap().check
    else {
        panic!("a backup missing a column was called valid")
    };
    assert_eq!(tables, ["inbox_entries.editing_agent"]);
    assert!(Workspace::restore(&path, &backup).is_err());
    assert_eq!(workspace.list_tickets().unwrap().len(), 2);
}

#[test]
fn backup_missing_search_maintenance_trigger_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let backup = dir.path().join("backup.sqlite3");
    workspace.backup(&backup).unwrap();
    Connection::open(&backup)
        .unwrap()
        .execute_batch("DROP TRIGGER document_fts_update")
        .unwrap();
    let BackupCheck::MissingTables { tables } = workspace.inspect_backup(&backup).unwrap().check
    else {
        panic!("missing trigger accepted")
    };
    assert!(tables.contains(&"document_fts_update".to_owned()));
}

#[test]
fn missing_context_maintenance_triggers_cannot_replace_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let workspace = populated(&path);
    for trigger in [
        "ticket_entity_insert",
        "plan_entity_insert",
        "numeric_mentions_activity_delete",
        "activity_graph_numbers_insert",
        "activity_graph_numbers_delete",
        "activity_graph_targets_insert",
        "activity_graph_targets_delete",
        "document_heading_insert",
        "document_heading_update",
    ] {
        let backup = dir.path().join(format!("{trigger}.sqlite3"));
        workspace.backup(&backup).unwrap();
        Connection::open(&backup)
            .unwrap()
            .execute_batch(&format!("DROP TRIGGER {trigger}"))
            .unwrap();
        let BackupCheck::MissingTables { tables } =
            workspace.inspect_backup(&backup).unwrap().check
        else {
            panic!("missing {trigger} accepted")
        };
        assert!(tables.contains(&trigger.to_owned()));
        assert!(Workspace::restore(&path, &backup).is_err());
        assert_eq!(workspace.list_tickets().unwrap().len(), 2);
    }
}

#[test]
fn restore_names_a_missing_backup_and_creates_a_missing_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.sqlite3");
    let backup = dir.path().join("backup.sqlite3");
    populated(&source).backup(&backup).unwrap();
    let target = dir.path().join("new-computer.sqlite3");
    let missing = dir.path().join("nope.sqlite3");
    let error = Workspace::restore(&target, &missing).unwrap_err();
    assert!(error.to_string().contains("nope.sqlite3"), "{error}");
    Workspace::restore(&target, &backup).unwrap();
    assert!(
        Workspace::open(&target)
            .unwrap()
            .show_ticket("T-KQ1")
            .is_ok()
    );
}

/// Automations and their agents synchronize from format version 76, so their tables
/// have no capture triggers in a Workspace saved at 70–75. A backup in one of those
/// formats, such as the copy saved before such a Workspace is migrated, restores.
#[test]
fn backups_from_before_automations_synchronize_are_valid_and_restore() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = populated(&dir.path().join("workspace.sqlite3"));
    for version in [72, 75] {
        // A Workspace as that format version left it, built by the real migration ladder.
        let backup = dir.path().join(format!("v{version}.sqlite3"));
        ticketd_core::create_workspace_at_format_version(&backup, version).unwrap();
        Connection::open(&backup)
            .unwrap()
            .execute_batch(
                "INSERT INTO tickets (id, reference, title, status) VALUES ('t1', 'T-KQ1', 'First', 'Todo'), ('t2', 'T-KQ2', 'Second', 'Todo');",
            )
            .unwrap();

        let check = workspace.inspect_backup(&backup).unwrap().check;
        let BackupCheck::Valid { format_version, .. } = check else {
            panic!("expected a valid backup at format version {version}, got {check:?}");
        };
        assert_eq!(i64::from(format_version), version);
        // It restores as it is, and opening it migrates it to the current format.
        let restored = dir.path().join(format!("restored-v{version}.sqlite3"));
        Workspace::restore(&restored, &backup).unwrap();
        assert_eq!(
            Workspace::open(&restored)
                .unwrap()
                .list_tickets()
                .unwrap()
                .len(),
            2
        );
        let migrated: i64 = Connection::open(&restored)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(migrated, FORMAT_VERSION);
    }
}

/// A Workspace without a sync capture trigger would silently stop uploading edits to
/// that table once restored, so a backup missing one is refused even at the current
/// format version.
#[test]
fn a_current_backup_missing_one_sync_capture_trigger_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let workspace = populated(&path);
    for trigger in [
        "sync_capture_tickets_update",
        "sync_capture_documents_insert",
        "sync_capture_automation_agents_delete",
    ] {
        let backup = dir.path().join(format!("{trigger}.sqlite3"));
        workspace.backup(&backup).unwrap();
        Connection::open(&backup)
            .unwrap()
            .execute_batch(&format!("DROP TRIGGER {trigger}"))
            .unwrap();
        let BackupCheck::MissingTables { tables } =
            workspace.inspect_backup(&backup).unwrap().check
        else {
            panic!("a backup without {trigger} was accepted")
        };
        assert_eq!(tables, [trigger]);
        assert!(Workspace::restore(&path, &backup).is_err());
        assert_eq!(workspace.list_tickets().unwrap().len(), 2);
    }
}
