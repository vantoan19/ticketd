# Public issues and local implementation tasks

Use `gh` for bugs, enhancements, ideas, and improvements in `vantoan19/ticketd`. The same four categories apply to CLI and API submissions. Write a short title and describe one outcome in plain language. Follow the [issue writing guide](../../CONTRIBUTING.md#write-an-issue-people-can-understand). Keep durable product requirements in `docs/product.md`.

Before the first issue write in a session, verify the target with `gh repo view --json nameWithOwner`. Use `--repo vantoan19/ticketd` when outside this checkout or when the default target is ambiguous.

- Create with the matching [issue form](../../.github/ISSUE_TEMPLATE/). With `gh issue create --title "..." --body-file /path/to/body.md`, follow that form’s prompts. Apply the [intake labels](triage-labels.md#triage-an-issue) if you have permission.
- Read: `gh issue view <number> --json number,title,body,labels,assignees,comments,blockedBy,closedByPullRequestsReferences`. If your `gh` rejects a field, use `gh issue view <number> --comments` and check the issue’s GitHub sidebar for linked PRs and blockers.
- List: `gh issue list --state open --json number,title,labels,assignees`.
- Update: `gh issue edit <number> --body-file /path/to/body.md`.
- Report a decision or verification result: `gh issue comment <number> --body-file /path/to/comment.md`.
- Apply/remove labels: `gh issue edit <number> --add-label "..." --remove-label "..."`.
- Close: post the outcome as a comment, then `gh issue close <number>` with the appropriate completion reason.

Use temporary files outside the repository for multiline command input. When a skill calls for a work breakdown, create the Plan, subtickets, dependencies, and research notes in the contributor’s local ticketd workspace. This applies to Wayfinder maps and child tasks too. Run `ticketd skills get` for the local CLI guide. Keep the public issue URL with the local work. Never create public issues or sub-issues for its implementation steps.

Before picking up work, check the assignee, recent claims, blockers, and linked PRs.
Use the [public claim and release rules](../../CONTRIBUTING.md#find-and-claim-an-issue).
For triage and closure, use the [label definitions and outcomes](triage-labels.md).
For direct PRs and changes that need maintainer agreement, follow the
[contribution paths](../../CONTRIBUTING.md#choose-a-starting-point).
