# Contributing to ticketd

Help make local ticket management useful for people and their coding agents.
Bug reports, documentation, accessibility feedback, platform testing, and code
changes are welcome. You do not need an AI assistant or any private tools to contribute.

## Where to start

| Contribution                        | Start here                                            | Useful evidence                            |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| Improve setup or explain a workflow | `README.md`, `docs/install.md`, `docs/development.md` | Commands you tried and the confusing step  |
| Fix CLI behavior                    | `crates/ticketd-cli/`                                 | Reproduction command and expected output   |
| Fix domain or storage behavior      | `crates/ticketd-core/`                                | A focused test with a temporary workspace  |
| Improve desktop UI or accessibility | `apps/desktop/src/features/`                          | Before/after screenshots or keyboard steps |
| Test a platform                     | `docs/install.md`                                     | OS, app version, and observed results      |

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

## Review and decisions

Maintainers decide product direction and merge changes after review. Review may
request a smaller scope, additional evidence, or a different approach. Agreeing
on a problem does not guarantee acceptance of a particular implementation.
There is no guaranteed review turnaround; a concise follow-up on the same PR is welcome.

Version bumps, tags, and releases are maintainer-managed. Leave them out of ordinary
contributions. See [the release guide](docs/releasing.md) for distribution requirements.
