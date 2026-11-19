# External tickets and sources

`show T-KQ1` includes source ownership, freshness, and publication state. Bounded
`context` does not include all those fields. An external identity can remain as
provenance after a ticket becomes locally owned; identity alone does not establish
current authority. `list --source github` or `--source local` filters ownership.

While externally owned, a ticket's authoritative title/body and closure are
managed in its external tracker. Open external tickets allow local Todo,
In progress, and In review progress. Local Activities and organization remain
in ticketd. Treat unavailable or stale external data as such, not as deletion or
proof that the ticket is now local. Core errors explain which changes are allowed.

## Inspect and configure

```sh
ticketd source list
ticketd source show github
ticketd source status
ticketd context T-KQ1 --conversation
```

`source list` returns available connectors, configuration schemas, and saved
settings. Use `source options` for supported field values, `source test` to check
the connection, and `source preview` to inspect discovery results before saving
configuration. See each command's help for `--set` and `--config-file`.
Credentials use the connector's authentication path, not authored ticket content.

`source save` stores settings without importing. `source refresh` imports matches
and updates externally owned tickets (titles are made one line of at most 1000
characters; the source keeps the original); `--ticket T-KQ1` refreshes one ticket. Refresh
can return a JSON report with failures and a nonzero exit code: inspect both.
These commands can contact the external service even though ticketd stores data
locally. `source take-ownership` is an explicit authority change for an unavailable
ticket, not a workaround for an ordinary edit rejection.

## Publication and uncertain outcomes

When publication is requested, first inspect its exact payload and destination:

```sh
ticketd source publish T-KQ1 --destination owner/repository --preview
```

A saved source publishes only to the repositories it lists: any other
`--destination` is refused in the preview and the publish, before anything is sent.

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
