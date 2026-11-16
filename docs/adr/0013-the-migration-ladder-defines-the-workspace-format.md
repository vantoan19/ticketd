# The migration ladder defines the Workspace format

## Decision

What a Workspace at format version V contains is defined by one thing: the
migration ladder in `crates/ticketd-core/src/format.rs`, an ordered list of
steps, one per format version. A Workspace at version V is exactly what running
steps 1 through V over an empty database leaves behind. Nothing else lists
tables, columns or triggers.

Only the ladder writes `PRAGMA user_version`. It writes it after each step,
inside the single immediate transaction that runs them all, and fails a run
whose step changed it. The behavior around that is unchanged: all or nothing,
a pre-migration backup first, foreign keys off before the transaction begins and
checked before it commits. Step bodies stay beside the domain code whose tables
they create.

A backup is validated against a scratch migration. `check_backup` builds the
backup's format version in memory and requires every table, column, trigger and
unique index created there to exist in the backup, matching by name. Extra
objects are allowed, and ordinary indexes and SQLite's own objects are skipped.
Unique indexes are compared because they enforce invariants (one active
Automation run per ticket and Automation, one active Turn per Chat, one open
publication attempt, unique Ticket references); a restore that lost one would
let the data break the rule.

Old steps are history and stay frozen. Two things make an edit to one visible:

- A generated, checked-in ledger (`crates/ticketd-core/format-ledger.txt`) lists
  what each format version added and removed, by name. A test regenerates it
  and compares; an environment variable rewrites it on purpose. An edit to an old
  step shows up as a diff in that version's section.
- Three small fixtures are backups saved by the code that shipped format
  versions 55, 65 and 72, made through that code's own CLI by
  `scripts/regenerate-format-fixtures`. A test checks that each validates as a
  backup, restores, and migrates to the current version.

The ledger covers names only. Types, defaults and data changes in old steps are
not guarded.

The JSON export fails closed in the same spirit: a test lists every table and
column of a new Workspace and fails unless `export.rs` classifies each as
exported or omitted, with a reason.

## Trade-off

A declarative catalog of the expected schema would say what a version contains
in one readable place, but it would be a second description of the same facts
beside the migrations, and keeping the two equal is the problem being solved.
Checksums of each step, as in Flyway, detect any edit but cannot say what
changed or whether it matters, and refuse benign ones such as a comment. Keeping
the hand-written lists and adding a test that compares them with the migrations
catches drift only after the test is written for each list, and leaves five lists
to maintain; it is what was there, and it had already drifted: backups saved at
format versions 70 to 75 were refused, and the JSON export had no Automations.

Building the expected schema on every backup check costs the time to run the
ladder in memory, which is small next to copying and verifying the backup.

Comparing by name misses a column whose type or default changed, a constraint
and a different trigger body. Comparing those would reject backups that are
safe to restore, because SQLite normalizes some of them; names catch the failure
that mattered, an object that is missing.

The ladder is history, so it cannot be tidied: a step that creates a table the
way an earlier version of the code did must keep doing so even when a later step
replaces it. Steps from before ticket references, for instance, build the
mention index keyed by ticket number, and format version 56 replaces it, as it
did for the Workspaces that were saved then.

A file-identity marker (`PRAGMA application_id`) is a possible follow-up and is
not part of this decision.
