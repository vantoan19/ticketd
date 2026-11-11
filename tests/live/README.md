# Google Drive live verification

`google-drive.ps1` is an opt-in integration runner for the Google Drive upload and export paths. It writes only synthetic files to the explicitly supplied Drive folder. Remote test files are intentionally preserved for inspection; the runner never trashes, deletes, shares, or overwrites a Drive file. Each round uses a fresh SQLite workspace under the ignored `target/live-verification` directory and restores the caller's process environment on exit. It never opens the user's normal ticketd workspace.

Run it from the repository with the saved connection and test folder you intend to use:

```powershell
& '.\tests\live\google-drive.ps1' `
  -CliPath 'C:\Projects\ticketd\target\release\ticketd.exe' `
  -ConnectionId '<explicit saved connection ID>' `
  -FolderId '<explicit writable Drive folder ID>'
```

Add `-ResourceKey` only when the selected folder requires one. `-Rounds` accepts 1–3 and defaults to 1; each round can create up to eight preserved remote files, for a maximum of 24 per invocation. Use additional rounds only when fresh files are wanted. Add `-RequireUploadedCopyClassification` for final artifacts expected to include the `uploaded_copy` field; without it, an older CLI lacking that field records the classification assertion as blocked while still reporting a confirmed upload accurately. The runner validates the explicitly supplied destination before upload and does not infer an account or folder. It temporarily clears `TICKETD_GOOGLE_OAUTH_CLIENT_FILE` and `TICKETD_GOOGLE_OAUTH_CLIENT_JSON` for every ticketd process so a live run exercises the build's bundled registration and the saved OS credential.

For release verification, add `-ExpectedCliSha256 '<64-character release CLI SHA-256>'`. The optional value is checked against `CliPath` before the runner creates run artifacts, probes or changes a Workspace, or contacts Drive. The report records expected, initial, and final hashes, and the run fails if the executable changes while the suite is running.

The suite uploads synthetic inputs of 0, 1, 262143, 262144, 262145, and 524411 bytes, plus two Unicode filenames with the same basename from separate directories. It checks request replay, status reconciliation, conflicting request choices, explicit local upload behavior, search, normal Markdown export hashes, single-file multichunk export SHA-256 and size, export no-clobber behavior, and safe removal/reselection. Conflict assertions require the specific request-conflict error and unchanged identity; no-clobber requires the specific destination-exists error and unchanged sentinel bytes. Destination matching includes the supplied resource key, and retry/search projections must report `uploaded_copy=true`. No OAuth tokens, browser URLs, file contents, or raw provider responses are written to the report.

The machine-readable report and round artifacts are placed in a uniquely named directory under `target/live-verification`. Exit code 0 means all required cases ran and passed; 1 means a product assertion or runner case failed; 2 means execution was blocked or a required case was skipped. An upload that remains pending or uncertain is reconciled with its existing request ID and stops further uploads in that round; the runner never creates a replacement request to guess whether the first upload succeeded.

## Workspace sync storage

`google-drive-sync.ps1` checks the Workspace sync Drive adapter against real Google Drive. It takes only `-ConnectionId` (a saved connection in this OS user's secure store) and runs the ignored `drive_remote_live` test of `ticketd-core`. Two adapter handles stand for two devices sharing one account. The run creates one new folder named `ticketd live sync check <id>` in My Drive with an `attachments` subfolder, a Markdown file written twice and one 600 kB binary file. It checks folder discovery, repeated creation, listing, download, update at the synced and at a stale version, Drive revisions and chunked transfer. It also prints whether `changes.list` answers under `drive.file`; that line is an observation, not an assertion. Nothing is trashed, deleted or shared, and the folder stays in Drive for inspection.

The report is written to `target/live-verification/sync-<run>/report.txt` with the source revision. Exit code 0 means every step passed; 1 means a step failed or the run was blocked. The run does not exercise the sync engine, conflict merging or the desktop.
