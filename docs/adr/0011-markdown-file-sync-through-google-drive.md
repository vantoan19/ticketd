# Workspace sync as one Markdown file per record in the person's Google Drive

## Decision

A person's desktops share one Workspace through that person's own Google Drive. Each device keeps its own SQLite Workspace and local Attachment files and stays fully usable offline. Every ticket, Document, Plan and project is also written to an app-created, visible Drive folder as one readable Markdown file: a YAML header for fields, then the Markdown text, with a ticket's Activities and Implementation evidence as sections of the ticket's file ([sync file format](../sync-file-format.md)). Managed Attachments are ordinary files beside them. Devices upload the files of records that changed and poll for files changed elsewhere. The live SQLite file is never synchronized.

The files are not encrypted. There is no sync password, key handling or key recovery. Access stays within the existing `drive.file` scope, so ticketd sees only files it created.

There is no ticketd server, account or subscription. One Workspace has one storage destination. Two Workspaces created independently are never merged automatically: a device joining sync either uploads its Workspace or replaces it with the one in Drive.

## Why

- **Readable files.** The person can open, search and back up their content in Drive without ticketd, and other tools can read it. A hand edit in Drive is accepted as an edit from another device once the file validates.
- **Simple enough for one person.** The feature serves a single person moving between desktops, usually at different times. One file per record needs no server, no ordering protocol between devices and no cleanup of shared state. A device needs only the files and its own copy of each as last synced.
- **Drive is not a transactional store.** It has no conditional update and no multi-file commit, listings carry no consistency guarantee across pages, and file names are not unique in a folder. A design that needs several files to change together, or that reads a listing as the complete truth, cannot be made reliable on it. Here each file stands alone: a missing file, an empty listing or a failed authorization is treated as a recovery event (upload again, or ask to reconnect) and never as a deletion.

Joplin's one-file-per-item sync on plain file storage is the closest precedent, and its comparison against a stored sync base is the source of the merge rule below.

## The dropped direction

The earlier design encrypted content on the device and published immutable record revisions to Drive in batches, which devices then replayed. It was dropped before any of it was built:

- it needed a sync password, key derivation, key storage and a recovery story for a lost password, all for one person's own Drive;
- batches are multi-file units with an order, which is the kind of consistency Drive does not provide, and the approach was unproven there;
- the remote content would have been unreadable without ticketd, and an ever-growing set of revisions would have needed snapshots, compaction and deletion records kept indefinitely;
- the complexity was out of proportion to a single-person feature with no operator infrastructure.

## Identity

Every synchronized record is identified by its GUID, carried in the file header. A file is found by that GUID, never by its name, which is only a readable label in Drive. Tickets, Documents, Plans, projects, Activities, Implementation evidence and Attachments all have one. The GUID is the identity for sync now and for any later service.

The Ticket reference is a readable label, not the identity: `T-`, the two-letter device code of the device that created the ticket, then that device's own counter, with no dash (`T-KQ43`). Devices therefore issue references offline without clashing. A device code is random; a device joining sync checks the device list kept in Drive and takes another code if its own is in use there or was given up by a device of that folder (the list keeps retired codes, because tickets still carry them). A Workspace restored from a backup takes a fresh code. An issued reference never changes.

A Workspace file copied by hand to another machine starts with the device identity and code of the original, so it is detected when the two sync to one folder. On every run a desktop writes a fresh random run token into its own entry of the device list and keeps the same token locally. A desktop that finds a token in its entry that it did not write knows another copy synced under its identity: it takes a new device identity and a code no desktop of the folder holds or gave up, registers as a new desktop and carries on. Which of the two changes is whichever runs after the other has synced; the code they shared stays with the other one. A desktop that synced before run tokens existed has none on either side and is not taken for a copy.

The limit: detection needs one run of each copy after the copy was made. Until then both still issue from the same code and counter, so a ticket created on each can carry the same reference. The two are different tickets (different GUIDs) and each gets its own file, but a desktop that holds one cannot take in the other under a reference already held: it reports that file under Needs attention and does not merge it. Moving a Workspace between machines through backup and restore, or by downloading it from Drive, has no such window.

There are no numeric aliases such as `T-42`.

Each relationship is written in exactly one file (a dependency in the blocked ticket, a parent in the child, tags in the tagged record), so no relationship can disagree with itself across two files.

## Merging

Each device keeps a copy of every file as it was last synced. When a record changed both locally and in Drive, each side is compared with that copy:

- **Different fields changed:** both changes are kept, silently.
- **The same field changed:** the local value is kept, the record is marked Needs review, and the person chooses or edits the value in a side-by-side comparison of the conflicting fields. A field is merged as a whole. The Markdown text is one field; there is no automatic text merging.
- **Tags and other sets:** additions and removals from both sides combine. An addition wins over a concurrent removal. No review.
- **Dependency loops:** two devices can each add a dependency that is valid alone and forms a loop together. Every device then drops the same edge, the later one, chosen by a rule that depends only on the set of edges, and shows a notice naming it.

No duplicate ticket or conflict-copy file is ever created. A file that cannot be read is skipped with a Needs attention notice and changes nothing locally.

Files and the two shared JSON files carry a format number. A file from a newer ticketd (a higher number, or a field this version does not know) is skipped the same way and is never replaced by a device that cannot read it; that record's local changes wait until the device is updated. A device whose own last-synced copy of a file cannot be read treats the record as never synced, so a differing value goes to review instead of being taken or sent silently.

## Trash and deletion

Trash is the `trashed` field. Sync never deletes a record, locally or in Drive. Trashing on one device while another edits the record merges as two different fields: the record stays in Trash with the edit preserved, and restoring is an explicit act. Permanent deletion may be added later and would need its own design.

## Restoring a backup

Restoring a backup disconnects the Workspace from its sync folder: the folder is forgotten together with the last-synced copies. The restored Workspace has whatever Drive sign-in the backup held, which may be none or another account than the replaced Workspace used. Left connected, the next run would merge the folder back in and silently undo the restore, since every file there is newer than the restored content. The person instead chooses again between uploading the restored Workspace (it merges with the folder like a first upload, with differing values going to review) and downloading the one in Drive. Downloading a Workspace is the one restore that keeps its folder, because that restore is how the downloaded Workspace is put in place.

## History

Each device keeps earlier versions of tickets and Documents in its own database: whenever a local edit or an incoming sync replaces one, the previous version is saved. Versions are kept for 30 days and the current version always. Restoring a version is an ordinary edit, which then syncs. Versions themselves do not sync; a newly added desktop reads a record's earlier versions from Drive's own file revisions on request.

This history is also what makes keeping the local value on a same-field conflict, and accepting hand edits from Drive, safe: an overwritten value can be recovered for 30 days.

## Relation to ADR-0003

[ADR-0003](0003-defer-record-versioning.md) still governs local edits. Writes from the desktop and the CLI on one device carry no record versions, change only supplied fields, and the last successful write to a field wins. Nothing in this decision adds stale-edit rejection to the workflow interface.

This ADR governs only what happens between devices. The last-synced copy is a sync base held by the sync engine, not a record version callers see or supply. Local changes are captured inside the core in the same SQLite transaction as the write, so CLI edits made while the desktop is closed upload when it next runs, and applying an incoming file is not captured as a local change.

## Consequences

- Synced content is stored unencrypted in the person's Drive, protected by their Google account alone. The app says so at setup, and [PRIVACY.md](../../PRIVACY.md) records it.
- Sync runs only while the desktop app is open. The CLI neither uploads nor downloads.
- Because Drive has no conditional update, a file's version is checked immediately before upload. A write by another device inside that short window is replaced as the current file and remains in Drive's revisions. Two devices creating the same file at once can leave two Drive files; every device resolves to the oldest and ignores the other.
- A synced file that is missing from Drive is uploaded again by the next run of any desktop that synced it; absence is never read as a deletion. A desktop that had not yet received the file's latest version puts it back with its own, older content. The other desktops then merge that file as a change made elsewhere: fields they did not change since take the older value, and fields they changed stay or go to review. The earlier value is in each desktop's History.
- Every run writes the desktop's run token to the device list, so a connected desktop makes one small Drive write per poll even when nothing changed.
- Change discovery lists the whole folder and compares file versions. This is adequate for one person's Workspace and is the first thing to revisit if a Workspace outgrows it.
- Personal state stays on each device: Attention inbox read state, checkout paths, credentials, window layout, unfinished drafts and upload queues.
- The remote side sits behind a narrow file-storage interface with a Google Drive adapter. Other storage providers are not planned.
- A later paid ticketd cloud may use a stronger protocol with server-side ordering, accounts and encryption. Nothing here builds it; GUID identity and device-scoped references are the parts intended to carry over.
