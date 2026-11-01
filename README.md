# ticketd

A local ticket workspace with a desktop UI for people and a CLI for agents, sharing the same work and context.

## Product documentation

- [MVP specification](docs/mvp-spec.md): scope, behavior, and technical direction.
- [Domain glossary](GLOSSARY.md): canonical terminology.
- [High-level architecture](docs/architecture.md): runtime, module responsibilities, and data flows.

## Development workflow

Track features, bugs, implementation plans, and progress in [GitHub Issues](https://github.com/vantoan19/ticketd/issues). Repository documentation contains durable product and engineering guidance.

The Matt Pocock engineering skills are configured through `docs/agents/`. The skill package itself is installed in the developer's agent environment rather than vendored into this repository.

Read the [quality guidelines](docs/agents/quality.md) before implementing changes.

## Layout

```text
apps/desktop/
  src/app/             Application composition
  src/features/        Feature views and state
  src/components/      Shared layout and UI components
  src/lib/api/         Typed desktop bridge clients
  src-tauri/           Tauri desktop adapter, configuration, capabilities
crates/
  ticketd-core/        Shared Rust library; domain and persistence stay here
  ticketd-cli/         CLI executable named ticketd
scripts/               Shared development checks
docs/                  Product, domain, architecture, and agent guidance
```

The root Cargo workspace shares dependency versions, lint settings, and one lockfile. The npm workspace manages the desktop frontend.

## Development

Install [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/), Rust through rustup, and Node from `.nvmrc`. Rustup reads `rust-toolchain.toml`; use npm 10.9.2 as pinned in `package.json`.

```sh
npm ci
npm run desktop -- dev           # Desktop app with Vite
npm run dev                      # Frontend only
cargo run -p ticketd-cli -- --help
npm run build                    # Frontend production build
./scripts/check                  # Formatting, lint, types, and tests
```

Build the frontend before running `cargo build --workspace --locked`. For a packaged desktop build, use `npm run desktop -- build`. See [installation and distribution](docs/install.md) for packaged builds and CLI discovery.

The layout follows [Cargo workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html) and [Tauri's project structure](https://v2.tauri.app/start/project-structure/).

Checkout registrations use native filesystem paths. Register each existing checkout
with `ticketd project register PROJECT_ID PATH` and remove obsolete registrations
with `ticketd project unregister PROJECT_ID PATH`; project identity is unchanged.
Ticket creation infers context from the invocation's current directory, including
nested directories. `--project PROJECT_ID` overrides inference. Multiple matching
projects produce an error; an unmatched directory creates an unlinked ticket.
Paths are interpreted by the native operating system; interoperability with WSL
has not been validated.

### Atomic batches

`ticketd batch plan.json` accepts a JSON array; use `ticketd batch -` to read
standard input. A create names a ticket for later operations using `$name`:

```json
[
  { "operation": "create", "name": "parent", "title": "Ship the feature" },
  { "operation": "create", "name": "child", "title": "Implement it" },
  {
    "operation": "change",
    "ticket": "$child",
    "change": {
      "parent": "$parent",
      "add_blockers": ["$parent"],
      "add_tags": ["feature"],
      "notes": ["Plan agreed"]
    }
  }
]
```

Changes also accept `title`, `body`, `status`, `editing_agent`, `project_id`,
`effort_id`, `remove_tags`, and `remove_blockers`. Set `parent`, `project_id`, or
`effort_id` to null to clear it; omit a field to leave it unchanged. Results are
JSON ticket snapshots in operation order. Failures identify the zero-based
operation index and roll back the entire request. Requests are limited to 1 MiB,
100 operations, and 1,000 individual edits; execution checks a 10-second limit
between operations.

### Bounded ticket context

`ticketd context T-1` returns JSON with the ticket, derived availability, and
its tags. Add `--project`, `--effort`, `--relationships`, or `--notes` to
select those scopes. An omitted scope is absent; a selected but unlinked project,
Effort, or parent is `null`. Related tickets include status and `trashed`; only
Done satisfies a prerequisite. A missing root or a missing linked project or
Effort produces an error on stderr and a nonzero exit code, with no JSON on
stdout.

Each list is ordered by ticket reference number, tag name, or note insertion
order, and contains at most 20 items. A non-null `next_offset` means to repeat
the command with `--offset` set to that value; the offset applies independently
to every list in the response. Each call reads one snapshot, but later pages can
reflect intervening changes. Text objects contain `text` and `truncated`:
ticket and note bodies are limited to 4096 Unicode characters, other user text
to 256. Use `ticketd show T-1` for full ticket content and `ticketd note list
T-1` for full notes. The bounded body must not be used as an editable draft.

Search saved titles, bodies, and notes with `ticketd search QUERY`. The query is a
literal substring (ASCII letters match without case); an empty query returns no
matches. Results exclude trash and are ordered by descending ticket reference.
Use `--limit` (1–100, default 50) and `--offset` for pages, and `--project ID`
or `--unlinked` to restrict results. The desktop search uses the same matching
and pages through 50 results at a time.

`ticketd backlinks T-1` lists incoming references as JSON. Each entry has
`source_reference`, `source_title`, `note_id` (null for a description),
`passage` (the source line, trimmed to 512 characters around the reference), and
`mention_start` and `mention_end`, which locate the mention in the source ticket
description or note. They count Unicode scalar values (characters, as `passage`
is), not bytes or UTF-16 units, and do not count a leading U+FEFF byte order
mark, so a Python agent can slice `body[mention_start:mention_end]` after
dropping that mark. The span is the reference itself unless its source uses
escapes or entities, in which case it is the whole text run containing it.

Contextual links can be added with `ticketd add-relationship T-1 T-2 related`
or `ticketd add-relationship T-1 T-2 discovered`. For discovery, the first
ticket is the work during which the second was discovered. Use
`remove-relationship` with the same arguments to detach a link. Related links
are symmetric; neither kind affects readiness. `context --relationships`
returns bounded pages of related tickets, discoveries, and their sources.
The JSON export includes `contextual_relationships` records. Backups retain
these links and retry outcomes; personal preferences remain scoped to
`local-person`, independently of editing-agent attribution.
