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

The target is one built-in GitHub integration per device. It holds the issue
import repository list, with optional filters per repository. Routing uses the
[Project remote](0021-route-external-tickets-to-projects-by-project-remote.md).
Source extensions keep their connections. A separate Workspace migration will
consolidate the saved GitHub connections while preserving external identities,
repository rules and publication records.

The first transport change moves the repository picker through `gh` for the
active github.com login. Existing named accounts, token overrides and custom
API endpoints keep their established behavior during the transition. Account
checks and the requests they authorize must migrate together so the same
verified login is used for an entire workflow.
