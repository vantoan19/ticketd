---
status: superseded by ADR-0003
---

# Detect stale edits at ticket granularity

Ticket edits reject a stale ticket version even when concurrent changes affect different fields, favoring a predictable conflict contract over automatic merging or field-level conflict detection. The UI preserves unsaved drafts so callers can fetch current data and reconcile before retrying. Appending an independent note does not invalidate a ticket edit; edits to existing notes use separate conflict protection.

Explicit dependency changes invalidate both endpoint versions; reparenting invalidates the child and the old and new parents. A prerequisite's status change does not invalidate dependent versions: derived context may change without changing the dependent ticket itself.
