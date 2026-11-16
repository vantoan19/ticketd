//! Workspaces as older code left them: built by the real migration ladder and seeded with
//! SQL that is valid at that format version, never with current `Workspace` methods.
// Each test file includes this module and uses some of its helpers, so the rest look
// unused in that file.
#![allow(dead_code)]

use std::path::Path;

use rusqlite::{Connection, params};

/// A new Workspace file at `version` (47 or later, when Attachments exist) holding one
/// local snapshot named `name`, with its bytes in the managed attachment storage beside
/// the file. Returns the Attachment's id.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
pub fn workspace_with_attachment(path: &Path, version: i64, name: &str, bytes: &[u8]) -> String {
    ticketd_core::create_workspace_at_format_version(path, version).unwrap();
    let id = format!("00000000-0000-4000-8000-{:012x}", name.len() * 7919);
    let locator = format!("{id}/bytes/{name}");
    Connection::open(path)
        .unwrap()
        .execute(
            "INSERT INTO attachments (id, display_name, original_filename, size_bytes, kind, locator) \
             VALUES (?1, ?2, ?2, ?3, 'local_snapshot', ?4)",
            params![id, name, bytes.len() as i64, locator],
        )
        .unwrap();
    let mut root = path.as_os_str().to_os_string();
    root.push(".attachments");
    let file = Path::new(&root).join(&locator);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, bytes).unwrap();
    id
}

/// A ticket as a Workspace before format version 56 stores one: it has no reference yet.
#[allow(clippy::unwrap_used)] // Setup that fails fails the test.
pub fn add_ticket(path: &Path, id: &str, title: &str) {
    Connection::open(path)
        .unwrap()
        .execute(
            "INSERT INTO tickets (id, title, status) VALUES (?1, ?2, 'Todo')",
            params![id, title],
        )
        .unwrap();
}
