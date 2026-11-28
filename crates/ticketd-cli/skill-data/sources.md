# External tickets and sources

`show T-KQ1` includes source ownership, freshness, and publication state. Bounded
`context` does not include all those fields. An external identity can remain as
provenance after a ticket becomes locally owned; identity alone does not establish
current authority. `list --source PROVIDER` or `--source local` filters ownership.

While externally owned, a ticket's authoritative title/body and closure are
managed in its external tracker. Open external tickets allow local Todo,
In progress, and In review progress. Local Activities and organization remain
in ticketd. Treat unavailable or stale external data as such, not as deletion or
proof that the ticket is now local. Core errors explain which changes are allowed.

## Inspect and configure

```sh
ticketd source list
ticketd source add PROVIDER --set KEY=VALUE --preview
ticketd source add PROVIDER --name "Work" --set KEY=VALUE
ticketd source CONNECTION show
ticketd source CONNECTION status
ticketd source CONNECTION sign-in --config-file -
ticketd source CONNECTION refresh --ticket T-KQ1
ticketd source CONNECTION remove
ticketd context T-KQ1 --conversation
```

`source list` returns the provider description and settings schema in
`connector`. Find the provider ID at `connector.provider` and the connection
ID at `saved.id`. A row with `saved: null` describes a provider available for
setup. `source add` takes a provider ID. Put the saved connection ID before
operations such as `show`, `test`, `options`, `edit`, `rename`, `preview`,
`status` and `refresh`. Use `source add --preview` to check settings before
adding. See each command's help for accepted settings and flags.

`source add` and `source CONNECTION edit` validate and store settings without importing.
`source CONNECTION refresh` discovers matching issues and updates tickets routed to
that connection. Refresh can return a JSON report with failures and a nonzero exit
code. `source take-ownership T-KQ1` explicitly changes authority for an unavailable
ticket. Connections and their credentials stay on the local device.

If a connection needs sign-in, use the provider's terminal instructions or the
`sign-in` command for extensions that declare secret fields. The command
reads a JSON object of credential values from stdin when passed
`--config-file -`. Read credential values through an already authorized secure
mechanism and keep them out of command arguments and working files.

Removing a connection keeps the ticket’s last synced content, local work, and
external identity. Its tickets read Connection removed on this desktop until a
covering connection discovers the issue again. Taking ownership makes a ticket
local. That authority decision persists after rediscovery. Unresolved publications
remain recorded and block a second create.

## GitHub

GitHub uses the GitHub CLI login on each repository's host. Configure and
refresh it with the integration ID.

```sh
ticketd source github show
ticketd source github repository github.com/OWNER/NAME --label bug --preview
ticketd source github repository github.com/OWNER/NAME --label bug
ticketd source github refresh --ticket T-KQ1
ticketd source github remove github.com/OWNER/NAME
```

Each repository has separate import rules. Removing a repository stops refresh
and keeps the tickets' cached content and local work. The GitHub CLI chooses the
active login unless a Project selects another through
`source github project-login PROJECT_ID --host HOST --login LOGIN`.

## Register and test an extension

Use `source extension list` to find registered extension IDs. `source extension
add PATH` shows the exact command and asks for approval before running it
with the user's OS permissions. `source extension link PATH` runs a trusted
development folder in place. `source extension remove ID` removes the extension
registration.

`source conformance PROVIDER` checks a registered extension with settings
provided through `--set` or `--config-file -`. Read the report and its skip
reasons. Use `--strict` to require the observations described in help.
When the task calls for a test write, `--publish DESTINATION` permits one
creation and checks the recovery queries.

If refresh asks for the original host of a legacy GitHub ticket, confirm its
current issue URL on that host with `source reconcile-github T-KQ1 --issue URL`.
Restore a trashed ticket before confirming its link. GitHub's reply must match
the saved stable issue ID and the supplied URL. The ticket keeps its current
ownership, even after takeover.

## Connect a project to its source

```sh
ticketd project connect-source PROJECT_ID --preview
ticketd project connect-source PROJECT_ID --expect FINGERPRINT
```

The preview is offline. It reports whether GitHub or the selected extension
needs to add the repository to discovery, which unlinked tickets would be linked, and
what fingerprint to confirm. If several connections match the Project remote,
pass `--connection CONNECTION` for both preview and confirmation. If the
repository is already listed, confirmation works offline. If the preview
reports `not_connected`, use `source add PROVIDER --set repositories=OWNER/NAME`
with its `provider` and `repository`, then preview again.

## Publication and uncertain outcomes

Start by previewing the publication to inspect its exact payload and destination.

```sh
ticketd source publish T-KQ1 --connection CONNECTION --preview
ticketd source publish T-KQ1 --connection CONNECTION --expect FINGERPRINT
```

Choose an extension connection's `saved.id` from `ticketd source list`. For
GitHub, use `ticketd source publish T-KQ1 --provider github --preview`. You can
omit the selector when exactly one source can publish.

The preview defaults to the ticket's Project remote when the saved source lists
that repository on the matching host. Without a match, it selects the sole listed
repository if there is one. Use `--destination owner/repository` to choose
explicitly. If the saved source lists repositories, it only publishes to those
repositories.

Keep the same destination arguments and pass the returned fingerprint with
`--expect FINGERPRINT` when publishing. Using the Project remote as the default
requires this fingerprint. A changed payload or destination invalidates the
preview. Publication creates one external issue and transfers authority while
preserving ticketd identity.

If the outcome is unresolved, use `source resolve T-KQ1` to inspect the attempt and
search for the possible issue. `--no-search` avoids network access. Then use the
documented `--attach`, `--issue`, or `--not-created` action only when the observed
outcome supports it. Inspect `source resolve --help`; `--accept-different` attaches
different external content and has different consequences. An unknown outcome is
not evidence that creation failed, and changing retry identity could duplicate work.
For an unbound GitHub attempt with an unverified site, verify the original host
and port, then run `ticketd source resolve T-KQ1 --confirm-host HOST` separately.
Use `HOST:PORT` for a nondefault port. After confirmation, attach the verified
issue with `ticketd source resolve T-KQ1 --issue ISSUE`. When an attempt
recorded a GitHub login, recovery verifies that same account on its original
host.

An interactive refresh reports extension progress on stderr. Press Ctrl+C to
cancel it. A canceled refresh exits 130.
