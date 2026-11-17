use std::{fmt::Write as _, path::Path};

use super::*;

#[test]
fn the_ladder_has_no_gaps_and_ends_at_the_format_version() {
    let versions: Vec<i64> = LADDER.iter().map(|(version, _)| *version).collect();
    let expected: Vec<i64> = (1..=FORMAT_VERSION).collect();
    assert_eq!(versions, expected);
}

#[test]
fn a_step_that_writes_user_version_itself_fails_the_run_and_changes_nothing() {
    let ladder: [(i64, Step); 2] = [
        (1, |tx, _| {
            Ok(tx.execute_batch("CREATE TABLE kept (id INTEGER);")?)
        }),
        // What every step did before the ladder owned the number.
        (2, |tx, _| {
            Ok(tx.execute_batch("CREATE TABLE lost (id INTEGER); PRAGMA user_version = 2;")?)
        }),
    ];
    let mut connection = Connection::open_in_memory().unwrap();
    let error = run(&ladder, &mut connection, 0, 2, |_, _| Ok(())).unwrap_err();
    assert!(error.to_string().contains("step 2"), "{error}");
    // All or nothing: the run was rolled back, step 1 with it.
    assert_eq!(user_version(&connection).unwrap(), 0);
    assert!(Objects::read(&connection).unwrap().tables.is_empty());
}

#[test]
fn the_ladder_stops_at_the_requested_version() {
    for version in [1, 12, 55, 82] {
        let connection = scratch(version).unwrap();
        assert_eq!(user_version(&connection).unwrap(), version);
    }
    // And a Workspace at a version holds what that version added and nothing later.
    let at_55 = Objects::read(&scratch(55).unwrap()).unwrap();
    assert!(at_55.tables.contains("attachments"));
    assert!(!at_55.tables.contains("device"));
    assert!(!at_55.columns.contains("tickets.reference"));
    let at_56 = Objects::read(&scratch(56).unwrap()).unwrap();
    assert!(at_56.tables.contains("device"));
    assert!(at_56.columns.contains("tickets.reference"));
}

#[test]
fn the_legacy_mention_tables_appear_at_the_versions_that_first_wrote_them() {
    // The builds that wrote these versions made `numeric_mentions` at 41 and
    // `activity_graph_numbers`, with its triggers, at 42: a backup saved by one of them
    // is checked against what it had.
    let tables = |version| objects_at(version).unwrap().tables;
    let triggers = |version| objects_at(version).unwrap().triggers;
    for version in [35, 40] {
        assert!(!tables(version).contains("numeric_mentions"), "{version}");
        assert!(
            !tables(version).contains("activity_graph_numbers"),
            "{version}"
        );
    }
    assert!(tables(41).contains("numeric_mentions"));
    assert!(!tables(41).contains("activity_graph_numbers"));
    assert!(tables(42).contains("activity_graph_numbers"));
    assert!(triggers(42).contains("activity_graph_numbers_insert"));
    assert!(triggers(42).contains("activity_graph_numbers_delete"));
    assert!(!triggers(41).contains("activity_graph_numbers_insert"));
}

#[test]
fn migrating_an_existing_workspace_continues_the_ladder() {
    let mut connection = Connection::open_in_memory().unwrap();
    document_links::register_heading_function(&connection).unwrap();
    migrate_to(&mut connection, 0, 40, |_, _| Ok(())).unwrap();
    migrate(&mut connection, 40).unwrap();
    assert_eq!(user_version(&connection).unwrap(), FORMAT_VERSION);
    assert_eq!(
        Objects::read(&connection).unwrap(),
        Objects::read(&scratch(FORMAT_VERSION).unwrap()).unwrap()
    );
}

const LEDGER: &str = "format-ledger.txt";

/// What each format version added and removed, by name: tables, `table.column`s,
/// triggers and unique indexes.
fn ledger() -> String {
    let mut connection = Connection::open_in_memory().unwrap();
    document_links::register_heading_function(&connection).unwrap();
    let mut text = String::from(
        "Workspace format ledger. Generated from the migration ladder in src/format.rs; do not edit.\n\
         \n\
         Each section lists what that format version added (+) and removed (-), by name.\n\
         Types, defaults and data changes are not covered. A diff in the section of a version\n\
         that has already shipped means an old migration step was edited: Workspaces saved by\n\
         that version would no longer validate as backups. Regenerate on purpose with\n\
         TICKETD_UPDATE_FORMAT_LEDGER=1 cargo test -p ticketd-core --lib format::\n",
    );
    let mut previous = Objects::default();
    migrate_to(&mut connection, 0, FORMAT_VERSION, |version, connection| {
        let current = Objects::read(connection)?;
        let _ = write!(text, "\n## {version}\n");
        let mut changed = false;
        for (sign, from, to) in [("+", &previous, &current), ("-", &current, &previous)] {
            for (kind, before, after) in [
                ("table", &from.tables, &to.tables),
                ("column", &from.columns, &to.columns),
                ("trigger", &from.triggers, &to.triggers),
                ("unique index", &from.unique_indexes, &to.unique_indexes),
            ] {
                for name in after.difference(before) {
                    let _ = writeln!(text, "{sign} {kind} {name}");
                    changed = true;
                }
            }
        }
        if !changed {
            text.push_str("(no table, column, trigger or unique index changes)\n");
        }
        previous = current;
        Ok(())
    })
    .unwrap();
    text
}

#[test]
fn the_ledger_matches_the_ladder() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(LEDGER);
    let generated = ledger();
    if std::env::var_os("TICKETD_UPDATE_FORMAT_LEDGER").is_some() {
        std::fs::write(&path, &generated).unwrap();
        return;
    }
    let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        checked_in == generated,
        "crates/ticketd-core/{LEDGER} differs from what the migration ladder builds. If you added a \
         format version, regenerate it with TICKETD_UPDATE_FORMAT_LEDGER=1 cargo test -p ticketd-core --lib \
         format:: and commit it. If a section of a version that already shipped changed, you edited an \
         old migration step: undo that, and add a new step instead."
    );
}
