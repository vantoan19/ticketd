//! The open report: the `report.started` file in the log folder.
//!
//! Starting a report turns detailed logging on, and the file is what makes it outlast a
//! restart: the next launch finds it and turns logging on again before its first event.
//! Saving or cancelling the report removes it.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};

const MARKER_FILE: &str = "report.started";

/// A report that is open, and when it started.
pub(crate) struct ReportMarker {
    path: PathBuf,
    started_at: String,
}

impl ReportMarker {
    /// Records that a report starts now. A folder that cannot be written only means the
    /// report ends with this run.
    pub(crate) fn write(dir: &Path) -> Self {
        let path = dir.join(MARKER_FILE);
        let started_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let _ = fs::write(&path, &started_at);
        Self { path, started_at }
    }

    /// The report an earlier run left open, if its file can be read.
    pub(crate) fn read(dir: &Path) -> Option<Self> {
        let path = dir.join(MARKER_FILE);
        let text = fs::read_to_string(&path).ok()?;
        let started = DateTime::parse_from_rfc3339(text.trim()).ok()?;
        Some(Self {
            path,
            started_at: started
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        })
    }

    pub(crate) fn started_at(&self) -> &str {
        &self.started_at
    }

    pub(crate) fn remove(self) {
        let _ = fs::remove_file(&self.path);
    }
}
