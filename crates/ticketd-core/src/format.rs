//! The Workspace format: which shape of Workspace file a ticketd can read.
//!
//! The ladder below is the single source of truth. A Workspace at format version V is
//! exactly what running steps 1 through V over an empty database leaves behind, so the
//! backup check (`backup_review`) builds V in memory and compares, instead of keeping
//! its own lists of tables, columns and triggers. Step bodies stay beside the domain
//! code whose tables they create; the ones with no domain home are at the bottom.
//!
//! Only this module writes `PRAGMA user_version`, after each step and inside the one
//! transaction that runs them all. A step that changes it is a bug and fails the run.
//!
//! The ladder is history: change the shape of an old step and every backup saved by
//! the code that shipped it stops validating. `format-ledger.txt` and the fixtures in
//! `tests/fixtures/format` exist to make such an edit show up in review.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock, PoisonError};

use rusqlite::{Connection, Transaction, TransactionBehavior};

use crate::{
    Error, activities, attachment_cleanup, attachment_retention, attachments, automation_agents,
    automation_background, automation_runs, automations, change_token, chats, device,
    document_links, documents, drive, duplicates, embedded_attachments, events, hierarchy, history,
    inbox, plans, projects, relationships, retry, search, source, sync, tags, ticket_documents,
    upload_destination, versions,
};

/// The workspace format version this application reads and writes. The next
/// format change bumps this and adds one step to [`LADDER`]; nothing else holds the number.
pub const FORMAT_VERSION: i64 = 96;

/// One change to what a Workspace stores. The second argument is the format version
/// the run started from, `0` for a new Workspace.
type Step = fn(&Transaction<'_>, i64) -> Result<(), Error>;

/// Every step in order. Entry `n` takes a Workspace from format version `n - 1` to `n`.
const LADDER: [(i64, Step); FORMAT_VERSION as usize] = [
    (1, |tx, _| tx.execute_batch(TICKETS).map_err(Into::into)),
    (2, |tx, _| tx.execute_batch(TICKET_BODY).map_err(Into::into)),
    (3, |tx, _| history::migrate(tx)),
    (4, |tx, _| tags::migrate(tx)),
    (5, |tx, _| activities::migrate(tx)),
    (6, |tx, _| relationships::migrate(tx)),
    (7, |tx, _| projects::migrate(tx)),
    (8, |tx, _| plans::migrate(tx)),
    (9, |tx, _| hierarchy::migrate(tx)),
    (10, |tx, _| projects::migrate_checkouts(tx)),
    (11, |tx, _| {
        tx.execute_batch(TICKET_TRASHED).map_err(Into::into)
    }),
    (12, |tx, _| {
        tx.execute_batch(REQUEST_OUTCOMES).map_err(Into::into)
    }),
    (13, |tx, _| {
        tx.execute_batch(HISTORY_INDEX).map_err(Into::into)
    }),
    (14, |tx, _| inbox::migrate(tx)),
    (15, |tx, _| duplicates::migrate(tx)),
    (16, |tx, _| tx.execute_batch(EVIDENCE).map_err(Into::into)),
    (17, |tx, _| {
        tx.execute_batch(INBOX_AGENT).map_err(Into::into)
    }),
    (18, |tx, _| inbox::migrate_reminders(tx)),
    (19, |tx, _| {
        tx.execute_batch(CONTEXTUAL_RELATIONSHIPS)
            .map_err(Into::into)
    }),
    (20, |tx, _| {
        tx.execute_batch(LAST_BACKUP).map_err(Into::into)
    }),
    (21, |tx, _| duplicates::migrate_status(tx)),
    (22, |tx, _| source::migrate(tx)),
    (23, |tx, _| source::migrate_tracking(tx)),
    (24, |tx, _| source::migrate_conversation(tx)),
    (25, |tx, _| source::migrate_freshness(tx)),
    (26, |tx, _| source::migrate_publication(tx)),
    (27, |tx, _| source::migrate_details(tx)),
    (28, |tx, _| activities::migrate_updates(tx)),
    (29, |tx, _| source::migrate_run_counts(tx)),
    (30, |tx, _| {
        tx.execute_batch(DEPENDENCIES_INDEX).map_err(Into::into)
    }),
    (31, |tx, _| documents::migrate(tx)),
    (32, |tx, _| {
        tx.execute_batch(ACTIVITIES_RENAME).map_err(Into::into)
    }),
    (33, |tx, _| {
        tx.execute_batch(PLAN_SCOPE_INDEX).map_err(Into::into)
    }),
    (34, document_trashed),
    (35, |tx, _| document_links::migrate(tx)),
    (36, |tx, _| documents::migrate_search(tx)),
    (37, activity_support),
    (38, document_kept),
    (39, plan_documents),
    (40, activity_mentions),
    (41, mention_triggers),
    (42, activity_graph_projections),
    (43, graph_search),
    (44, |tx, _| {
        tx.execute_batch(ACTIVITY_NUMBER_INDEX).map_err(Into::into)
    }),
    (45, |tx, _| change_token::migrate(tx)),
    (46, |tx, _| ticket_documents::migrate(tx)),
    (47, |tx, _| attachments::migrate(tx)),
    (48, |tx, _| embedded_attachments::migrate(tx)),
    (49, |tx, _| attachments::migrate_upload_settings(tx)),
    (50, |tx, from| attachment_retention::migrate(tx, from > 0)),
    (51, |tx, _| drive::migrate(tx)),
    (52, |tx, _| drive::migrate_uploads(tx)),
    (53, |tx, _| attachment_cleanup::migrate(tx)),
    (54, |tx, _| attachment_cleanup::migrate_purge(tx)),
    (55, |tx, _| upload_destination::migrate(tx)),
    (56, |tx, _| device::migrate(tx)),
    (57, |tx, _| versions::migrate(tx)),
    (58, |tx, _| sync::migrate(tx)),
    (59, |tx, _| sync::migrate_setup(tx)),
    (60, |tx, _| sync::migrate_recovery(tx)),
    (61, |tx, _| sync::migrate_run_token(tx)),
    (62, |tx, _| sync::migrate_download_attempts(tx)),
    (63, |tx, _| sync::migrate_file_identity(tx)),
    (64, |tx, _| sync::migrate_file_created(tx)),
    (65, |tx, _| sync::migrate_last_folder(tx)),
    (66, |tx, _| chats::migrate(tx)),
    (67, |tx, _| chats::migrate_attention(tx)),
    (68, |tx, _| chats::migrate_tool_start(tx)),
    (69, |tx, _| chats::migrate_interaction_tool(tx)),
    (70, |tx, _| chats::migrate_read_through(tx)),
    (71, |tx, _| chats::migrate_marked_unread(tx)),
    (72, |tx, _| chats::migrate_request_times(tx)),
    (73, |tx, _| events::migrate(tx)),
    (74, |tx, _| automation_agents::migrate(tx)),
    (75, |tx, _| automations::migrate(tx)),
    (76, |tx, _| automations::migrate_sync(tx)),
    (77, |tx, _| automation_runs::migrate(tx)),
    (78, |tx, _| automation_background::migrate(tx)),
    (79, |tx, _| automation_runs::migrate_attention(tx)),
    (80, |tx, _| automations::migrate_schedule(tx)),
    (81, |tx, _| {
        automation_agents::migrate_any_command(tx)?;
        events::migrate_workspace_sync_actor(tx)
    }),
    (82, |tx, _| source::migrate_read_partitions(tx)),
    (83, |tx, _| chats::migrate_turn_ending(tx)),
    (84, |tx, _| read_models(tx)),
    (85, |tx, _| source::migrate_issue_opening(tx)),
    (86, |tx, _| projects::migrate_remote(tx)),
    (87, |tx, _| source::migrate_issue_repository(tx)),
    (88, |tx, _| source::migrate_github_issue_hosts(tx)),
    (89, |tx, _| source::migrate_publication_destination_host(tx)),
    (90, |tx, _| source::migrate_presentations(tx)),
    (91, |tx, _| source::migrate_contract_data(tx)),
    (92, |tx, _| {
        source::migrate_state_categories(tx)?;
        retry::migrate_source_state_outcomes(tx)?;
        sync::migrate_source_state_conflicts(tx)?;
        sync::migrate_source_observation_capture(tx)
    }),
    (93, |tx, _| source::migrate_connections(tx)),
    (94, |tx, _| source::migrate_connection_lifecycle(tx)),
    (95, |tx, _| source::migrate_source_secret_references(tx)),
    (96, |tx, _| source::migrate_recovery_safety(tx)),
];

/// Takes a Workspace at format version `from` to the current one, or creates it when
/// `from` is `0`. All or nothing: one immediate transaction, rolled back on any error.
pub(crate) fn migrate(connection: &mut Connection, from: i64) -> Result<(), Error> {
    // Many unrelated databases use `user_version`. Ticketd never wrote a negative one, so
    // the ladder would build over somebody else's file; leave it as it is.
    if from < 0 {
        return Err(Error::Backup(format!(
            "not a ticketd workspace: its format version is {from}"
        )));
    }
    migrate_to(connection, from, FORMAT_VERSION, |_, _| Ok(()))
}

/// Runs the steps from `from` (exclusive) to `target` (inclusive). `after_step` sees the
/// database after each step, with `user_version` already moved on to that step's version.
fn migrate_to(
    connection: &mut Connection,
    from: i64,
    target: i64,
    after_step: impl FnMut(i64, &Connection) -> Result<(), Error>,
) -> Result<(), Error> {
    run(&LADDER, connection, from, target, after_step)
}

fn run(
    ladder: &[(i64, Step)],
    connection: &mut Connection,
    from: i64,
    target: i64,
    mut after_step: impl FnMut(i64, &Connection) -> Result<(), Error>,
) -> Result<(), Error> {
    // Schema51 rebuilds the parent attachment table without cascading into
    // reference/retention rows. Validate all foreign keys before committing.
    connection.pragma_update(None, "foreign_keys", "OFF")?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (version, step) in ladder
        .iter()
        .filter(|(version, _)| (from + 1..=target).contains(version))
    {
        let before = user_version(&transaction)?;
        step(&transaction, from)?;
        if user_version(&transaction)? != before {
            return Err(Error::Backup(format!(
                "format step {version} changed user_version itself; only the migration ladder writes it"
            )));
        }
        transaction.pragma_update(None, "user_version", version)?;
        after_step(*version, &transaction)?;
    }
    let violations: i64 =
        transaction.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    if violations != 0 {
        return Err(Error::Attachment(
            "migration would invalidate existing references; preserved pre-migration backup".into(),
        ));
    }
    transaction.commit()?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

fn user_version(connection: &Connection) -> Result<i64, Error> {
    Ok(connection.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

/// A new Workspace at format version `version`, in memory: what the ladder leaves
/// after steps 1 through `version`, and nothing else.
pub(crate) fn scratch(version: i64) -> Result<Connection, Error> {
    let mut connection = Connection::open_in_memory()?;
    document_links::register_heading_function(&connection)?;
    migrate_to(&mut connection, 0, version, |_, _| Ok(()))?;
    Ok(connection)
}

/// Writes a new Workspace file at format version `version`, built by the real ladder
/// and holding no rows. Tests seed it with SQL that is valid at that version and then
/// open, back up or restore it.
#[cfg(feature = "test-schema")]
pub fn create_workspace_at_format_version(
    path: impl AsRef<std::path::Path>,
    version: i64,
) -> Result<(), Error> {
    let mut connection = Connection::open(path.as_ref())?;
    document_links::register_heading_function(&connection)?;
    migrate_to(&mut connection, 0, version, |_, _| Ok(()))
}

/// The schema objects whose presence defines a format version, by name.
///
/// Types, defaults, constraints and ordinary indexes are not compared: a backup may have
/// extra objects and still hold everything that version needs.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Objects {
    pub(crate) tables: BTreeSet<String>,
    /// `table.column`
    pub(crate) columns: BTreeSet<String>,
    pub(crate) triggers: BTreeSet<String>,
    /// Unique indexes made by `CREATE UNIQUE INDEX`; they enforce invariants such as
    /// one active Automation Run. The ones SQLite makes for `UNIQUE` and primary keys
    /// follow from the table itself.
    pub(crate) unique_indexes: BTreeSet<String>,
}

impl Objects {
    pub(crate) fn read(connection: &Connection) -> Result<Self, Error> {
        let names = |sql: &str| -> Result<BTreeSet<String>, Error> {
            let mut statement = connection.prepare(sql)?;
            Ok(statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<_, _>>()?)
        };
        // A full-text index keeps its content in tables named after it; they follow
        // from the virtual table.
        let tables = names(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
               AND NOT EXISTS (
                 SELECT 1 FROM sqlite_master v WHERE v.type = 'table' AND v.sql LIKE 'CREATE VIRTUAL TABLE%'
                   AND sqlite_master.name IN (v.name || '_data', v.name || '_idx', v.name || '_content', v.name || '_docsize', v.name || '_config'))",
        )?;
        let columns = names(
            "SELECT m.name || '.' || c.name FROM sqlite_master m, pragma_table_xinfo(m.name) c
              WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
        )?
        .into_iter()
        .filter(|column| {
            column
                .split_once('.')
                .is_some_and(|(table, _)| tables.contains(table))
        })
        .collect();
        Ok(Self {
            tables,
            columns,
            triggers: names("SELECT name FROM sqlite_master WHERE type = 'trigger'")?,
            unique_indexes: names(
                "SELECT i.name FROM sqlite_master m, pragma_index_list(m.name) i
                  WHERE m.type = 'table' AND i.\"unique\" = 1 AND i.origin = 'c'",
            )?,
        })
    }

    /// What `self` has that `actual` lacks, named for a person to read: a table, a
    /// `table.column` of a table that is present, a trigger or a unique index.
    pub(crate) fn missing_from(&self, actual: &Self) -> Vec<String> {
        let mut missing: Vec<String> = self.tables.difference(&actual.tables).cloned().collect();
        missing.extend(
            self.columns
                .difference(&actual.columns)
                .filter(|column| {
                    column
                        .split_once('.')
                        .is_some_and(|(table, _)| actual.tables.contains(table))
                })
                .cloned(),
        );
        missing.extend(self.triggers.difference(&actual.triggers).cloned());
        missing.extend(
            self.unique_indexes
                .difference(&actual.unique_indexes)
                .cloned(),
        );
        missing
    }
}

/// The schema objects a Workspace at `version` must have, from the ladder.
///
/// The ladder is fixed for the life of the process, so each version is built once and kept:
/// every backup check asks, and building one takes dozens of migration steps.
pub(crate) fn objects_at(version: i64) -> Result<Objects, Error> {
    static BUILT: OnceLock<Mutex<HashMap<i64, Objects>>> = OnceLock::new();
    let built = BUILT.get_or_init(Default::default);
    // A cache entry is written whole, so a panic elsewhere cannot leave one half-built.
    if let Some(objects) = built
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&version)
    {
        return Ok(objects.clone());
    }
    // Built outside the lock: two checks that race both build it and store the same value.
    let objects = Objects::read(&scratch(version)?)?;
    built
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(version, objects.clone());
    Ok(objects)
}

const TICKETS: &str = "CREATE TABLE tickets (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, status TEXT NOT NULL);";
const TICKET_BODY: &str = "ALTER TABLE tickets ADD COLUMN body TEXT NOT NULL DEFAULT '';";
const TICKET_TRASHED: &str = "ALTER TABLE tickets ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0;";
const REQUEST_OUTCOMES: &str = "CREATE TABLE request_outcomes (id TEXT PRIMARY KEY, request TEXT NOT NULL, outcome TEXT NOT NULL);";
const HISTORY_INDEX: &str = "CREATE INDEX ticket_history_ticket_id ON ticket_history(ticket_id);";
const EVIDENCE: &str = "CREATE TABLE evidence (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ticket_id TEXT NOT NULL REFERENCES tickets(id), kind TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), editing_agent TEXT);";
const INBOX_AGENT: &str = "ALTER TABLE inbox_entries ADD COLUMN editing_agent TEXT;";
const CONTEXTUAL_RELATIONSHIPS: &str = "CREATE TABLE contextual_relationships (kind TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES tickets(id), target_id TEXT NOT NULL REFERENCES tickets(id), PRIMARY KEY(kind, source_id, target_id));";
const LAST_BACKUP: &str = "CREATE TABLE last_backup (id INTEGER PRIMARY KEY CHECK (id = 1), path TEXT NOT NULL, completed_at TEXT NOT NULL);";
const DEPENDENCIES_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS dependencies_dependent ON dependencies(dependent_id, blocker_id);";
const ACTIVITIES_RENAME: &str = "ALTER TABLE notes RENAME TO activities; ALTER TABLE activities RENAME COLUMN content TO brief; ALTER TABLE activities RENAME COLUMN created_at TO reported_at; UPDATE inbox_entries SET kind = 'activity' WHERE kind = 'note'; CREATE INDEX IF NOT EXISTS activities_feed ON activities(ticket_id, reported_at DESC, number DESC); CREATE INDEX IF NOT EXISTS ticket_history_feed ON ticket_history(ticket_id, timestamp DESC, number DESC);";
const PLAN_SCOPE_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS tickets_plan_scope ON tickets(plan_id, trashed, number);";
/// The latest Activity of a ticket is read on every refresh.
const ACTIVITY_NUMBER_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS activities_ticket_number ON activities(ticket_id, number DESC);";

fn has_column(tx: &Connection, table: &str, column: &str) -> Result<bool, Error> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        [table, column],
        |row| row.get(0),
    )?)
}

pub(crate) fn add_column_if_missing(
    tx: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), Error> {
    if !has_column(tx, table, column)? {
        tx.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
}

fn document_trashed(tx: &Transaction<'_>, _: i64) -> Result<(), Error> {
    add_column_if_missing(
        tx,
        "documents",
        "trashed",
        "INTEGER NOT NULL DEFAULT 0 CHECK(trashed IN (0, 1))",
    )
}

fn activity_support(tx: &Transaction<'_>, _: i64) -> Result<(), Error> {
    add_column_if_missing(
        tx,
        "activities",
        "supporting_document_id",
        "TEXT REFERENCES documents(id)",
    )?;
    add_column_if_missing(
        tx,
        "documents",
        "originating_activity_id",
        "TEXT REFERENCES activities(id) ON DELETE SET NULL",
    )
}

fn document_kept(tx: &Transaction<'_>, _: i64) -> Result<(), Error> {
    add_column_if_missing(tx, "documents", "kept", "INTEGER NOT NULL DEFAULT 0")
}

fn plan_documents(tx: &Transaction<'_>, _: i64) -> Result<(), Error> {
    add_column_if_missing(
        tx,
        "plans",
        "spec_document_id",
        "TEXT REFERENCES documents(id)",
    )?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS plan_documents (plan_id TEXT NOT NULL REFERENCES plans(id), document_id TEXT NOT NULL REFERENCES documents(id), PRIMARY KEY(plan_id, document_id));
        CREATE INDEX IF NOT EXISTS plan_documents_by_document ON plan_documents(document_id, plan_id);")?;
    Ok(())
}

fn activity_mentions(tx: &Transaction<'_>, _: i64) -> Result<(), Error> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS activity_mentions (activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE, target_id TEXT NOT NULL REFERENCES entities(id), passage TEXT NOT NULL, PRIMARY KEY(activity_id, target_id, passage)); CREATE INDEX IF NOT EXISTS activity_mentions_target ON activity_mentions(target_id, activity_id); CREATE INDEX IF NOT EXISTS activities_support_ticket ON activities(ticket_id, supporting_document_id, id); CREATE INDEX IF NOT EXISTS activities_support_document ON activities(supporting_document_id, ticket_id, id);")?;
    let mut statement = tx.prepare("SELECT id, brief FROM activities")?;
    let activities = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (id, brief) in activities {
        document_links::index_activity_before_references(tx, &id, &brief)?;
    }
    Ok(())
}

fn mention_triggers(tx: &Transaction<'_>, _: i64) -> Result<(), Error> {
    // The builds that wrote version 41 made the numeric mention index here.
    tx.execute_batch(document_links::LEGACY_NUMERIC_MENTIONS_SCHEMA)?;
    tx.execute_batch("CREATE INDEX IF NOT EXISTS activities_ticket_identity ON activities(ticket_id, id); CREATE TRIGGER IF NOT EXISTS numeric_mentions_activity_delete AFTER DELETE ON activities BEGIN DELETE FROM numeric_mentions WHERE source_id = OLD.id AND activity = 1; END;")?;
    let mut statement = tx.prepare("SELECT id, body, 0 FROM tickets UNION ALL SELECT id, body, 0 FROM documents UNION ALL SELECT id, brief, 1 FROM activities")?;
    let records = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (id, body, activity) in records {
        if activity {
            document_links::index_activity_before_references(tx, &id, &body)?;
        } else {
            document_links::index_body_before_references(tx, &id, &body)?;
        }
    }
    Ok(())
}

fn activity_graph_projections(tx: &Transaction<'_>, _: i64) -> Result<(), Error> {
    // Rebuildable, ordered projections let graph reads stop after a bounded
    // number of Activity mentions without walking unrelated Activities. The projection of
    // ticket numbers is made here, as the builds that wrote version 42 made it, but is not
    // filled: the ladder does not backfill them (see
    // `document_links::LEGACY_NUMERIC_MENTIONS_SCHEMA`) and format version 56 drops them.
    tx.execute_batch(document_links::LEGACY_ACTIVITY_GRAPH_NUMBERS_SCHEMA)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS activity_graph_targets (ticket_id TEXT NOT NULL, activity_id TEXT NOT NULL, target_id TEXT NOT NULL, passage TEXT NOT NULL, PRIMARY KEY(ticket_id, activity_id, target_id, passage));
        INSERT OR IGNORE INTO activity_graph_targets SELECT a.ticket_id, m.activity_id, m.target_id, m.passage FROM activity_mentions m JOIN activities a ON a.id=m.activity_id;
        CREATE TRIGGER IF NOT EXISTS activity_graph_targets_insert AFTER INSERT ON activity_mentions BEGIN INSERT OR IGNORE INTO activity_graph_targets SELECT ticket_id, NEW.activity_id, NEW.target_id, NEW.passage FROM activities WHERE id=NEW.activity_id; END;
        CREATE TRIGGER IF NOT EXISTS activity_graph_targets_delete AFTER DELETE ON activity_mentions BEGIN DELETE FROM activity_graph_targets WHERE activity_id=OLD.activity_id AND target_id=OLD.target_id AND passage=OLD.passage; END;
        CREATE INDEX IF NOT EXISTS activity_graph_targets_source ON activity_graph_targets(activity_id, target_id, passage);
        CREATE INDEX IF NOT EXISTS context_mentions_reverse_full ON context_mentions(target_id, source_id, passage);
        CREATE INDEX IF NOT EXISTS activity_mentions_reverse_full ON activity_mentions(target_id, activity_id, passage);")?;
    Ok(())
}

fn graph_search(tx: &Transaction<'_>, _: i64) -> Result<(), Error> {
    add_column_if_missing(tx, "documents", "body_heading", "TEXT")?;
    tx.execute_batch("UPDATE documents SET body_heading = nullif(trim(substr(ltrim(body, char(10)||char(13)||' '), 1, min(200, instr(ltrim(body, char(10)||char(13)||' ') || char(10), char(10)) - 1))), '');
        CREATE TRIGGER IF NOT EXISTS document_heading_insert AFTER INSERT ON documents BEGIN UPDATE documents SET body_heading = nullif(trim(substr(ltrim(new.body, char(10)||char(13)||' '), 1, min(200, instr(ltrim(new.body, char(10)||char(13)||' ') || char(10), char(10)) - 1))), '') WHERE id = new.id; END;
        CREATE TRIGGER IF NOT EXISTS document_heading_update AFTER UPDATE OF body ON documents BEGIN UPDATE documents SET body_heading = nullif(trim(substr(ltrim(new.body, char(10)||char(13)||' '), 1, min(200, instr(ltrim(new.body, char(10)||char(13)||' ') || char(10), char(10)) - 1))), '') WHERE id = new.id; END;")?;
    tx.execute_batch("CREATE VIRTUAL TABLE IF NOT EXISTS ticket_graph_fts USING fts5(title, body, content='tickets', content_rowid='rowid');
        INSERT INTO ticket_graph_fts(ticket_graph_fts) VALUES ('rebuild');
        CREATE TRIGGER IF NOT EXISTS ticket_graph_fts_insert AFTER INSERT ON tickets BEGIN INSERT INTO ticket_graph_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;
        CREATE TRIGGER IF NOT EXISTS ticket_graph_fts_delete AFTER DELETE ON tickets BEGIN INSERT INTO ticket_graph_fts(ticket_graph_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); END;
        CREATE TRIGGER IF NOT EXISTS ticket_graph_fts_update AFTER UPDATE OF title, body ON tickets BEGIN INSERT INTO ticket_graph_fts(ticket_graph_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); INSERT INTO ticket_graph_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;
        CREATE VIRTUAL TABLE IF NOT EXISTS plan_graph_fts USING fts5(name, purpose, content='plans', content_rowid='rowid');
        INSERT INTO plan_graph_fts(plan_graph_fts) VALUES ('rebuild');
        CREATE TRIGGER IF NOT EXISTS plan_graph_fts_insert AFTER INSERT ON plans BEGIN INSERT INTO plan_graph_fts(rowid, name, purpose) VALUES (new.rowid, new.name, new.purpose); END;
        CREATE TRIGGER IF NOT EXISTS plan_graph_fts_delete AFTER DELETE ON plans BEGIN INSERT INTO plan_graph_fts(plan_graph_fts, rowid, name, purpose) VALUES ('delete', old.rowid, old.name, old.purpose); END;
        CREATE TRIGGER IF NOT EXISTS plan_graph_fts_update AFTER UPDATE OF name, purpose ON plans BEGIN INSERT INTO plan_graph_fts(plan_graph_fts, rowid, name, purpose) VALUES ('delete', old.rowid, old.name, old.purpose); INSERT INTO plan_graph_fts(rowid, name, purpose) VALUES (new.rowid, new.name, new.purpose); END;")?;
    Ok(())
}

/// Step 84: what the read models need. Indexes for the counts and for the duplicates of
/// a ticket; full-text indexes that skip an update leaving the indexed text as it was, and
/// a Ticket upload mark that skips one leaving the row as it was; and the trigram index
/// that ticket search reads (`search::migrate`).
fn read_models(tx: &Transaction<'_>) -> Result<(), Error> {
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS duplicate_tickets_canonical ON duplicate_tickets(canonical_id, source_id);
         CREATE INDEX IF NOT EXISTS tickets_trashed_status ON tickets(trashed, status, updated_at, number);
         CREATE INDEX IF NOT EXISTS tickets_recent ON tickets(trashed, updated_at, number);
         DROP TRIGGER IF EXISTS ticket_graph_fts_update;
         CREATE TRIGGER ticket_graph_fts_update AFTER UPDATE OF title, body ON tickets
         WHEN OLD.title IS NOT NEW.title OR OLD.body IS NOT NEW.body BEGIN
             INSERT INTO ticket_graph_fts(ticket_graph_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
             INSERT INTO ticket_graph_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
         END;
         DROP TRIGGER IF EXISTS document_fts_update;
         CREATE TRIGGER document_fts_update AFTER UPDATE OF title, body ON documents
         WHEN OLD.title IS NOT NEW.title OR OLD.body IS NOT NEW.body BEGIN
             INSERT INTO document_fts(document_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
             INSERT INTO document_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
         END;",
    )?;
    sync::migrate_unchanged_tickets(tx)?;
    search::migrate(tx)
}

#[cfg(test)]
mod tests;
