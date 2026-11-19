# Issue tracker: GitHub

Use GitHub Issues in `vantoan19/ticketd` for features, bugs, research, implementation plans, and progress. Use the `gh` CLI; keep durable product requirements in `docs/product.md`.

Before the first issue write in a session, verify the target with `gh repo view --json nameWithOwner`. Use `--repo vantoan19/ticketd` when outside this checkout or when the default target is ambiguous.

- Create: `gh issue create --title "..." --body-file /path/to/body.md`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,labels`.
- Update: `gh issue edit <number> --body-file /path/to/body.md`.
- Report findings or progress: `gh issue comment <number> --body-file /path/to/comment.md`.
- Apply/remove labels: `gh issue edit <number> --add-label "..." --remove-label "..."`.
- Close: post the outcome as a comment, then `gh issue close <number>` with the appropriate completion reason.

Use temporary files outside the repository for multiline command input. Publish work specs and task breakdowns as issues, not repository Markdown tickets.

Use native GitHub sub-issues and blocking dependencies where supported by the installed CLI/API. Check `gh issue create --help` and `gh issue edit --help` before selecting flags. If unavailable, record `Part of #<parent>` or `Blocked by: #<number>` in issue bodies and link children from the parent. Inspect blockers before selecting work; a canceled prerequisite is not evidence that the requirement was satisfied.

When a skill says to publish to the tracker, create a GitHub issue here. When it says to fetch a ticket, read the issue and its comments. Wayfinder maps and child tickets also live in GitHub Issues.

Use issues for product requests and implementation planning. Small fixes and
documentation improvements may be submitted directly as PRs; see
[contribution guidance](../../CONTRIBUTING.md). Substantial changes need scope
discussion before implementation.
