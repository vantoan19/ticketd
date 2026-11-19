# Relational context storage and bounded graph queries

## Decision

Keep the shared Rust core and SQLite workspace. Store Tickets, Documents,
Activities, and Plans in distinct relational tables. Use a small shared entity
identity table for foreign-key targets of cross-type references, with concrete
records retaining their typed fields and domain rules. Core writes enforce
entity kind and concrete-record consistency atomically; an identity row is not
a generic JSON replacement for domain records.

Documents store optional title, canonical Markdown body, timestamps, and trash
state. Activities store their ticket, kind, brief or structured event payload,
optional supporting Document, attribution, and timestamps. Track the originating
Activity of generated detail Documents separately from ordinary references;
an explicit promotion flag allows ordinary browsing without clearing provenance.
Setting a detail Document as a Plan spec promotes it. Removing its originating
Activity clears origin without deleting the Document. A standalone
Document linked as support retains its browsing visibility.

Tickets store optional Plan membership. Plans store their name, optional
description, archive state, and optional primary-spec Document reference.
Supporting associations, dependencies, mentions, and tags have explicit tables
and constraints. A primary spec must also be associated with its Plan. Preserve
source passages for mention explanations and update extracted mentions together
with the changed Markdown. Keep authoritative relationships in one place.

## Graph reads and search

Graphs are query results over authoritative relationships, not a second editable
store. Fetch indexed adjacency in batches, then metadata and edges for selected
nodes in batches. Index both directions of relationships and match composite
indexes to filtering and ordering. Replace pairwise edge-existence queries with
set-based edge retrieval. Graph reads use one consistent snapshot and return
lightweight metadata rather than full Markdown bodies.

Bound depth, nodes, edges, and traversal work, including high-degree hubs. A final
SQL LIMIT alone is not a work budget. Use stable ordering and report omitted
neighbors with explicit expansion. Dependency cycle validation checks the actual
relevant dependency structure in the write transaction, independently of display
limits. Context cycles are valid; dependency cycles are not.

Use FTS5 for text search, updated transactionally with canonical content. Search
and mention indexes are derived and rebuildable; they do not own document text.
Select only metadata for lists and graph nodes. Recently opened is local browsing state, updated by opens and new
captures rather than background content writes; pins remain above it. Unpublished
Activity composer drafts persist locally per ticket and do not create published
Activities or searchable Documents. Activity feeds use indexed ticket
and sequence pagination; Plan status counts are derived from member tickets.

## Rendering and validation

Retain React Flow and Dagre initially for bounded dependency diagrams. Move
expensive layout off the UI thread, preserve positions during expansion, and
avoid relayout for metadata-only changes. Context graph layout need not use the
dependency layout; select it against measured bounded workloads. Workspace scope
does not mean loading every record at once.

Initial benchmark targets are under 100 ms p95 core query time for a Document or
Activity page, under 100 ms p95 for a local graph up to 100 nodes / 300 edges, and
under 300 ms p95 from opening that graph to usable presentation. These are targets,
not measured guarantees or immutable display limits. Record the reference
machine, dataset sizes, cold/warm results, query plans, and concurrent-write load.
Include dense graphs, high-degree hubs, and large Documents. Tune from evidence;
a graph database, global graph cache, or specialized renderer requires a measured
need.

## Consequences

Typed data and a single transaction boundary keep validation and exports
straightforward. Identity consistency, index maintenance, and layout scheduling
require focused tests. Large workspace views must disclose truncation rather
than suggest completeness. No legacy Effort/Note aliases or development-data
migration are required for this model change.

This extends ADR 0004 without changing its process model, ADR 0005 without
changing canonical Markdown, and ADR 0006 without changing external authority.

## References

- [SQLite query planning](https://www.sqlite.org/queryplanner.html)
- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [React Flow performance](https://reactflow.dev/learn/advanced-use/performance)
- [Product behavior](../product.md#context-management)
