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

Build the frontend before workspace-wide Cargo builds or checks: Tauri embeds
`apps/desktop/dist` at compile time. `npm run desktop -- dev` manages its own
frontend development server.

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

A new Workspace normally takes a random two-letter device code for its Ticket
references. Everything Cargo runs in this repository (`cargo test`, `cargo run`,
`npm run desktop -- dev`) gets `TICKETD_TEST_DEVICE_CODE=KQ` from
`.cargo/config.toml`, so tests can assert references such as `T-KQ1`. Installed
builds do not have it. To try two devices from source, set the variable to a
different code before creating the second Workspace.

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

## Optional integrations

Core local workflows and ordinary tests do not require GitHub or Google credentials.
Do not set `TICKETD_GOOGLE_OAUTH_CLIENT_JSON` for a basic source build; Drive stays
disabled without a registration. Local attachments remain available.

For integration work, see [Google configuration](install.md#publisher-and-developer-configuration),
[Drive verification](testing-google-drive.md), and the opt-in
[live runner](../tests/live/README.md). Live verification contacts real services
and can create remote files. Use a dedicated test account and destination.

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
