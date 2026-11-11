//! Workspace sync between a person's desktops through their own file storage:
//! change capture, the merge rules and the remote file storage interface.

mod capture;
pub mod merge;
pub mod remote;

pub use capture::{DirtyRecord, RecordKind};
pub(crate) use capture::{TRIGGER_EVENTS, captured_tables, migrate};
