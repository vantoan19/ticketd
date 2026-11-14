//! Lines a file change adds and removes, counted from the diff the harness sent with
//! it. Shared by the Codex report and the Chat view's step rows, so a step's
//! diffstat and its turn's changed-files row count the same way.
use crate::FileChangeKind;

/// `(added, removed)`. An added or deleted file's diff is its content.
pub fn counts(kind: &FileChangeKind, diff: &str) -> (u32, u32) {
    let lines = u32::try_from(diff.lines().count()).unwrap_or(u32::MAX);
    match kind {
        FileChangeKind::Added => (lines, 0),
        FileChangeKind::Deleted => (0, lines),
        FileChangeKind::Modified | FileChangeKind::Renamed { .. } => unified(diff),
    }
}

/// `(added, removed)` from a unified diff, leaving out its file headers.
pub fn unified(diff: &str) -> (u32, u32) {
    let (mut added, mut removed) = (0u32, 0u32);
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            added = added.saturating_add(1);
        } else if line.starts_with('-') {
            removed = removed.saturating_add(1);
        }
    }
    (added, removed)
}
