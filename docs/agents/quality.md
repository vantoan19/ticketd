# Engineering quality

## Design and implementation

- Keep core rules behind the workflow interface in `docs/architecture.md`; desktop and CLI translate requests and results.
- Keep implementation details private. Introduce abstractions for demonstrated variation, not hypothetical extensions.
- Use glossary terms, explicit names, and comments explaining non-obvious reasons.
- Validate external input at entry points and enforce domain invariants in the core. Return actionable errors; preserve their underlying cause.

## Rust

- Format with rustfmt and run Clippy with warnings denied. Forbid unsafe code in application crates; do not enable every pedantic lint by default.
- Return `Result` for expected failures. Avoid `unwrap`, `expect`, and explicit panics in production paths; tests may use them for clear setup and assertions.
- Use exhaustive matches for domain enums. Prefer owned values and borrowing that keep lifetimes simple; introduce shared mutable state only when required.
- Keep SQL and Tauri out of domain calculations. Use parameterized SQL and short transactions; test persistence through the core interface.
- When scaffolding Rust, pin the toolchain in `rust-toolchain.toml`, commit `Cargo.lock`, and inherit workspace lint settings in every member. Scope any lint exception narrowly and explain it.

## Logging

Log with `tracing`, and only `tracing`; never `eprintln!` or `println!` for diagnostics. Library crates emit events and spans and never install a subscriber. The two binaries do, through `ticketd-diagnostics` (`init_cli`, `init_desktop`). The CLI's own `error: …` line and prompts are output for the person or agent that ran it, not logs. The reasons are in [ADR 0017](../adr/0017-local-only-structured-logs.md).

Where the logs are: the desktop writes JSON lines to `ticketd.YYYY-MM-DD.log` (UTC) in the app's log folder (on macOS `~/Library/Logs/com.vantoan19.ticketd/`); read them with `jq`. The CLI writes readable lines to stderr at `warn`. `TICKETD_LOG` takes any `tracing` filter (`TICKETD_LOG=debug`, `TICKETD_LOG=warn,ticketd_core=debug`) for both and overrides the desktop's Debug logging switch.

The event standard:

- The message is a short lowercase phrase with no values in it: `"sync pass failed"`. Put values in fields. Start a message with a capital only for a proper term from the glossary.
- Field names are snake_case. The fixed ID fields are `ticket_ref`, `chat_id`, `automation_run_id`, `source_id` and `request_id`; use them as they are rather than inventing `ticket` or `runId`.
- An error logs `error_kind` (a stable variant name, such as `ticketd_core::Error::kind().code()`) and `error` (its `Display` text, as `%error`). `error_kind` is required when the error has a stable variant; it may be left out for an opaque `io` or Tauri error that has none. Never log an error's `Debug` output. Paths go through `ticketd_diagnostics::display_path`, which rewrites the home folder to `~`.
- Allowed: IDs, counts, durations, error kinds, state names. Never: Ticket, Document, Plan or Chat text, titles, tokens, authorization URLs or query strings, email addresses. When an error's text can carry a Harness's or a person's words, log its kind and IDs and leave the text out.
- Levels: `error` is for work the user lost or work that stopped. `warn` is degraded but recovered, such as a pass that failed and will be tried again. `info` is lifecycle and background passes. `debug` is detail. A failure that repeats on a timer logs when it changes or comes back, not on every attempt.
- The target is the module path, which `tracing` sets by default. The default desktop filter is `warn,ticketd=info`, so a target must start with `ticketd` to be logged at `info`; dependencies log at `warn`.
- Wrap work that has an ID in a span that carries it, so every line inside is correlated and the span's close records its duration. A line in the file has `timestamp` (RFC 3339, UTC), `level`, `target`, `message`, the event's fields and `spans` (the chain, outermost first). A closed span logs `message: "close"` with `time.busy` and `time.idle`.
- Open a span for work, never for an idle tick: a loop that wakes every few seconds opens its span only after it finds something to do, because every span close is a line. Desktop command spans are at `debug` for the same reason (the change poll is a command), carry the `request_id` when the interface sent one, and cover only the synchronous start of an `async` command, so their close time is not that command's duration. A span that outlives the work that started it (an Automation run, a Chat) is a root span (`parent: None`), so it does not hold its starter open. The CLI's root span carries `chat_id` and `automation_run_id` from `TICKETD_CHAT_ID` and `TICKETD_AUTOMATION_RUN_ID` when set and not blank.
- Two sources are forwarded rather than written by our code. Uncaught WebView errors arrive through one Tauri command (`report_webview_error`, from `apps/desktop/src/lib/error-report.ts`) as `error` events on the `ticketd::webview` target, with the error's name as `error_kind`, the `route`, a `repeat_count` and `frames` reduced to `file:line:column`; the error's message is never sent, because it can quote a Ticket or a Harness. The page drops repeats and sends at most ten a minute, and there is no frontend logger beyond it. Each line of a Harness's stderr is a `debug` event on `ticketd_chat_host::harness_stderr`, inside the span that was current when the Harness started, with its raw `line` (so never above `debug`).
- A library crate that logs depends on `tracing` alone. Test what reaches the log folder or stderr through `ticketd-diagnostics` or the CLI process, not by mocking `tracing`.

## TypeScript, React, and desktop

- Enable TypeScript `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Validate data crossing process boundaries; type assertions do not validate input.
- Use ESLint with TypeScript and React Hooks rules; use Prettier for frontend formatting. Avoid `any` and blanket lint suppressions.
- Keep domain decisions in Rust. React owns view state and drafts; avoid duplicating derived state or using effects for ordinary calculations.
- Use semantic HTML and accessible Radix components with labels, keyboard support, and visible focus. Verify the affected interaction manually when UI behavior changes.
- Grant Tauri only the capabilities used by the application. Send structured arguments across the bridge rather than shell command strings.
- When scaffolding the frontend, pin Node and the package manager, commit its lockfile, and provide `format:check`, `lint`, `typecheck`, and `test` scripts. Tests must run once, not watch indefinitely.

## Small tests first

- Start with the smallest test that proves the changed behavior. Skip tests for trivial prose or styling changes when a direct check is sufficient.
- For pure logic, use a small unit test. For persistence or transactions, use a focused core-interface test with a temporary SQLite database.
- For a bug, add one regression test reproducing it. Add cases only for distinct behavior, a meaningful edge case, or a demonstrated failure.
- Avoid duplicate coverage across layers, tests mirroring implementation, large fixtures, and snapshots of entire UI trees. Use a narrow CLI-output snapshot only when output itself is the contract.
- Add integration or end-to-end tests when a smaller test cannot protect the behavior. Concurrency, atomic batches, migrations, and retry deduplication warrant focused integration coverage.
- No coverage-percentage target or test-count quota. Prefer deterministic setup, isolated data, and explicit assertions over sleeps and extensive mocks.
- Run affected tests during development, then `./scripts/check` before handoff. Report unavailable checks honestly.

## Checks and review

`./scripts/check` checks Markdown, whitespace, Rust formatting/Clippy/tests, and frontend formatting/lint/types/tests. Install dependencies with `npm ci`, build the frontend with `npm run build`, and use the pinned Rust toolchain before running it. See [development setup](../development.md) for platform prerequisites and a disposable workspace.

CI runs the same check command on fresh GitHub-hosted runners for every pull request and every `main` commit. `./scripts/check fast` (Markdown, versions, whitespace, formatting, lint and types) runs as its own job, with workflow linting, so those failures report in minutes. On Ubuntu, `./scripts/check rust` (Clippy and the Rust tests, then the frontend, desktop, and CLI build) and `./scripts/check ui` (the frontend tests) run as two jobs side by side. macOS and Windows run `cargo test` and build the desktop and CLI. The `CI result` job fails unless every one of those jobs succeeded; it is the one required check. All jobs use pinned toolchains and committed lockfiles.

Keep self-hosted runners disconnected from this repository: a contribution can change its workflow's runner selection. PR checks use read-only permissions and no distribution credentials. Credential-bearing distribution builds run only by manual dispatch on `main`. Before changing repository visibility or CI permissions, follow the [repository CI settings](../releasing.md#repository-ci-settings).

Review should assess interface simplicity, domain correctness, error paths, and whether tests protect observable behavior. CI checks mechanics; it does not replace design review. Use dependency updates scoped to the intended change and pin CI actions to commit SHAs.

GitHub Issues holds work tracking. Repository documentation holds durable guidance. Keep `main` green: when a `main` run fails, fix or revert it before other work. Each run's summary lists how long every job queued and ran. The weekly Delivery report workflow (`node scripts/delivery-report.mjs`, also runnable locally with `gh`) summarizes the last 30 days: merge frequency, lead time from first commit to merge and to green `main`, the share of `main` runs that failed, and how long `main` stayed red. Until releases exist, merges stand in for deployments.
