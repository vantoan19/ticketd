use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
};

use crate::{Error, Workspace};

/// Byte offset of the file-format write and read versions in the SQLite header.
const FORMAT_VERSIONS_OFFSET: u64 = 18;
/// Byte offset of the "file change counter" in the SQLite database header.
const CHANGE_COUNTER_OFFSET: u64 = 24;
/// Both format versions are 1 in rollback-journal mode and 2 in WAL mode.
const ROLLBACK_JOURNAL: [u8; 2] = [1, 1];

impl Workspace {
    /// Return a token that differs after any committed write by any process, or
    /// `None` when this database cannot provide one.
    ///
    /// Callers compare tokens for equality only, to skip re-reading data when
    /// nothing changed; `None` means "unknown", so they must re-read. The token is
    /// the SQLite file change counter, which every write transaction advances in the
    /// rollback-journal mode this workspace uses. In WAL mode commits do not advance
    /// it, so the header's version bytes are checked first and any other mode yields
    /// `None` rather than a token that would freeze. (A restore from a WAL backup can
    /// produce such a file.) `PRAGMA data_version` cannot serve here: the desktop
    /// opens a new connection for each command.
    pub fn change_token(&self) -> Result<Option<u32>, Error> {
        let mut file = File::open(&self.path)?;
        let mut versions = [0u8; 2];
        file.seek(SeekFrom::Start(FORMAT_VERSIONS_OFFSET))?;
        file.read_exact(&mut versions)?;
        if versions != ROLLBACK_JOURNAL {
            return Ok(None);
        }
        let mut counter = [0u8; 4];
        file.seek(SeekFrom::Start(CHANGE_COUNTER_OFFSET))?;
        file.read_exact(&mut counter)?;
        Ok(Some(u32::from_be_bytes(counter)))
    }
}
