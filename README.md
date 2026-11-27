# ticketd

ticketd is a local ticket workspace for people and their coding agents. Create a
ticket in the desktop app, ask an agent to post an update through the CLI, and
read it on the same ticket. Both interfaces work on the same computer, even
offline. Projects, Plans, linked Documents, and dependencies keep the context
with the work. Connect GitHub Issues, Linear, or another ticket source extension to
track issues from an external tracker. Sync your workspace across desktops
through your own Google Drive.

## Get started

[Try the interactive demo and browse the documentation](https://ticketd.dev/).

[Download the latest unsigned preview](https://github.com/vantoan19/ticketd/releases/latest).
Desktop installers include the matching CLI for macOS 26 on Apple Silicon,
Ubuntu 24.04 x86-64, and Windows 11 x86-64. macOS and Windows may warn on first
launch. Follow the [installation instructions for your platform](docs/install.md#availability).

| I want to…                     | Start here                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Use the desktop app            | [Create your first ticket and post an update](docs/first-ticket.md). Local tickets work without an account.                                                        |
| Use ticketd with an agent      | [Connect your agent to a ticket](docs/first-ticket.md#ask-an-agent-to-post-an-update) or [try the CLI workflow](docs/cli.md#create-a-ticket-and-verify-an-update). |
| Build or contribute to ticketd | [Set up a development checkout](docs/development.md) and [find the code and checks for your change](CONTRIBUTING.md#where-to-start).                               |

## Use ticketd with an agent

Make the [command-line tool](docs/install.md#command-line-tool) available in your
agent's terminal. In **Settings › Agent skills**, install the discovery skill for
Claude Code or Codex. You can also install it from the terminal.

```sh
ticketd skills install --harness claude-code,codex
```

`ticketd skills get` prints the operating guide bundled with your executable.
`ticketd skills list` lists the available topics, including safe writes, project
context, and working in a ticketd Chat. Other harnesses can read the guides
directly. [Agent skill installation](docs/install.md#agent-cli-skill)

## Documentation

| To…                                             | Read                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Keep a copy you can restore                     | [Back up and restore your workspace](docs/workspace-tasks.md#back-up-and-restore-your-workspace)   |
| Send someone a ticket and its files             | [Share a ticket as Markdown](docs/workspace-tasks.md#share-a-ticket-as-markdown)                   |
| Use the same workspace on a second computer     | [Sync two desktops with Google Drive](docs/workspace-tasks.md#sync-two-desktops-with-google-drive) |
| Find tickets, post updates, or automate edits   | [CLI workflows](docs/cli.md)                                                                       |
| Understand where your data goes                 | [Privacy and local data](PRIVACY.md)                                                               |
| Understand ticketd's behavior and terminology   | [Product description](docs/product.md) and [domain glossary](GLOSSARY.md)                          |
| Explore the implementation or publish a release | [Architecture](docs/architecture.md) and [release guide](docs/releasing.md)                        |

## Contribute

Bug reports, documentation, accessibility feedback, platform testing, and code
changes are welcome. [Contribution guide](CONTRIBUTING.md) · [GitHub Issues](https://github.com/vantoan19/ticketd/issues) · [Security reporting](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md)

ticketd uses the [MIT License](LICENSE). Bundled components retain their own
licenses. [Third-party notices](THIRD_PARTY_NOTICES.md)

## Repository layout

The [component map](docs/architecture.md#module-responsibilities) links each desktop, CLI, and core module to its source.
