# Durable private drafts and separate Undo attachment protection

## Decision

Persist a host's recovery payload and its derived attachment references in the
same SQLite savepoint behind the Workspace interface. Keep canonical Markdown
as the reference authority. No ticket, Document, Activity, search result or
promotion is created solely to retain a draft. Full workspace backups include
private recovery prose and protection rows; ordinary domain JSON exports do not.

Each recovery owner has a monotonic compare-and-swap revision. Release writes an
empty tombstone rather than deleting the owner, so stale windows and late async
completions cannot resurrect or clear newer recovery. Exact replay of the last
revision/content returns its original result. Desktop operations serialize, keep
failed operations for explicit retry, and flush protection before publishing or
saving canonical content. Document capture and Activity submit request identities
are recovery data too.

Keep editor history independent of current recovery. An Undo owner accumulates
references from all values the editor could restore, even after autosave or
controlled replacement. Reset/unmount retires that transient history; it never
retires a host's persisted current draft or Document conflict Reload Undo offer.
A crash before history release can leave extra protection. Keep it for deliberate
review rather than guessing that silence or a timeout means work is disposable.
Releasing claims never moves or deletes files.

Usage unions direct ticket associations, saved ticket/Document/Activity Markdown,
drafts and Undo in one read snapshot. Trash remains a protection, and Activity
details remain Document-owned without flattening into the ticket. Cleanup
eligibility is advisory until a later cleanup workflow rechecks it while
coordinating its database and filesystem effects. No reference writer may acquire
the upload lock after taking the SQLite writer lock.

## Legacy recovery

An upgraded workspace with retained attachment records may have browser-only
drafts that the CLI cannot discover. Only those upgrades start with cleanup
eligibility withheld. Desktop startup imports all current-profile legacy ticket,
Activity, details, support and submit-request slots before mounting editors,
removing each browser slot only after its replacement commits. An existing core
owner, including a tombstone, takes precedence over a browser mirror. A differing
legacy payload is preserved under a stable profile-specific recovery owner
before removing its browser slot; it never overwrites the primary recovered draft.
`attachment recovery-drafts` explicitly inspects private recovery payloads,
including these separately retained drafts, for recovery into an editor.

One profile cannot prove other profiles empty. The desktop therefore offers an
explicit acknowledgement after all profiles are reviewed; the CLI offers the
same acknowledgement with `attachment complete-draft-migration
--all-profiles-reviewed`. This affects eligibility only, not file availability.
Fresh CLI-only workspaces and attachment-free upgrades do not need this step.

## Trade-off

References alone would be smaller but would separate byte protection from
recoverable prose and leave backup recovery dependent on one browser profile.
Private recovery payloads close that gap without creating a general Draft domain
entity. The costs are additional workspace-private data in backups, small release
tombstones, and conservative protection after an interrupted release. No lease
expiry or automatic deletion is introduced.
