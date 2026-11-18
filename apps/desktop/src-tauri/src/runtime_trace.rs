//! Measures the desktop's runtime against a disposable Workspace (#477): what the
//! background loops cost while idle, and whether commands wait for a write another
//! process holds. Both take time, so they run only when asked:
//!
//! ```text
//! TICKETD_TEST_WORKSPACE=<new folder>/workspace.sqlite3 \
//!   cargo test -p ticketd-desktop runtime_trace -- --ignored --nocapture --test-threads=1
//! ```
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // a measurement harness

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use ticketd_chat_host::WorkspaceOpener;
use ticketd_core::{Status, TicketPatch};

use crate::automation_runner::AutomationRunner;
use crate::chats::Chats;
use crate::sync_scheduler::Scheduler;

static USES: AtomicUsize = AtomicUsize::new(0);

/// The desktop's own opener, counted: each call is one use of the warm session.
fn counted() -> Result<ticketd_core::WorkspaceGuard, ticketd_core::Error> {
    USES.fetch_add(1, Ordering::SeqCst);
    crate::open_workspace()
}

fn workspace_path() -> std::path::PathBuf {
    std::env::var_os("TICKETD_TEST_WORKSPACE")
        .expect("set TICKETD_TEST_WORKSPACE to a disposable workspace file")
        .into()
}

/// With Chat on, sync not set up and no Automation, the loops are started as the
/// desktop starts them and left alone for a minute.
#[test]
#[ignore = "takes a minute; see the module comment"]
fn runtime_trace_idle_minute() {
    let _ = workspace_path();
    crate::open_workspace().unwrap();
    let runtime = tauri::async_runtime::handle();
    let opener: WorkspaceOpener = Arc::new(counted);
    let chats = Chats::new(opener.clone(), Vec::new(), Vec::new(), None);
    runtime.block_on(chats.set_enabled(true));
    chats.start().unwrap();
    let runner = AutomationRunner::new(chats, opener, Arc::new(|_| Ok(())));
    runtime.spawn(crate::automation_runner::run(runner));
    let sync = Arc::new(Scheduler::new(
        Box::new(counted),
        Box::new(crate::sync_commands::binding),
        Box::new(crate::sync_commands::upkeep),
    ));
    sync.start(Instant::now(), || {});
    crate::start_reminder_timer(counted);
    // Start-up: the first pass of each loop.
    std::thread::sleep(Duration::from_secs(2));
    let at_start = USES.swap(0, Ordering::SeqCst);
    let mut each_second = Vec::new();
    for _ in 0..60 {
        std::thread::sleep(Duration::from_secs(1));
        each_second.push(USES.load(Ordering::SeqCst));
    }
    println!("start-up uses: {at_start}");
    println!("idle uses over 60 s: {}", USES.load(Ordering::SeqCst));
    println!("cumulative uses by second: {each_second:?}");
}

/// Another process holds the write lock for five seconds, as a CLI write would.
/// The reads a view makes answer at once; a write waits for the lock, on its own
/// worker, as the main thread no longer runs either.
#[test]
#[ignore = "takes five seconds; see the module comment"]
fn runtime_trace_write_held_elsewhere() {
    let path = workspace_path();
    let ticket = crate::open_workspace()
        .unwrap()
        .create_ticket("Held")
        .unwrap();
    let (held, holding) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let connection = rusqlite::Connection::open(path).unwrap();
        connection.execute_batch("BEGIN IMMEDIATE").unwrap();
        held.send(()).unwrap();
        std::thread::sleep(Duration::from_secs(5));
        connection.execute_batch("COMMIT").unwrap();
    });
    holding.recv().unwrap();
    let locked = Instant::now();
    let write = std::thread::spawn(move || {
        let started = Instant::now();
        let changed = crate::change_ticket(
            ticket.reference.clone(),
            TicketPatch {
                status: Some(Status::Done),
                ..Default::default()
            },
            None,
        );
        (started.elapsed(), changed.is_ok())
    });
    let mut reads = Vec::new();
    for _ in 0..20 {
        let started = Instant::now();
        crate::workspace_change_token().unwrap();
        crate::sidebar_counts().unwrap();
        crate::show_ticket(ticket_reference()).unwrap();
        reads.push(started.elapsed());
        std::thread::sleep(Duration::from_millis(100));
    }
    reads.sort();
    println!(
        "reads while the lock was held ({:?} in): median {:?}, slowest {:?}",
        locked.elapsed(),
        reads[reads.len() / 2],
        reads[reads.len() - 1]
    );
    let (waited, saved) = write.join().unwrap();
    println!("the write waited {waited:?}, saved: {saved}");
    holder.join().unwrap();
}

fn ticket_reference() -> String {
    crate::open_workspace()
        .unwrap()
        .list_tickets()
        .unwrap()
        .remove(0)
        .reference
}
