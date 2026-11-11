//! Workspace sync: change capture and the merge rules. Storage and file format live elsewhere.

mod capture;
pub mod merge;

pub use capture::{DirtyRecord, RecordKind};
pub(crate) use capture::{TRIGGER_EVENTS, captured_tables, migrate};
