use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
};

use crate::{Error, Workspace};

/// Byte offset of the "file change counter" in the SQLite database header.
const CHANGE_COUNTER_OFFSET: u64 = 24;

impl Workspace {
    /// Return a token that differs after any committed write by any process.
    ///
    /// Callers compare tokens for equality only, to skip re-reading data when
    /// nothing changed; the value has no other meaning. It is the SQLite file
    /// change counter, which every write transaction advances in the default
    /// rollback-journal mode this workspace uses. `PRAGMA data_version` cannot
    /// serve here: the desktop opens a new connection for each command, and the
    /// pragma ignores writes made on its own connection.
    pub fn change_token(&self) -> Result<u32, Error> {
        let path = self
            .connection
            .path()
            .ok_or_else(|| Error::Backup("the workspace has no database file".into()))?;
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(CHANGE_COUNTER_OFFSET))?;
        let mut bytes = [0u8; 4];
        file.read_exact(&mut bytes)?;
        Ok(u32::from_be_bytes(bytes))
    }
}
