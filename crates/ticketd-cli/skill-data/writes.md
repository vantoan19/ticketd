# JSON writes, retries, and conflicts

Use `ticketd write request.json --request-id UNIQUE_ID` for a retryable write.
Use `-` instead of the filename for stdin. Store the exact request and its ID
before sending it; IDs are workspace-wide, so choose a unique ID per intended
operation. Results have a `kind` and usually a `value`.

The JSON examples below are independent operations. Replace uppercase placeholder
values with actual returned IDs or full original content. Write them as UTF-8 JSON
using a serializer; shell interpolation must not alter Markdown, `$name` references,
or quotes. JSON is an operation-specific request, not a shell command string.

## Retryable creation

```json
{
  "operation": "create_ticket",
  "title": "Example ticket",
  "project_id": "PROJECT_ID"
}
```

Set `project_id` to null for an unlinked ticket. Unlike direct `create`, this
request does not infer a project from the working directory.

## Guarded edits

Read `show T-KQ1` first. To replace its body only if it still equals what was read:

```json
{
  "operation": "change_ticket",
  "reference": "TICKET_REFERENCE",
  "patch": {
    "body": "Revised body",
    "expected_body": "FULL_ORIGINAL_BODY"
  }
}
```

`expected_title` similarly guards a title replacement. Omitted guards allow
last-successful-write wins; direct `change` does not expose these guard flags.
For Documents, read `document show DOCUMENT_ID`, then supply its `updated_at`:

```json
{
  "operation": "change_document",
  "id": "DOCUMENT_ID",
  "patch": {
    "body": "Revised detail",
    "expected_updated_at": "RETURNED_UPDATED_AT"
  }
}
```

A conflict means re-read and reconcile with current content. Preserve the guard
when resubmitting a reconciled edit; do not remove it just to make the command pass.
Use a new ID for a changed request. Retry IDs prevent duplicated execution; they
do not protect edits from other requests.

Ticket patches accept `title`, `body`, `status`, `editing_agent`, `project_id`,
and `plan_id`, plus the text guards. Omit fields to leave them unchanged. Explicit
null clears project/Plan membership; an empty body clears text. Document patches
accept title/body and their timestamp guard; null clears a Document title.

## Atomic ticket batches

```json
{
  "operation": "batch",
  "operations": [
    {
      "operation": "create",
      "name": "first",
      "title": "First ticket",
      "project_id": "PROJECT_ID"
    },
    {
      "operation": "create",
      "name": "second",
      "title": "Second ticket",
      "project_id": "PROJECT_ID"
    },
    {
      "operation": "change",
      "ticket": "$second",
      "change": { "add_blockers": ["$first"], "add_tags": ["example"] }
    }
  ]
}
```

`$name` refers only to an earlier create in this request. A batch supports ticket
creates and changes, not creation of Plans or Documents. Changes accept ticket
patch fields plus `parent`, `add_tags`, `remove_tags`, `add_blockers`,
`remove_blockers`, and `activities`. Null clears a parent; omission preserves it.
The single-ticket equivalent is `operation: "ticket_change"` with `reference`
and `change`. A `change_ticket` request instead uses `patch` for field edits only.

Failures identify the zero-based operation index and roll back the whole batch.
They name tickets created in the batch by their `$name`, since those references
were never saved; tickets that existed before keep their real references.
Limits are 100 operations, 1 MiB, and 1,000 individual edits; execution checks a
10-second bound between operations. Results are snapshots in operation order;
later operations can change a ticket returned earlier in the same batch.
Direct `batch FILE` takes just the operations array and has no retry ID. Wrap it
in `write` as above for replay protection.

## Return a ticket in review

Send back moves an In review ticket to In progress and posts one local update in the same write. Read the ticket first, then use `ticketd write - --request-id REVIEW_DECISION_ID` with the status history number you read:

```json
{
  "operation": "send_back",
  "reference": "TICKET_REFERENCE",
  "brief": "What needs to change",
  "expected_status_history_number": 42
}
```

Replace 42 with the ticket's `status_history_number`. Use 0 if the ticket has no recorded status change. The guard rejects a decision once the status has changed, even if the ticket returns to In review.

To undo it, use a new `--request-id` and send:

```json
{
  "operation": "undo_send_back",
  "reference": "TICKET_REFERENCE",
  "send_request_id": "REVIEW_DECISION_ID"
}
```

Undo restores In review and removes the decision's update together. The decision must still be the most recent status change, and its update must still be unchanged. Neither operation publishes to the ticket's external source.

## Replay and failure handling

After a timeout, lost response, or output failure, retry with the same ID and
identical request. Successful outcomes are retained and returned without applying
the write again. Replays return the original result, not current state. Re-read
before decisions that need current data. The same ID with different content fails.
Exact strings, array order, attribution, and explicitly cleared fields matter;
JSON whitespace and object-key order do not. Failed writes do not reserve IDs.

Some direct Document/Activity commands also advertise `--request-id`. Other
commands, including direct ticket creation and evidence/Plan creation, do not;
inspect help instead of assuming a global flag. After an uncertain unprotected
create, inspect state before repeating it. External publication has its own
recovery protocol: load `ticketd skills get sources` rather than blindly retrying.
