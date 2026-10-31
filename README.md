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
  src/                 React views and styles
  src-tauri/           Tauri desktop adapter, configuration, capabilities
crates/
  ticketd-core/        Shared Rust library; domain and persistence stay here
  ticketd-cli/         CLI executable named ticketd
scripts/               Shared development checks
docs/                  Product, domain, architecture, and agent guidance
```

The root Cargo workspace shares dependency versions, lint settings, and one lockfile. The npm workspace manages the desktop frontend. Core internals and feature folders are added when their first implementation needs them.

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

Build the frontend before running `cargo build --workspace --locked`. For a packaged desktop build, use `npm run desktop -- build`. The scaffold has no ticket operations or database yet, and no placeholder behavior tests.

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

Search saved titles, bodies, and notes with `ticketd search QUERY`. The query is a
literal substring (ASCII letters match without case); an empty query returns no
matches. Results exclude trash and are ordered by descending ticket reference.
Use `--limit` (1–100, default 50) and `--offset` for pages, and `--project ID`
or `--unlinked` to restrict results. The desktop search uses the same matching
and pages through 50 results at a time.
