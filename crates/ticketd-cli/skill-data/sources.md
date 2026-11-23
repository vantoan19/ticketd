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
ticketd source CONNECTION refresh --ticket T-KQ1
ticketd source CONNECTION remove
ticketd context T-KQ1 --conversation
```

`source list` returns connection IDs, providers, and the providers' settings schemas.
Put the connection ID before its operation. See `source CONNECTION --help`
for `show`, `test`, `options`, `edit`, `rename`, `preview`, `status` and `refresh`. `source add` takes a provider ID. Use
`source add --preview` to check a new connection before adding it. See each command's
help for `--set` and `--config-file`.

`source add` and `source CONNECTION edit` validate and store settings without importing.
`source CONNECTION refresh` discovers matching issues and updates tickets routed to
that connection. Refresh can return a JSON report with failures and a nonzero exit
code. `source take-ownership T-KQ1` explicitly changes authority for an unavailable
ticket. Connections and their credentials stay on the local device.

Removing a connection keeps the ticket’s last synced content, local work, and
external identity. Its tickets read Connection removed on this desktop until a
covering connection discovers the issue again. Taking ownership makes a ticket
local. That authority decision persists after rediscovery. Unresolved publications
remain recorded and block a second create.

## Publication and uncertain outcomes

When publication is requested, first inspect its exact payload and destination:

```sh
ticketd source publish T-KQ1 --connection CONNECTION --destination DESTINATION --preview
```

A saved source publishes to its allowed destinations. The preview checks your
choice before anything is sent. Omit `--connection` when only one connection can publish.

Use the returned fingerprint with `--expect FINGERPRINT` when executing the
publication. It creates an external issue and transfers authority while preserving
ticketd identity. A changed payload or destination invalidates the preview.
Publication is not ongoing outbound synchronization.

If the outcome is unresolved, use `source resolve T-KQ1` to inspect the attempt and
search for the possible issue. `--no-search` avoids network access. Then use the
documented `--attach`, `--issue`, or `--not-created` action only when the observed
outcome supports it. Inspect `source resolve --help`; `--accept-different` attaches
different external content and has different consequences. An unknown outcome is
not evidence that creation failed, and changing retry identity could duplicate work.
