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

`./scripts/check` checks Markdown, whitespace, Rust formatting/Clippy/tests, and frontend formatting/lint/types/tests. Install dependencies with `npm ci` and use the pinned Rust toolchain before running it.

CI runs the same check command and builds the frontend, desktop, and CLI on the self-hosted Linux runner for every pull request. macOS and Windows run `cargo test` and build the desktop and CLI on pushes to `main`, nightly, and on pull requests labeled `platform-check`, because hosted macOS and Windows minutes are billed per minute. All jobs use pinned toolchains and committed lockfiles. The initial scaffold has no behavior tests; Vitest permits an empty suite until behavior is implemented.

Review should assess interface simplicity, domain correctness, error paths, and whether tests protect observable behavior. CI checks mechanics; it does not replace design review. Use dependency updates scoped to the intended change and pin CI actions to commit SHAs.

GitHub Issues holds work tracking. Repository documentation holds durable guidance. GitHub currently disallows rulesets on this private repository's plan, so passing CI is a workflow requirement rather than an enforced merge restriction.
