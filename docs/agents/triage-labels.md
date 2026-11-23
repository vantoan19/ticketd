# Triage labels

Use GitHub issue labels to show the kind of work, the next action, and where help is welcome. The assignee and linked PR show who is working on it. Follow the [claim and check-in convention](../../CONTRIBUTING.md#find-and-claim-an-issue).

| Purpose                                    | Labels                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Kind of work                               | `bug` for bugs, `enhancement` for enhancements, ideas, and improvements                            |
| Next action on an open issue (at most one) | `needs-triage`, `needs-info`, `needs-decision`, `ready`                                            |
| Invitation                                 | `help wanted` welcomes extra help, and `good first issue` identifies work suitable for a newcomer. |

## Triage an issue

- **Intake.** New bug reports start with `bug` and `needs-triage`. Enhancements, ideas, and improvements start with `enhancement` and `needs-triage`. Keep each description focused, clear, and human-readable. Ask for a concrete example when the outcome is unclear. Triage an eligible report in place even if another form would have fit. Redirect standalone usage questions to the user guides and implementation tasks to the contributor’s local ticketd workspace.
- **Missing information.** Use `needs-info` and ask for the specific example, reproduction, or observation that would unblock triage.
- **Open decision.** Use `needs-decision`. State what still needs deciding and what evidence would help. Invite an investigation or prototype when useful. Name the investigator on the public proposal and organize the investigation locally in ticketd.
- **Ready.** A maintainer applies `ready` once the outcome, verification criteria, and constraints are agreed. For substantial work, record which behavior or architectural decision changes and which choices the contributor owns. Include any required platform verification. Track the Windows verification steps locally and report the result on the public issue or PR. Replace the previous next-action label when moving between states.
- **Close.** Close as completed once the agreed outcome is verified. For a duplicate, link the continuing issue. For a declined or deferred idea, close as not planned, explain the reason, and say what would justify reconsideration when known.

## Existing labels

During the transition, read the issue and its latest comments before claiming or relabeling work marked `ready-for-agent` or `ready-for-human`. Ask a maintainer if the scope is unclear. Maintainers create the new labels after the policy merges and review each legacy issue individually. Map an unresolved product choice to `needs-decision`, and a well-specified implementation or verification task to `ready`.

Check saved searches, workflows, integrations, and other consumers before retiring the old labels. Keep specialized labels with a known use. Add a priority or area label when it serves a recurring decision or queue.
