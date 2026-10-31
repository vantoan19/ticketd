# Defer record versioning for the MVP

To simplify the MVP interface, ticket, note, and relationship writes do not require record versions or perform stale-version rejection, superseding ADR-0001. Atomic operations, graph validation, consistent read snapshots, and request-ID retry protection remain required; retry deduplication does not protect against overwriting a different concurrent edit. Updates change only supplied fields, with explicit clearing and last-successful-write wins for the same field. Dependencies and tags use additions/removals rather than replacing whole lists; parent changes use assignment/removal.

External updates refresh saved information without replacing unsaved UI drafts. When saved content changes beneath a draft, the UI indicates the change and lets the user reload or overwrite by saving; it does not automatically merge edits.
