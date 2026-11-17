# Optional expected values guard editor saves

ADR-0003 deferred record versioning and said ticket, note and relationship writes perform no stale-edit rejection. The product has since grown an editor that autosaves, and an autosave must not silently overwrite a change made elsewhere. This ADR replaces that one sentence of ADR-0003 and nothing else: there are still no record versions, and the rest of ADR-0003 stands.

## Decision

An editor may send the values it last loaded or saved, and the core rejects the save when the stored values have moved on:

- A ticket change may carry `expected_title` and `expected_body`. When a change sets the title and `expected_title` differs from the stored title, or sets the body and `expected_body` differs from the stored body, it fails with `TicketChanged`. Each expected value guards only the field it names.
- A Document change may carry `expected_updated_at`. When it differs from the stored `updated_at`, the change fails with `DocumentChanged`.

A caller that omits the expected values keeps ADR-0003's rule: the update changes only the supplied fields and the last successful write wins. The CLI omits them, as do automations, version restore and any other write that is not an editor holding a draft. A rejection is retryable after the editor reloads, which is why it is a conflict and not a failure.

The values are optional fields of `TicketPatch` and `DocumentPatch`, and are omitted from their JSON when absent, so stored `WriteRequest` payloads and their request-ID hashes (ADR-0002) stay valid.

## Consequences

The core applies this guard in one place for tickets, the ticket change, so every entry that carries a patch (a single change, the combined change, a batch, a replayed request) answers it the same way. Dependencies, tags, parents and Plans still use explicit additions, removals and assignments with no guard.

Request IDs still do not protect against overwriting a different concurrent edit; the expected values do, for the editors that send them.
