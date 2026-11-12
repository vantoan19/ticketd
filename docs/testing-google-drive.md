# Testing Google Drive

The Drive integration has three separate verification layers. A provider fixture
can prove a failure contract, while live Google checks establish API and account
compatibility. Desktop verification also needs real IPC and native dialogs.

## Deterministic regression suite

Run `./scripts/check-drive` from a checkout with the pinned Rust and npm toolchains
and installed frontend dependencies. On Windows, run it through Git Bash. It uses
temporary databases, synthetic inputs and deterministic provider responses; it
does not access a Google account. Two test workers are the default to avoid
resource starvation. `./scripts/check` remains the final repository quality gate.

The focused suite covers publisher configuration, OAuth and Picker validation,
account/file identity, scoped authorization, resumable upload/reconciliation,
destination binding, access recovery, uploaded-copy inspection and byte export,
portable links, backup exclusion of credentials and remote bytes, protected
removal, the shared editor's upload/recovery interactions, and the Workspace
sync storage contract (one suite for the in-memory fake and the Drive adapter)
with the adapter's authorization renewal, pagination, retries and recovery states.

Environment-gated migration and OS-vault tests report as ignored in the ordinary
suite. Run them explicitly with their documented prerequisites when those
boundaries change. An ignored test is never evidence that its gate passed.

| Boundary            | Historical CLI environment variable | Rust test target     |
| ------------------- | ----------------------------------- | -------------------- |
| Schema 50           | `TICKETD_SCHEMA50_CLI`              | `drive_references`   |
| Schema 51           | `TICKETD_SCHEMA51_CLI`              | `drive_uploads`      |
| Schema 52           | `TICKETD_SCHEMA52_CLI`              | `attachment_cleanup` |
| Schema 53           | `TICKETD_SCHEMA53_CLI`              | `attachment_purge`   |
| Schema 54           | `TICKETD_SCHEMA54_CLI`              | `drive_uploads`      |
| OS credential store | Unlocked OS-user secure store       | `drive_vault`        |

Point each variable to an actual historical executable with the command support
required by the test. A schema's first introducing commit may predate those
commands; use a complete release of that schema. Build historical code in a
detached checkout with its own build output and no publisher OAuth environment.
Before any mutation, run its read-only `workspace` probe with an explicit
`TICKETD_TEST_WORKSPACE` path and verify that exact path is reported. Stop if the
old CLI ignores the override. The current tests create their own temporary data.

Run the relevant target with `cargo test -p ticketd-core --test TARGET -- --ignored`.
The `drive_uploads` target needs both historical CLI variables. Record executable
hashes and revisions with the results; do not substitute a current executable
with its schema number edited in SQLite.

## Live Google and native desktop

The opt-in runner under `tests/live` uses a publisher-configured standalone CLI,
an explicitly provided authorized connection and writable folder, and an isolated
Workspace. Follow its help for parameters. It creates uniquely named synthetic
files and preserves remote files for inspection. Keep its reports under ignored
`target` output and keep credentials out of Git. The CLI runner never uses the
person's default Workspace. `google-drive-sync.ps1` in the same directory checks
the Workspace sync adapter with a saved connection alone; see `tests/live/README.md`.
It covers storage only: folder discovery, listing, download, update at a current
and a stale version, Drive revisions and chunked transfer. It does not exercise
merging, conflict review or the desktop, and it leaves its folder in Drive.

The deterministic suite runs on a controlled transport, and that script starts
from a saved connection, so neither sends a sign-in through the app. The live
sync check is therefore complete only when it includes **one real sign-in
through the desktop app** (Settings, Connect Google Drive, system-browser
consent, back to the app) on a build with the publisher's OAuth client, and
records the result with the binary hash and source revision. The deterministic
suite runs every request shape through the production transport's allow-list,
but only Google can confirm what it answers. The live check must confirm:

- sign-in and Reconnect succeed, the account's email is shown, and the granted
  scope is `drive.file` alone;
- the Workspace folder and its subfolders are created once, are visible in
  Drive, and are found again by a second desktop signed in to the same account
  (`appProperties` queries under `drive.file`);
- a file created with a pre-generated ID is not duplicated by a repeated
  creation (409), and `headRevisionId` changes with every content update;
- a past revision is listed and downloads by its ID, including a ranged
  download of more than one chunk, and Drive keeps the revision the version
  history relies on;
- an update at a stale version is refused by the adapter's check, and a file
  moved to Drive's trash is reported as missing, written again as another file,
  and seen as another file when the first one is restored;
- a throttled request (403 or 429 with `Retry-After`) is retried and then
  succeeds, and a full Drive reports as storage full;
- whether `changes.list` reports this app's files under `drive.file` (the
  adapter lists the folder instead until this is confirmed).

Mark each item passed, failed, blocked or not run; an item nobody ran is not a
pass.

Sync behaviour that does not need Drive is tested in the core against temporary
Workspaces: the file converter (`sync_files`), change capture (`sync_capture`),
merge rules (`sync_merge`), version history (`versions`) and device codes
(`device_references`). These run in `./scripts/check`, not in `check-drive`.

Use an isolated development Workspace for native checks where available. When
verifying the person's running app, limit writes to dedicated synthetic QA
records and restore temporary aliases, clipboard and display preferences. Keep
other authored content intact; never restore that Workspace to simulate a fault.

Live assertions include upload/download byte hashes, chunk boundaries, request
replay across processes, destination preservation and non-overwriting exports.
Fault injection, revocation and destructive lifecycle checks belong in isolated
fixtures; do not disrupt a person's real Google grant to manufacture a failure.

Desktop acceptance additionally checks system-browser consent and folder/file
selection, actual file and Save dialogs, upload progress/cancel/retry, persistence
across restart, editor insertion order and valid saved Markdown, and recovery
after backup restoration. Inspect changed screens in light, dark and compact
layouts, with keyboard focus and long filenames. An installed build and a QA host
are distinct forms of evidence; record which one ran.

For browser automation, follow the machine's browser-profile instructions before
launching a browser. On managed Windows machines, a new unseeded Chromium profile
can cause account lockouts. Do not bypass those instructions for test isolation.

## Hardening gate

Track the acceptance matrix, findings and execution evidence in GitHub Issues.
For each confirmed bug: reproduce it, add a regression that fails first, apply
the fix, then rerun the original scenario and affected suites. Rerun live tests
against the rebuilt artifacts after code changes; record the binary hash and
source revision alongside the results.

Release clearance requires green deterministic and feasible live/native checks,
no unresolved accepted requirement defects, and explicit results for the target
platforms. Mark unavailable account, native-input and platform checks as blocked
or not run. Passing Windows checks do not establish Linux/macOS secure-store or
OAuth behavior, and a clean run does not prove the absence of undiscovered bugs.
