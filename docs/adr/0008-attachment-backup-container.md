# Single-file attachment backups with recoverable restore

## Decision

Keep the existing SQLite backup file for workspaces with no retained files.
Attachment-bearing backups are SQLite containers with independent container
version **1**, alongside the unchanged workspace `user_version`. Two private
tables, `ticketd_backup_container` and `ticketd_backup_files`, hold the container
version, SHA-256 inventory digest, portable relative paths, sizes, SHA-256 file
digests and file blobs. The inventory covers every retained file, so removing an
unused or quarantined file from a backup is detectable even without an active
database reference. Digests detect accidental damage; they do not authenticate
an untrusted backup author.

The core streams blobs in 64 KiB buffers. Each file must fit SQLite's blob limit
(and its signed 32-bit incremental-blob API); ordinary uploads retain their
existing smaller upload limit, and the workspace upload limit is capped at 999,000,000
bytes (SQLite's 1,000,000,000-byte row limit, with room for the row's path and
checksum), so every file that can be attached can be backed up. No compression or
encryption is introduced.
Database integrity, foreign keys, schema requirements, inventory, per-file
checksums, and every local record's required locator and size are checked.
Unknown container versions are refused with instructions to update ticketd.
Extraction rejects absolute paths, traversal, Windows drive/stream syntax and
non-portable separators. Packaging refuses symbolic links and special files.

Backups hold the existing cross-process upload lock across upload recovery,
SQLite snapshot creation and file packaging. Every regular retained file below
the managed attachment root is included recursively, independently of reference
state, including recovery manifests and future quarantine storage. In-progress
`.upload-*` directories and `.uploads.lock` are excluded. Later cleanup must use
this same lock for byte moves/purge and retain quarantined locators in the core's
local-byte contract until explicit purge. A completed upload whose metadata has
not committed remains recoverable from its retained manifest.

Backup output is staged, synced and published without replacing an existing
file. The backup destination must be outside managed attachment storage.
Migration and restore safety copies use the same packaging. Credentials remain
outside workspace data; remote records contain references and metadata only,
without a provider call or a promise that remote bytes were captured.

## Restore and interruption recovery

Restore acquires the existing exclusive workspace lock. It verifies the source
in one read snapshot, extracts files into a sibling staging directory, copies
the database into a sibling staging file, and removes archive-only tables from
that staged live database. A staged `VACUUM` reclaims the dropped blob pages,
so the live database does not retain a second copy of archived files. No archive
tables or bytes enter ordinary exports.
Opening a container as a live workspace is refused with a restore instruction.
The computer's last-backup record is preserved, matching existing behavior.

Before replacement, the complete current workspace is saved as a single safety
backup. A complete safety copy is required; a broken current snapshot therefore
blocks replacement rather than silently losing its retained data. The refusal
names missing current files and provides a separate recovery route:
`ticketd restore-workspace backup.sqlite3 --target recovered.sqlite3`. The CLI
passes this explicit destination to the same core restore workflow. It neither
changes the selected desktop workspace nor bypasses destination safety checks.
The core publishes a synced `.restore.json` journal containing a UUID, whether the old
attachment root existed, and the staged database digest. It renames the old root
to a UUID-named sibling, installs the staged root, then atomically replaces the
database file. Database replacement is the commit point.

After an error or process interruption, recovery runs under the exclusive lock
before another connection opens. If the live database matches the staged digest,
the replacement committed and the retired root can be removed. Otherwise, the
old root is reinstated (or the new root removed when there was no old root).
The original database remains in place until atomic replacement. A recovery
failure keeps the journal and blocks opening; the complete safety backup remains
available for explicit recovery. Directory changes are synced on Unix. Windows
uses the platform's atomic file replacement through `tempfile`; filesystem and
hardware durability still depend on the operating system and storage device.

## Trade-off

A single SQLite file preserves the existing save/open filters, safety-backup
listing and file-manager workflow without introducing an archive dependency or
a fragile database-plus-sidecar backup set. Bounded blob I/O avoids buffering a
workspace's files in memory. The costs are an uncompressed container, extra disk
space for staging and safety copies, and explicit coordination across the
database/filesystem boundary. The journal is necessary because SQLite cannot
atomically commit directory replacement with a database change.

Supported older database-only backups remain readable when they require no
local bytes. A database-only copy with local records is incomplete and refused.
Workspace schema migrations and container format evolution remain independent.
