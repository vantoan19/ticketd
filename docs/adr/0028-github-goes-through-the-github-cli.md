# GitHub goes through the GitHub CLI

ticketd currently calls GitHub's API with a credential from the environment or
from `gh auth token`. It checks the account and keeps connection settings that
repeat parts of the GitHub CLI's account and host configuration. We will use the
person's GitHub CLI login and run GitHub integration requests through `gh`. This
gives ticketd the same accounts and hosts the person uses in their terminal.

## Process and credentials

Ticketd runs `gh api` with an explicit host, disabled prompts and a request
deadline. It keeps the scoped credentials and network calls inside `gh`. The
environment variables supported by `gh` continue to work. Ticketd's GitHub token
overrides retire when the migration is complete.

The integration uses the active login for a repository's host. A Project may
pin another `gh` login on that host. For a pin, ticketd reads `gh auth token
--hostname HOST --user LOGIN` and passes the result only in the environment of
the child making the request. Ticketd keeps no token in storage, logs or
diagnostics. If that login is unavailable, its requests stop with an explanation.

## Refresh cost and outcomes

A `gh` process adds startup time to each invocation. Batch GitHub reads with
GraphQL and use conditional REST reads where supported. Reuse the cached
representation on an authenticated `304`. Compare launch count, GitHub request
count and elapsed time for first import and unchanged refresh on the same
repositories as the previous transport.

Retry idempotent reads only. A confirmed rate limit pauses requests for that
host and API bucket until reset. A failed response can follow a successful
write, so the publication workflow keeps its uncertain-result recovery rules.

## Integration

One built-in GitHub integration per device holds the issue import repository
list, with optional filters per repository. Routing uses the
[Project remote](0021-route-external-tickets-to-projects-by-project-remote.md).
Source extensions keep their connections.

Workspace format 106 consolidates GitHub connections without changing ticket
identity or authority. Discovery filters and refresh coverage stay specific to
each repository. Publication recovery retains the original site, account
identity, and tracker clock. The format step saves legacy account and rule
candidates without invoking the GitHub CLI. A later account check reconciles
them with the verified active login and reports cases that require review.

The repository picker, issue import, refresh, publication and recovery use the
GitHub CLI. Each workflow uses the same credential for its account check and
subsequent requests.
