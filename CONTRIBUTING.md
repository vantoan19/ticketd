# Contributing to ticketd

Help make local ticket management useful for people and their coding agents.
Bug reports, documentation, accessibility feedback, platform testing, and code
changes are welcome. You do not need an AI assistant or any private tools to contribute.

- [I want to contribute](#i-want-to-contribute)
- [I’m reviewing a contribution](#review-and-decisions)

## I want to contribute

### Choose a starting point

Search [existing issues](https://github.com/vantoan19/ticketd/issues) first. If someone has already reported the same need, add your example there. Use the [issue chooser](https://github.com/vantoan19/ticketd/issues/new/choose) for new reports and proposals.

GitHub Issues accepts four kinds of public report:

| What brings you here?            | What to do                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Something fails                  | Choose **Bug report**. Give the steps, what you expected, and what happened. Report vulnerabilities privately through the [security policy](SECURITY.md). |
| A new capability                 | Choose **Request an enhancement**. Say who would use it, when, and what they should be able to do.                                                        |
| An unmet need                    | Choose **Share an idea**. Describe what you are trying to do and when the need arises. A solution is optional.                                            |
| Friction in an existing workflow | Choose **Suggest an improvement**. Describe today's steps, the difficulty, and the outcome you want.                                                      |

For usage questions, start with the [user guides](README.md#documentation). Small corrections with a verifiable answer, such as a broken install command, can go straight to PR. Check for an existing claim or PR first. If a change affects product direction, a public contract, dependencies, migrations, or architecture, agree on its outcome and constraints with a maintainer on the relevant bug or proposal before implementing it.

### Write an issue people can understand

Describe **one problem or desired outcome per issue**. Give it a short, specific title. Use plain language someone can understand without knowing the code. Start with who is affected, what happens today, and why it matters. For a bug, include the shortest reproduction. Include technical detail when it helps someone reproduce the problem or judge success.

For example, **“Older dates are cut off in the ticket list”** tells the reader where to look. A useful description is: “Open the ticket list with a ticket from last year. The year is clipped, so I can’t tell when the ticket was updated. I should be able to read the date in the list.”

### Plan implementation in your local ticketd workspace

Keep the public issue focused on the outcome, decisions, and evidence a reviewer needs. Organize implementation steps, investigations, and subtickets in your **own local ticketd workspace**. For the clipped date, checking the formatter, trying a layout, and testing older dates are local tasks under the same public bug. Put the GitHub issue URL in your local ticket for reference. [Getting started with ticketd](docs/first-ticket.md)

Never publish that breakdown as separate GitHub issues, GitHub sub-issues, or a task list pasted into the public description. Contributors can still share a finding or prototype on the original issue when a maintainer invites exploration. Bring back the conclusion or the decision you need. An invitation to explore leaves the implementation decision open. [Triage labels and outcomes](docs/agents/triage-labels.md)

### Find and claim an issue

Browse [ready, unassigned issues](https://github.com/vantoan19/ticketd/issues?q=is%3Aissue%20is%3Aopen%20label%3Aready%20no%3Aassignee). A maintainer marks an issue `ready` when it says what outcome is agreed, how someone can verify it, and which constraints apply. Contributors choose how to implement it within those constraints. For example, an issue about clipped dates should say whether the exact format is prescribed or whether any accessible format that fits will do.

1. **Check the assignee, recent comments, and linked PRs.** An assignee is handling the issue. Coordinate with them before starting overlapping work.
2. **Claim ready work publicly.** On an unassigned `ready` issue, the first clear “I’ll take this” counts immediately. You can begin even if GitHub won’t let you assign yourself. A maintainer assigns the claimant and replies to overlapping claims. The issue stays `ready` while assigned.
3. **Link your PR as soon as you open it.** Post the draft PR link on the issue so the next contributor can see work in progress. On a `needs-decision` issue, say which investigation you are taking on so others know what is still open.
4. **Update the issue if you pause or step away.** After two weeks without visible progress, a maintainer can check in. After another week without a reply, they can unassign the issue and post a release comment linking any useful branch, draft PR, or findings. That ends the previous claim. The first clear claim after the release counts. Respect an agreed return date and exclude time spent waiting for maintainer feedback.

## Where to start

| If you're changing…                   | Start here                                                                                                                                  | First focused check                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Setup or a walkthrough                | [Install](docs/install.md), [first ticket](docs/first-ticket.md), and [development setup](docs/development.md)                              | Follow the published steps in a fresh workspace. Record the platform, version, and observed result.                                                                      |
| CLI commands or JSON output           | [CLI adapter](crates/ticketd-cli/src/) and [CLI integration tests](crates/ticketd-cli/tests/)                                               | For JSON output, run `cargo test -p ticketd-cli --test json_output`.                                                                                                     |
| Agent operating guides                | [Bundled Markdown](crates/ticketd-cli/skill-data/) and [discovery skill](skills/ticketd/SKILL.md)                                           | Run `cargo test -p ticketd-cli --test skills_command` and try changed examples in a disposable workspace.                                                                |
| Domain behavior or persistence        | [Shared Rust core](crates/ticketd-core/src/), [integration tests](crates/ticketd-core/tests/), and [architectural decisions](docs/adr/)     | Run the test for the affected behavior. For backup review, use `cargo test -p ticketd-core --test backup_review`.                                                        |
| Desktop interactions or accessibility | [Feature components](apps/desktop/src/features/), [Tauri adapter](apps/desktop/src-tauri/src/), and [interface guidance](docs/agents/ui.md) | Run the adjacent component test. For posting updates, use `npm test -w @ticketd/desktop -- src/features/tickets/Activity.test.tsx`, then try the interaction in the app. |

For the full component map, see [architecture and module responsibilities](docs/architecture.md#source-layout).

## Set up and make a change

1. Fork the repository, clone your fork, and create a descriptive branch such as `fix/cli-error-message`.
2. Follow [development setup](docs/development.md), including a disposable workspace. Use synthetic data in examples, screenshots, and issue reports.
3. Read the [engineering guidelines](docs/agents/quality.md). The [product description](docs/product.md) and [glossary](GLOSSARY.md) define current behavior and terms. The [architecture guide](docs/architecture.md) and [decision records](docs/adr/) explain module boundaries. For a desktop change, consult the [interface guidance](docs/agents/ui.md) and [design guide](DESIGN.md).
4. Solve one underlying problem per PR. If it requires changing an established behavior or architectural decision, name that decision on the issue, explain the trade-off, and get maintainer agreement. Update the durable documentation alongside the implementation.
5. Start with focused checks, then run `npm run build` and `./scripts/check` before handoff. Report unavailable checks and why.

AI-assisted contributions are welcome. The author owns the work, reviews and tests it, and respects third-party licenses. Keep credentials, personal workspaces, and private content out of commits and external tools. Contributions use the [MIT License](LICENSE). Retain applicable third-party notices and follow the [code of conduct](CODE_OF_CONDUCT.md).

## Submit a pull request

Target `main` and use the PR template. Describe the outcome, the risk, and the evidence that addresses it. Name the platforms you actually tested.

| Change                       | Evidence to include                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation or CLI example | Run the changed steps and report what you observed.                                                                                                      |
| Bug fix                      | Show the failure before and success after. Add a regression test when it can catch the same failure again.                                               |
| Visible desktop change       | Attach before/after images with synthetic data. Include a short recording when timing or keyboard interaction matters. Keep review-only media on the PR. |
| Format, sync, or restore     | Demonstrate compatibility with existing data and exercise the relevant recovery path. Identify any remaining platform or failure case to verify.         |

Use `Fixes #123` when merging fulfills the issue's acceptance criteria. For partial delivery, use `Refs #123` and record what remains on the issue. For example, if the agreed outcome includes verifying a Windows restore, keep the issue open until that result is recorded.

If a fork workflow says **Awaiting approval**, leave the PR open. A maintainer handles CI approval. Read the review, address blocking findings, and explain any disagreement on the PR. A concise follow-up there is welcome. There is no guaranteed review turnaround.

## Review and decisions

### Review the change

1. **Check the agreed outcome.** For substantial work, follow the linked issue. Verify observable behavior, compatibility, and the constraints the contributor was given. Review against the product and architecture references above. For example, readiness belongs in the shared core so desktop and CLI agree. Where a test or lint check can enforce an agreed rule, protect it there.
2. **Handle fork CI.** Check proposed workflow changes and scripts the workflows execute before approving a run. Approve it or explain the concern on the PR. A separate review decides whether to merge.
3. **Distinguish blocking feedback from suggestions.** Mark a finding **Blocking** when it violates an acceptance criterion or documented rule, introduces a concrete risk, or lacks evidence needed to judge that risk. Cite the rule or describe the failure, and say what would resolve it. Use **Suggestion** for an optional improvement. A question can become blocking once the risk is clear.
4. **Own new decisions.** Maintainers decide product and architectural direction. A contributor can challenge an existing rule on the issue. If a review introduces a new preference or changes scope, the maintainer explains and settles it there. Preserve the agreement in the relevant product or architecture document. CodeRabbit comments are advisory. A named maintainer resolves findings and owns acceptance. To request another bot pass, comment `@coderabbitai review` on the PR.

### Decide whether to merge

The normal merge path for every change is a PR targeting `main`, with the branch up to date and a passing `CI result`. A maintainer reviews an outside PR. A maintainer may merge their own ordinary change after recording their self-review and verification on the PR.

**Independent review is required** when a credible failure could irreversibly lose or corrupt workspace data, expose private content or credentials, or let an untrusted party publish a trusted release. Name the specific risk on the PR and obtain recorded approval from a qualified human reviewer independent of the author. The reviewing maintainer can provide that approval for an outside contributor. For a maintainer-authored change, find another reviewer. If nobody is available, hold the risky change or separate a safe portion. The maintainer applies this gate even when GitHub shows green checks and permits the merge.

**Emergency bypass is limited to containing an active incident.** A maintainer takes the narrowest action that stops the harm, such as pausing distribution or reverting to known-good behavior. Record the incident, the checks performed, the gate bypassed, and who will verify recovery. Keep sensitive details in the private reporting channel. A remedy that meets the independent-review criteria still requires that approval. Deadlines and flaky tests follow the ordinary process.

Version bumps, tags, and releases are maintainer-managed. See the [release guide](docs/releasing.md).
