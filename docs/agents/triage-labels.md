# Triage labels

Use GitHub issue labels to show the kind of work, the next action, and where help is welcome. The assignee and linked PR show who is working on it. Follow the [claim and check-in convention](../../CONTRIBUTING.md#find-and-claim-an-issue).

| Purpose                                    | Labels                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Kind of work                               | `bug`, `enhancement`, `documentation`, `question`                                                  |
| Next action on an open issue (at most one) | `needs-triage`, `needs-info`, `needs-decision`, `ready`                                            |
| Invitation                                 | `help wanted` welcomes extra help, and `good first issue` identifies work suitable for a newcomer. |

## Triage an issue

- **Intake.** New bug reports start with `bug` and `needs-triage`. Ideas and improvement suggestions both start with `enhancement` and `needs-triage`. Triage the original submission even if another form would have fit.
- **Missing information.** Use `needs-info` and ask for the specific example, reproduction, or observation that would unblock triage.
- **Open decision.** Use `needs-decision`. State what still needs deciding and what evidence would help. Invite an investigation or prototype when useful. When exploration needs an owner of its own, create a linked issue with an agreed outcome.
- **Ready.** A maintainer applies `ready` once the outcome, verification criteria, and constraints are agreed. For substantial work, record which behavior or architectural decision changes and which choices the contributor owns. Include any required platform verification. A live Windows check can itself be ready work. Replace the previous next-action label when moving between states.
- **Close.** Close as completed once the agreed outcome is verified. For a duplicate, link the continuing issue. For a declined or deferred idea, close as not planned, explain the reason, and say what would justify reconsideration when known.

## Existing labels

During the transition, read the issue and its latest comments before claiming or relabeling work marked `ready-for-agent` or `ready-for-human`. Ask a maintainer if the scope is unclear. Maintainers create the new labels after the policy merges and review each legacy issue individually. Map an unresolved product choice to `needs-decision`, and a well-specified implementation or verification task to `ready`.

Check saved searches, workflows, integrations, and other consumers before retiring the old labels. Keep specialized labels with a known use. Add a priority or area label when it serves a recurring decision or queue.
