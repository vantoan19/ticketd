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

The suite uploads synthetic inputs of 0, 1, 262143, 262144, 262145, and 524411 bytes, plus two Unicode filenames with the same basename from separate directories. It checks request replay, status reconciliation, conflicting request choices, explicit local upload behavior, search, normal Markdown export hashes, single-file multichunk export SHA-256 and size, export no-clobber behavior, and safe removal/reselection. Conflict assertions require the specific request-conflict error and unchanged identity; no-clobber requires the specific destination-exists error and unchanged sentinel bytes. Destination matching includes the supplied resource key, and retry/search projections must report `uploaded_copy=true`. No OAuth tokens, browser URLs, file contents, or raw provider responses are written to the report.

The machine-readable report and round artifacts are placed in a uniquely named directory under `target/live-verification`. Exit code 0 means all required cases ran and passed; 1 means a product assertion or runner case failed; 2 means execution was blocked or a required case was skipped. An upload that remains pending or uncertain is reconciled with its existing request ID and stops further uploads in that round; the runner never creates a replacement request to guess whether the first upload succeeded.
