# Contributing to ticketd

Help make local ticket management useful for people and their coding agents.
Bug reports, documentation, accessibility feedback, platform testing, and code
changes are welcome. You do not need an AI assistant or any private tools to contribute.

## Where to start

| If you're changing…                   | Start here                                                                                                                                  | First focused check                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Setup or a walkthrough                | [Install](docs/install.md), [first ticket](docs/first-ticket.md), and [development setup](docs/development.md)                              | Follow the published steps in a fresh workspace. Record the platform, version, and observed result.                                                                      |
| CLI commands or JSON output           | [CLI adapter](crates/ticketd-cli/src/) and [CLI integration tests](crates/ticketd-cli/tests/)                                               | For JSON output, run `cargo test -p ticketd-cli --test json_output`.                                                                                                     |
| Agent operating guides                | [Bundled Markdown](crates/ticketd-cli/skill-data/) and [discovery skill](skills/ticketd/SKILL.md)                                           | Run `cargo test -p ticketd-cli --test skills_command` and try changed examples in a disposable workspace.                                                                |
| Domain behavior or persistence        | [Shared Rust core](crates/ticketd-core/src/), [integration tests](crates/ticketd-core/tests/), and [architectural decisions](docs/adr/)     | Run the test for the affected behavior. For backup review, use `cargo test -p ticketd-core --test backup_review`.                                                        |
| Desktop interactions or accessibility | [Feature components](apps/desktop/src/features/), [Tauri adapter](apps/desktop/src-tauri/src/), and [interface guidance](docs/agents/ui.md) | Run the adjacent component test. For posting updates, use `npm test -w @ticketd/desktop -- src/features/tickets/Activity.test.tsx`, then try the interaction in the app. |

For the full component map, see [architecture and module responsibilities](docs/architecture.md#source-layout).

Search [existing issues](https://github.com/vantoan19/ticketd/issues) before
reporting a problem. Small fixes and documentation improvements can go straight
to a pull request. Discuss substantial features, new dependencies, migrations,
and architectural changes in an issue first so we can agree on the problem and scope.
For usage questions, open an issue with the `question` label.

Report vulnerabilities through [the security policy](SECURITY.md), not a public
issue. Follow our [code of conduct](CODE_OF_CONDUCT.md) in project spaces.

## Set up and make a change

1. Fork the repository and clone your fork. Create a descriptive branch such as
   `fix/cli-error-message` or `docs/windows-setup`.
2. Follow [development setup](docs/development.md), including a disposable workspace.
3. Read the [engineering guidelines](docs/agents/quality.md). For domain changes,
   consult [domain documentation](docs/agents/domain.md); for UI changes, consult
   [interface guidance](docs/agents/ui.md).
4. Solve one underlying problem per PR. Include the code, tests, and documentation
   needed for that problem across the affected components.
5. Run focused checks while working, then `npm run build` and `./scripts/check`
   before handoff. Explain unavailable checks and their reason in the PR.

Keep credentials, personal workspaces, and private ticket content out of commits,
screenshots, and issue reports. Use synthetic examples.

## Submit a pull request

Target `main` and use the PR template. Explain the problem, the resulting behavior,
and what you actually verified. Link a related issue when one exists. Include
before/after images for visible changes and a short recording when timing or
interaction matters; attach these to the PR rather than committing review-only media.

For bug fixes, add a regression test when it can meaningfully reproduce the failure.
For data changes, explain compatibility, migration, and recovery implications.
Name the platforms tested; a Linux result alone does not establish Windows or macOS behavior.

AI-assisted contributions are welcome. The author remains responsible for understanding,
reviewing, and testing the submitted work and respecting third-party licenses.
Remove credentials and private data before sharing context with an external tool.

Contributions to ticketd are provided under the [MIT License](LICENSE).
Retain applicable third-party copyright and license notices when adapting code
or assets.

## Review and decisions

Maintainers decide product direction and merge changes after review. Review may
request a smaller scope, additional evidence, or a different approach. Agreeing
on a problem does not guarantee acceptance of a particular implementation.
There is no guaranteed review turnaround; a concise follow-up on the same PR is welcome.

CodeRabbit also comments on pull requests, using the settings in `.coderabbit.yaml`.
Its comments are advice: answer or resolve them, but a maintainer's review decides
what merges. Comment `@coderabbitai review` to ask it to review your latest push.

Version bumps, tags, and releases are maintainer-managed. Leave them out of ordinary
contributions. See [the release guide](docs/releasing.md) for distribution requirements.
