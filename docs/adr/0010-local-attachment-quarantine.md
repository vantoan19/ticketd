# Reversible local quarantine with short writer coordination

## Decision

Local cleanup is explicit. Core review returns reasons and saved, draft, Undo and
Trash protections; execution rechecks them under the SQLite writer lock.
Unreviewed legacy browser profiles withhold eligibility. External records have no
reclaimable local bytes and never enter these operations.

Quarantine moves a snapshot from `<id>/bytes/<filename>` to
`<id>/quarantine/<filename>`, then records its state in the same write boundary.
The stable locator, identity, name, upload receipt and original bytes remain
unchanged. New canonical references and retained drafts with available bytes
restore quarantined content before committing their references. Missing-byte draft
prose remains recoverable; new canonical references require usable bytes.
Quarantine still occupies disk space and remains part of complete backups.

SQLite cannot transact filesystem moves. Both fixed retained locations therefore
resolve through the same checked snapshot reader. A failed metadata/reference
commit can leave bytes in the other location without losing them or claiming a
new reference committed. Retry reconciles the location before updating state;
neither recovery nor rollback deletes retained bytes. Moves sync both directories
where the platform supports directory sync.

Quarantine and explicit restore acquire the upload lock before the database writer
lock. Canonical and draft writers restore under their existing writer boundary;
they never acquire the upload lock from inside it. Retryable quarantine/restore
requests commit their original outcomes with state, so replay cannot repeat a move
after a later restore or reference.

The checked reader tries active bytes, quarantine, then active bytes again only
when a path is missing. This bounded retry covers a canonical Undo moving the
file during inspection; incomplete bytes and unsafe paths still fail explicitly.
Portable export retains that checked open handle through copying rather than
reopening its path, preventing false omissions during the one-way restore.

## Complete backups

The upload lock excludes imports, cleanup and future purge. A separate SQLite
connection holds a writer barrier only while capturing the database snapshot and
retained path inventory, releasing it before copying/hashing file bodies.
Packaging opens one input at a time, keeping descriptor use bounded independently
of attachment count.

Canonical Undo can restore a captured quarantine file while packaging continues.
Only that snapshot's active-byte path can supply a captured quarantine path that
moved; cleanup cannot move it back while backup owns the upload lock. Packaging
retains the captured relative path, coherent with the database snapshot. Inventory
digests, per-file checksums and complete-byte validation remain mandatory. Other
missing files or I/O errors refuse backup without publishing a partial result.
Workspace schema 53 adds state and nullable registration time; backup container
version 1 remains unchanged.

## Added dates

New local registrations record UTC time in the synced upload receipt before
publication; new external records record it in their first insert. Rename,
retries, metadata refresh and backup/restore preserve that value. Existing records
and older receipts without date evidence retain an unknown date; migration time
is never shown as the date a file was added.

## Explicit permanent purge

Schema 54 adds `attachments.purge_state`: retained, pending, or purged. Only an
explicit `Workspace::purge_attachment` invocation can start or resume deletion.
Desktop confirmation and `attachment purge <id> --confirm` use this workflow;
quarantine and restore remain separate reversible operations.

Purge takes the upload lock before a short writer transaction. It rechecks all
saved, draft, Undo, Trash and legacy-cutover protections and requires checked
quarantine bytes before committing pending intent. New canonical references then
refuse unavailable bytes. Late recovery text can still retain its literal links,
with unavailable status; it cannot undo already committed purge intent.

Deletion runs outside the writer transaction and removes only the expected regular
file under the checked quarantine location. It never recursively removes a
directory, receipt, unrelated file or remote content. A second short transaction
records purged only after successful deletion and directory sync where supported.
Failure before intent leaves bytes retained. Failure after intent remains pending,
with actionable explicit-retry guidance; neither opening nor backup retries it.
An interrupted deletion can be retried when that exact path is already missing.

Pending purge blocks complete backup publication. Completed purges retain metadata,
but no longer require bytes in backup completeness checks. Older valid backups
still restore the earlier quarantine and exact bytes deliberately; current backups
preserve the purged identity and status. Container version 1 remains unchanged.
Upload receipts and retained write outcomes stay intact. Replay preserves original
metadata with current purge status so it cannot imply that destroyed bytes survived
or create another snapshot with the old operation identity.

## Trade-off

Resolving two fixed locations avoids a general filesystem journal for immutable
single-file snapshots and conservatively preserves recovery after interruption.
The path inventory uses memory proportional to file count, as before, without
one descriptor per file or blocking writers during large byte copies. Every
destructive byte operation must use the upload lock. These guarantees do not
protect against an unrelated process modifying managed storage directly.
