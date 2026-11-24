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

The preview is offline. It reports whether the Project remote's repository
needs adding to GitHub discovery, which existing unlinked tickets would be
linked, and the fingerprint. Use the fingerprint to confirm that effect. If it
has changed, preview again. If the repository is already listed, confirmation
only backfills the reviewed links and also works offline. If the preview reports
`not_connected`, save the GitHub source with the preview's `repository` and
get a fresh preview.

## Publication and uncertain outcomes

Start by previewing the publication to inspect its exact payload and destination.

```sh
ticketd source publish T-KQ1 --preview
```

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
