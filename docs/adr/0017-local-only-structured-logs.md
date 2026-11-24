# Local-only structured logs

## Decision

Rust code logs through `tracing` and nothing else. The library crates
(`ticketd-core`, `ticketd-chat-host`, `ticketd-automation-runner`) emit events and
spans and never install a subscriber. Only the two binaries do, through the
`ticketd-diagnostics` crate, which has no Tauri dependency.

- **Desktop.** `init_desktop(log_dir)` installs a subscriber that writes JSON lines
  to `ticketd.YYYY-MM-DD.log` (UTC days) in the app's log folder (on macOS
  `~/Library/Logs/<bundle identifier>/`). It returns a desktop logs handle that the
  desktop keeps in managed state and drops on `RunEvent::Exit`. The handle
  changes the level at runtime (Debug logging), lists recent errors, keeps the
  crash-session marker and writes the diagnostics export. Dev builds also print
  readable lines to stderr. If the folder cannot be used, logging falls back to
  stderr and the app keeps running.
- **CLI.** `init_cli()` installs readable lines on stderr, at `warn` by default.
  `TICKETD_LOG` takes any `tracing` filter. The CLI writes its own diagnostics to
  stderr and keeps stdout dedicated to command results.
- **Filter.** The desktop default is `warn,ticketd=info`: our crates at `info`,
  everything else (HTTP clients, which could log URLs carrying Drive file IDs or
  OAuth codes) at `warn`. `ticketd` matches targets by prefix, so it covers every
  `ticketd_*` crate. `TICKETD_LOG` overrides the default for the desktop too, and
  then wins over the Debug logging switch. A `TICKETD_LOG` that is not a valid filter is
  ignored, not treated as an override: the default applies, the switch works, and one
  `warn` ("TICKETD_LOG ignored", with the value's length and never the value) says so.
- **File sink.** One file per day. Each line is written synchronously to the file
  under a mutex, with no buffer and no background worker, so nothing is lost on
  `std::process::exit` (which is how Tauri ends the process) or a panic. At startup
  our own code deletes ticketd's log files older than 7 days by modified time, then
  the oldest until the folder is under 50 MB. A day's file stops taking routine
  lines at 20 MB: it writes one notice (once per day file, so not again after a
  restart), then only `warn` and `error`. A failed write is dropped.
- **Desktop command spans.** Each Tauri command handler runs in a `debug` span named
  for the command, with the `request_id` when the interface sent one. Tauri runs an
  `async` command's future outside the handler, where we cannot reach it, so for those
  the span covers only the start: its close time is not the command's duration and
  later lines from the future do not carry it. Work whose duration matters opens its
  own span. We did not wrap or fork Tauri's command macros for this.
- **Event standard.** A short message without values, fixed snake_case field names,
  typed IDs, `error_kind` and `error`, and never user content. It is written in the
  Logging section of `docs/agents/quality.md`.
- **Local only.** Logs never leave the machine. Sharing them is a user action: the
  Diagnostics export (a redacted `.zip`, built from an allowlist of fields) is the
  safe way to attach them to a GitHub issue.
- **Source extension stderr.** The CLI and desktop keep stderr in two local
  files of up to 256 KiB per connection. The source host redacts known secret
  values before writing bytes. Because extensions can still print private
  content, the Diagnostics export includes only a line count for each recent
  file under `logs/sources/`.
- **Recent errors and the export read the files.** `recent_errors()` groups the
  warnings and errors of the last 7 days of files (by the date in the file name) by
  target and error kind, so it covers earlier runs and any line written by other code
  without registering it. The one exception is the previous session's unclean end,
  which the handle adds from its own state, so it is listed under any log filter and
  counted once when its line is also in the file. The export's `errors.json` is the
  same list; its `logs/` holds the last 3 days. The export keeps only allowlisted
  fields of each line (never the `error` text, which can quote a path, a Harness or a
  person), and the list is `ID_FIELDS` and `SAFE_FIELDS` in `ticketd-diagnostics`. A
  field that should reach a bug report is added there on purpose, and to the export
  fixture test.
- **Allowlist beyond the five IDs and `error_kind`.** Each is a field our own code
  emits, with a value that cannot hold content: `location` and `thread` (a panic's
  source position and thread name), `panic_message` (only a `&'static str` payload; a
  formatted message is never logged), `previous_started_at` (a timestamp), `route`,
  `repeat_count` and `frames` (an uncaught WebView error's view, count and frames
  reduced to `basename:line:column`, so no URL, query string or function name),
  `harness` (the Harness key; its stderr `line` is not allowed), `command` (a Tauri
  command's name), `bytes` (the export's size), `action` (which background Chat action
  failed), `version` (the app version at start), and the span timings `time.busy` and
  `time.idle`. The summary's commit comes from `build.rs`, which stamps the short hash
  of `HEAD` (or `TICKETD_COMMIT`) at build time; a build outside a checkout says
  `unknown`.

## Rejected

- **Remote telemetry, Sentry or any automatic crash upload.** PRIVACY.md promises
  none, and a log can hold paths and identifiers. The maintainer and agents debug on
  their own machine; a user who reports a problem chooses what to attach.
- **`tauri-plugin-log`.** It sends `log` and `tracing` records to separate files,
  keeps only 40 KB of history by default (`KeepOne`), and its console forwarding
  sends Rust logs to the browser rather than the other way round. It also ties
  logging setup to Tauri, which the CLI and the tests cannot use.
- **`tracing-appender` for pruning.** Its `max_log_files` prunes only when the day
  changes inside a running process, and sorts by creation time. A desktop quit every
  evening would never prune. GitButler's code notes the same.
- **A non-blocking writer.** Its background worker loses the last lines on
  `process::exit` and on a panic, which are the lines that matter most. A log line is
  a small write to a local file; the cost of writing it in place is lower than the
  cost of losing it.
- **Minidumps and a crash-handler process.** The panic hook plus an
  unclean-session marker records that something went wrong and where for Rust
  panics, and that a session ended unexpectedly for everything else, without a
  second process or a symbol pipeline.

## Why

The desktop had about 25 bare `eprintln!` lines with no level, timestamp or fields,
and when it is launched from Finder or the Dock its stderr goes nowhere. A sync that
stopped overnight left no trace. The research behind the choices: Zed writes a
synchronous 1 MB log and redacts panic messages; GitButler prunes at startup and
zips logs for reports; Wezterm writes a file per process and prunes only from the
GUI; Signal's regex scrub leaked attachment URLs until a pattern was added, while
Firefox's about:support builds its report from an allowlist, which is what the
export does.

## Consequences

- Every new diagnostic is a `tracing` event that follows the event standard.
  `eprintln!` in production code is reserved for the CLI's user-facing output.
- A new dependency that logs at `warn` or above can write to the log. Review what
  it logs before adding it.
- Day boundaries in file names are UTC, matching the timestamps in the lines.
- Because the desktop's log folder is chosen from the app's identifier, development
  and release builds that share an identifier share a folder.
