# ticketd

A local ticket workspace with a desktop UI for people and a CLI for agents.
Keep work, decisions, and supporting context together, and let both interfaces
operate on the same workspace.

- Organize tickets with projects, Plans, dependencies, tags, and linked Documents.
- Record progress as Activities and retrieve focused context through the CLI.
- Use local attachments, with optional Google Drive integration.
- Connect GitHub issue sources and review content before publishing to them.
- Back up your workspace and export portable Markdown with files.

ticketd is in early development. Data formats and CLI behavior may change.
Public signed releases are not available yet; source builds are the current
starting point. The distribution targets are macOS Apple Silicon, Ubuntu 24.04
x86-64, and Windows 11 x86-64. WSL interoperability is not validated.

## Get started

Follow [development setup](docs/development.md) to install prerequisites and set
a disposable workspace, then run:

```sh
npm ci
npm run desktop -- dev
```

In another terminal with the same disposable-workspace environment, try the CLI:

```sh
cargo run -p ticketd-cli -- create "Try ticketd"
cargo run -p ticketd-cli -- list
```

Use the reference returned by `create` to inspect or update that ticket, for example
`cargo run -p ticketd-cli -- show T-KQ1` if its reference is `T-KQ1`. Changes appear in
the desktop workspace too. No agent subscription or Google account is needed
for local ticket workflows.

For packaged-build instructions, PATH setup, and Google Drive configuration, see
[installation](docs/install.md). Keep desktop and CLI versions matched and back up
data before upgrading.

## Use ticketd with an agent

Run `ticketd skills get` for the bundled operating guide and `ticketd skills list`
for focused topic guides. Install the discovery skill for Claude Code or Codex
from Settings → Agent skills, or run:

```sh
ticketd skills install --harness claude-code,codex
```

The guide teaches CLI operations while leaving work organization to you. See
[agent skill installation](docs/install.md#agent-cli-skill) and
[CLI workflows](docs/cli.md) for project context, atomic batches, search, and progress reports.

## Contribute

ticketd is licensed under the [MIT License](LICENSE). Third-party components
retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

Bug reports, docs, accessibility feedback, platform testing, and code improvements
are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for contribution paths
and the review process. You do not need an AI assistant or private skills.

- [Report a bug or suggest a feature](https://github.com/vantoan19/ticketd/issues/new/choose).
- [Set up a development environment](docs/development.md).
- Read the [code of conduct](CODE_OF_CONDUCT.md) and [security reporting policy](SECURITY.md).

## Documentation

| Guide                                         | Purpose                                                      |
| --------------------------------------------- | ------------------------------------------------------------ |
| [Installation](docs/install.md)               | Packages, CLI discovery, upgrades, and optional integrations |
| [CLI workflows](docs/cli.md)                  | Examples for agents and terminal users                       |
| [Privacy](PRIVACY.md)                         | Local storage, credentials, and external services            |
| [Export format](docs/export.md)               | Portable content and backup boundaries                       |
| [Architecture](docs/architecture.md)          | Shared core, desktop, and CLI responsibilities               |
| [Domain glossary](GLOSSARY.md)                | Canonical product terminology                                |
| [Product specification](docs/mvp-spec.md)     | Product direction, including planned behavior                |
| [Release guide](docs/releasing.md)            | Maintainer build and publication procedure                   |
| [Third-party notices](THIRD_PARTY_NOTICES.md) | Bundled assets and dependency attribution                    |

Work tracking lives in [GitHub Issues](https://github.com/vantoan19/ticketd/issues).
The product specification includes future direction and is not a list of shipped features.

## Repository layout

```text
apps/desktop/src/            React UI and typed desktop bridge clients
apps/desktop/src-tauri/      Tauri adapter, configuration, and capabilities
crates/ticketd-core/         Shared domain behavior and persistence
crates/ticketd-cli/          Standalone CLI named ticketd
scripts/                    Shared development checks
docs/                       Product and engineering guidance
```
