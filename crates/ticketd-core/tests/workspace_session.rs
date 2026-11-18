//! The warm Workspace session of a long-running process (ADR 0016), against other
//! processes' work on the same file. Each other process is played by its own handle.
#![allow(clippy::unwrap_used)] // Setup that fails must fail the test.
use ticketd_core::{Workspace, WorkspaceSession};

#[path = "support/sync_desks.rs"]
mod sync_desks;
use sync_desks::desks;

fn titles(workspace: &Workspace) -> Vec<String> {
    let mut titles: Vec<_> = workspace
        .list_tickets()
        .unwrap()
        .into_iter()
        .map(|ticket| ticket.title)
        .collect();
    titles.sort();
    titles
}

/// A Workspace holding one ticket, saved as a backup beside `dir`'s Workspace.
fn backup_holding(dir: &std::path::Path, title: &str) -> std::path::PathBuf {
    let source = dir.join("source.sqlite3");
    let mut workspace = Workspace::open(&source).unwrap();
    workspace.create_ticket(title).unwrap();
    let backup = dir.join(format!("{title}.backup.sqlite3"));
    workspace.backup(&backup).unwrap();
    backup
}

/// A restore asks the warm session to let go instead of failing as in use; this
/// process's session lets go at once. On Windows this is also the file replace over a
/// file the session had open. The CLI's tests cover a session in another process.
#[test]
fn a_restore_takes_the_workspace_from_a_warm_session() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    Workspace::open(&path)
        .unwrap()
        .create_ticket("Before")
        .unwrap();
    let backup = backup_holding(dir.path(), "Restored");
    let session = WorkspaceSession::for_file(&path).unwrap();
    assert_eq!(titles(&session.workspace().unwrap()), ["Before"]);

    Workspace::restore(&path, &backup).unwrap();

    assert_eq!(titles(&session.workspace().unwrap()), ["Restored"]);
}

/// The `-wal` of the Workspace a restore replaces, as a process that died left it.
fn leave_a_wal_behind(path: &std::path::Path) {
    let session = WorkspaceSession::for_file(path).unwrap();
    session
        .write(|workspace| workspace.create_ticket("Left in the WAL").map(drop))
        .unwrap();
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    let frames = std::fs::read(&wal).unwrap();
    assert!(!frames.is_empty());
    drop(session);
    // Closing checkpointed it into the file; a crash would have left it. And an older
    // ticketd may have opened the file since in rollback mode, which ignores it.
    rusqlite::Connection::open(path)
        .unwrap()
        .pragma_update(None, "journal_mode", "DELETE")
        .unwrap();
    std::fs::write(&wal, frames).unwrap();
}

/// A WAL that replayed into the file a restore put in place would bring the replaced
/// Workspace back over it.
#[test]
fn a_restore_over_a_leftover_wal_holds_exactly_the_restored_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    Workspace::open(&path)
        .unwrap()
        .create_ticket("Before")
        .unwrap();
    let backup = backup_holding(dir.path(), "Restored");
    leave_a_wal_behind(&path);

    Workspace::restore(&path, &backup).unwrap();

    let session = WorkspaceSession::for_file(&path).unwrap();
    assert_eq!(titles(&session.workspace().unwrap()), ["Restored"]);
}

/// With no file to open, nothing takes the leftover WAL in before the swap; it is
/// removed instead of replaying into the restored file.
#[test]
fn a_restore_over_a_wal_without_its_file_holds_exactly_the_restored_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    Workspace::open(&path)
        .unwrap()
        .create_ticket("Before")
        .unwrap();
    let backup = backup_holding(dir.path(), "Restored");
    leave_a_wal_behind(&path);
    std::fs::remove_file(&path).unwrap();

    Workspace::restore(&path, &backup).unwrap();

    let session = WorkspaceSession::for_file(&path).unwrap();
    assert_eq!(titles(&session.workspace().unwrap()), ["Restored"]);
}

/// Downloading a Workspace from Drive replaces the file the same way.
#[test]
fn a_download_over_a_leftover_wal_holds_exactly_the_downloaded_workspace() {
    let desks = desks();
    let (a, _, _) = desks.uploaded("Desk A");
    let folder = a.sync_status().unwrap().folder.unwrap().id;
    let path = desks.directory.path().join("Desk B");
    desks
        .desk("Desk B")
        .create_ticket("Only on desk B")
        .unwrap();
    leave_a_wal_behind(&path);

    let session = WorkspaceSession::for_file(&path).unwrap();
    session
        .exclusive(|path| {
            Workspace::open_existing(path)?
                .sync_download_workspace(&desks.remote, &folder)
                .map(drop)
        })
        .unwrap();

    let mut b = session.workspace().unwrap();
    assert_eq!(titles(&b), Vec::<String>::new());
    b.sync_now(&desks.remote).unwrap();
    assert_eq!(titles(&b), ["Login"]);
}

/// In WAL mode a write commits while a read holds its snapshot, and the read goes on
/// seeing that snapshot.
#[test]
fn a_reader_and_a_writer_do_not_wait_for_each_other() {
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    Workspace::open(&path)
        .unwrap()
        .create_ticket("First")
        .unwrap();
    let session = WorkspaceSession::for_file(&path).unwrap();
    let (reading, read_started) = mpsc::channel();
    let (written, write_done) = mpsc::channel::<()>();
    let reader = std::thread::spawn({
        let session = session.clone();
        move || {
            session
                .read(|workspace| {
                    let before = titles(workspace);
                    reading.send(()).unwrap();
                    let _ = write_done.recv_timeout(Duration::from_secs(5));
                    Ok((before, titles(workspace)))
                })
                .unwrap()
        }
    });
    read_started.recv().unwrap();

    let started = Instant::now();
    session
        .write(|workspace| workspace.create_ticket("Second").map(drop))
        .unwrap();
    let waited = started.elapsed();
    let _ = written.send(());

    assert!(
        waited < Duration::from_secs(1),
        "the write waited {waited:?}"
    );
    let (before, after) = reader.join().unwrap();
    assert_eq!(
        (before, after),
        (vec!["First".to_owned()], vec!["First".to_owned()])
    );
    assert_eq!(titles(&session.workspace().unwrap()), ["First", "Second"]);
}

/// A newer ticketd that migrated the file meanwhile is found on the next use, which
/// refuses it as newer like any open.
#[test]
fn a_schema_changed_by_another_connection_is_checked_again_on_the_next_use() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    drop(Workspace::open(&path).unwrap());
    let session = WorkspaceSession::for_file(&path).unwrap();
    session.workspace().unwrap().list_tickets().unwrap();

    let newer = rusqlite::Connection::open(&path).unwrap();
    let version: i64 = newer
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    newer
        .execute_batch("CREATE TABLE from_a_newer_ticketd (id INTEGER)")
        .unwrap();
    newer
        .pragma_update(None, "user_version", version + 1)
        .unwrap();

    assert!(matches!(
        session.workspace().map(drop),
        Err(ticketd_core::Error::WorkspaceUnavailable { source, .. })
            if matches!(*source, ticketd_core::Error::NewerSchema(v) if v == version + 1)
    ));
}

/// A backup of a Workspace in WAL mode is one file, as backups always were: copied on
/// its own, it holds everything.
#[test]
fn a_backup_made_from_a_warm_session_is_a_single_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    drop(Workspace::open(&path).unwrap());
    let session = WorkspaceSession::for_file(&path).unwrap();
    let backup = dir.path().join("backup.sqlite3");
    session
        .write(|workspace| {
            workspace.create_ticket("Backed up")?;
            workspace.backup(&backup)
        })
        .unwrap();

    let mode: String = rusqlite::Connection::open(&backup)
        .unwrap()
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "delete");
}
