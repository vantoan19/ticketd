# Develop ticketd

The desktop is a Tauri application with a React frontend. The desktop and CLI
share the Rust core. See [architecture](architecture.md) for responsibilities
and [contributing](../CONTRIBUTING.md) for the review workflow.

## Prerequisites

Install Git, Rust through rustup, and Node from [`.nvmrc`](../.nvmrc).
Rustup uses [`rust-toolchain.toml`](../rust-toolchain.toml), including rustfmt and
Clippy. Install the npm version in `package.json` (`npm install --global npm@10.9.2`).
Commit lockfile changes only when deliberately updating dependencies.

Desktop builds need [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/):

- **Windows:** Microsoft C++ Build Tools with the desktop C++ workload, WebView2,
  and the MSVC Rust toolchain. Use native Windows Node and Rust. Run the Bash
  check script from Git Bash, supplied by Git for Windows; PowerShell alone cannot run it.
- **macOS:** Xcode Command Line Tools and the native Rust toolchain.
- **Linux:** WebKitGTK 4.1 and the development libraries listed in Tauri's guide.
  Ubuntu 24.04 is the distribution build target. Google Drive credentials need
  a running Secret Service session when testing that integration.

WSL interoperability is not validated. Do not mix a Windows checkout's build
dependencies with a WSL installation and assume they share paths or credentials.

## First checkout

Clone your fork, enter the checkout, then run:

```sh
npm ci
npm run build
```

Run `npm run build` before workspace-wide Cargo builds or checks. It builds, in
order, the Claude Chat bridge executable and the frontend: Tauri embeds
`apps/desktop/dist` at compile time and copies the bridge beside the desktop
executable as a sidecar, so a Cargo build of the desktop fails while either is
missing. `npm run desktop -- dev` manages its own frontend development server
and uses the bridge that `npm run build` produced; `npm run desktop -- build`
rebuilds both first and stages the CLI from the same Cargo workspace for Tauri
to bundle. Use `npm run desktop -- bundle` to package an existing Tauri build.

Agents hosted in a Chat reach records through the `ticketd` CLI. The app looks
for it on PATH, then beside its own executable, then in the usual install
folders, and gives the agent its absolute path. In development,
`cargo build -p ticketd-cli` puts `target/debug/ticketd` beside the desktop
executable, which is enough.

## Use a disposable workspace

Normal application commands can create or migrate your real workspace. Set an
absolute development database path in each terminal that runs the app or CLI.

PowerShell:

```powershell
New-Item -ItemType Directory -Force target/dev-workspace | Out-Null
$env:TICKETD_TEST_WORKSPACE = Join-Path (Resolve-Path target/dev-workspace).Path 'workspace.sqlite3'
cargo run -p ticketd-cli -- workspace
npm run desktop -- dev
```

Bash on macOS/Linux:

```sh
mkdir -p target/dev-workspace
export TICKETD_TEST_WORKSPACE="$PWD/target/dev-workspace/workspace.sqlite3"
cargo run -p ticketd-cli -- workspace
npm run desktop -- dev
```

For Git Bash on Windows, set the variable with a native Windows path:

```sh
mkdir -p target/dev-workspace
export TICKETD_TEST_WORKSPACE="$(pwd -W)/target/dev-workspace/workspace.sqlite3"
```

Check the `workspace` result before creating data. A second CLI terminal must use
the same variable to share this database. Keep development files under ignored
`target/`, use synthetic content, and avoid configuring real external sources.

The desktop honors this override only in debug builds. Release desktop builds
use the normal application workspace. The override does not isolate OS credential
stores, browser sign-in, or all WebView preferences/drafts; use a separate OS user
for complete isolation and packaged-app testing.

A new Workspace takes a random two-letter device code for its Ticket references,
including under `cargo run` and `npm run desktop -- dev`. Only `cargo test` fixes
the code to `KQ`, so tests can assert references such as `T-KQ1`: the
`ticketd-core` and `ticketd-cli` dev-dependencies turn on the core's
`test-device-code` feature. `cargo test` therefore leaves a `target/debug/ticketd`
with the fixed code; `cargo build` or `cargo run` replaces it with a normal one.

## Run and test

```sh
npm run desktop -- dev                    # Native desktop with live frontend
npm run dev                               # Frontend only; no native Tauri bridge
cargo run -p ticketd-cli -- --help
cargo test -p ticketd-core --test ticket_creation --locked
cargo test -p ticketd-cli --test output --locked
npm test --workspace @ticketd/desktop -- src/features/projects/Projects.test.tsx
```

The frontend-only server is useful for frontend development, but native operations
need the desktop. Automated frontend tests mock the bridge.

Before handoff, run from Bash (Git Bash on Windows):

```sh
npm run build
./scripts/check
```

The check script covers Markdown, whitespace, version consistency, Rust formatting,
Clippy and tests, and frontend formatting, lint, types, and tests. For prose-only
iteration, use `npm exec -- markdownlint-cli2` and Prettier on the changed files;
the complete check remains the handoff check. Report failures accurately.

### Scrub a developer Harness recording

Run the scrubber on a finalized `.wire` file to create a JSONL fixture. New
recordings carry the original launch and physical directory paths, so the
scrubber can mask them even after the file is copied.

```sh
node scripts/scrub-harness-recording.mjs capture.wire fixture.jsonl
```

For a moved v1 recording, supply its original absolute capture directory with
`--capture-root`. Repeat the option if the recording used more than one
spelling of that directory, such as `/tmp` and `/private/tmp` on macOS.

```sh
node scripts/scrub-harness-recording.mjs \
  --capture-root /tmp/synthetic-capture \
  --capture-root /private/tmp/synthetic-capture capture.wire fixture.jsonl
```

## Optional integrations

Core local workflows and ordinary tests do not require GitHub or Google credentials.
Do not set `TICKETD_GOOGLE_OAUTH_CLIENT_JSON` for a basic source build; Drive stays
disabled without a registration. Local attachments remain available.

For integration work, see [Google configuration](releasing.md#configure-google-drive-for-a-build),
[Drive verification](testing-google-drive.md), and the opt-in
[live runner](../tests/live/README.md). Live verification contacts real services
and can create remote files. Use a dedicated test account and destination. The S3
storage tests, including the opt-in run against a local MinIO, are in
[Testing S3 sync storage](testing-s3.md).

Keep local configuration in an ignored `.local/` directory if needed. ticketd
does not automatically load a root `.env` file; set documented variables in the
process environment. Never commit credentials or paste them into a PR.

## Build packages

```sh
cargo build --release --locked -p ticketd-cli
npm run desktop -- build -- --locked
```

These local builds do not require publisher Google secrets when the OAuth build
variable is unset. They are not signed public releases. See
[releasing](releasing.md) for the separate publisher workflow.

### Claude Chat bridge executable

The Claude Chat bridge (`apps/chat-bridge-claude`) is compiled into one
self-contained executable, so users need neither Node nor Bun. Bun is a pinned
development dependency; `npm ci` installs it.

```sh
npm run build:bridge
npm run build:executable --workspace @ticketd/chat-bridge-claude -- bun-darwin-arm64
```

Without an argument the script builds for the current platform. The shipped
targets are `bun-windows-x64`, `bun-darwin-arm64` and `bun-linux-x64`; Bun
cross-compiles each from any host by downloading that target's runtime. Output
goes to `apps/chat-bridge-claude/dist/` under the Tauri sidecar naming
convention, `ticketd-chat-bridge-claude-<Rust target triple>`. Signing, where a
platform needs it, happens on that platform.

The desktop lists the bridge under `bundle.externalBin` in
`apps/desktop/src-tauri/tauri.conf.json`. Tauri picks the file for the Rust
target being built and installs it beside the desktop executable as
`ticketd-chat-bridge-claude`. A desktop build for a target other than the host
needs that target's bridge built first with the matching Bun target.

The executable contains the Agent SDK but no Claude Code: the SDK's optional
per-platform Claude Code packages are not bundled, the bridge always starts the
executable path the host gives it, and the build fails if the output looks like
it contains one. The SDK version is pinned exactly in the bridge's
`package.json`.
