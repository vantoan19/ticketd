use std::time::{Duration, Instant};
use ticketd_core::Workspace;

/// A poll must answer while the CLI or an agent holds the write lock: reads take no
/// write lock of their own, so they never wait out the busy timeout behind a writer.
#[test]
fn polled_reads_answer_while_another_connection_holds_the_write_lock() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let ticket = workspace.create_ticket("Remember").unwrap();
    workspace
        .set_reminder(&ticket.reference, Some("2020-01-01T00:00:00Z"))
        .unwrap();
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();

    let started = Instant::now();
    workspace.change_token().unwrap();
    workspace.sidebar_counts().unwrap();
    workspace.inbox_page(50, 0, false).unwrap();
    workspace.list_tickets().unwrap();
    workspace.find_tickets(&Default::default()).unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "reads waited {:?} behind the writer",
        started.elapsed()
    );
    writer.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn due_reminders_are_delivered_once_by_their_own_write_and_never_by_a_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite3");
    let mut workspace = Workspace::open(&path).unwrap();
    let due = workspace.create_ticket("Due").unwrap();
    let later = workspace.create_ticket("Later").unwrap();
    workspace
        .set_reminder(&due.reference, Some("2020-01-01T00:00:00Z"))
        .unwrap();
    workspace
        .set_reminder(&later.reference, Some("2999-01-01T00:00:00Z"))
        .unwrap();
    let token = workspace.change_token().unwrap();
    assert_eq!(workspace.sidebar_counts().unwrap().unread_inbox, 0);
    assert!(workspace.inbox(100, 0).unwrap().is_empty());
    assert_eq!(workspace.change_token().unwrap(), token);

    workspace.deliver_due_reminders().unwrap();
    let mut other = Workspace::open(&path).unwrap();
    other.deliver_due_reminders().unwrap();

    let inbox = workspace.inbox(100, 0).unwrap();
    assert_eq!(inbox.len(), 1);
    assert_eq!(
        (inbox[0].kind.as_str(), inbox[0].reference.as_str()),
        ("reminder", due.reference.as_str())
    );
    assert_ne!(workspace.change_token().unwrap(), token);
}

/// Adapters combine several reads in one snapshot, including reads that keep their own
/// snapshot when called alone.
#[test]
fn reads_combine_in_one_read_scope() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.sqlite3")).unwrap();
    let ticket = workspace.create_ticket("First").unwrap();
    let (listed, counted, graphed) = workspace
        .read(|w| {
            w.export()?;
            Ok((
                w.list_tickets()?.len(),
                w.sidebar_counts()?.total,
                w.dependency_graph(&ticket.reference)?.nodes.len(),
            ))
        })
        .unwrap();
    assert_eq!((listed, counted, graphed), (1, 1, 1));
}
