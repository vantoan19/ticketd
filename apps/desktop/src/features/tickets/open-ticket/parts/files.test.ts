import { describe, expect, test } from "vitest";
import type { DocumentLink } from "@/features/documents/api";
import { relinkedDocumentFill, unlinkedDocumentFill } from "./files";
import { ticketFor } from "./ticket-fixture";

const record = ticketFor("T-1");
const base: DocumentLink = {
  source_id: record.id,
  target_id: "d1",
  source_kind: "ticket",
  target_kind: "document",
  passage: "",
  source_label: "T-1",
  target_label: "Spec",
  source_trashed: false,
  target_trashed: false,
  explicit: true,
};
const explicit = base;
const mention: DocumentLink = { ...base, explicit: false, passage: "See Spec" };

// The core deletes only the explicit row of a Document (`ticket_documents`);
// a mention in the description or an update stays.
describe("the Document link fills follow what the core changes", () => {
  test("unlinking drops the explicit row and keeps a mention", () => {
    const fill = unlinkedDocumentFill(record, "d1");
    expect(fill.apply([[explicit, mention], []])).toEqual([[mention], []]);
  });

  test("unlinking changes nothing when no explicit row is cached", () => {
    const fill = unlinkedDocumentFill(record, "d1");
    expect(fill.apply([[mention], []])).toBeUndefined();
  });

  test("linking again adds the explicit row beside a cached mention", () => {
    const fill = relinkedDocumentFill(record, explicit);
    expect(fill.apply([[mention], []])).toEqual([[mention, explicit], []]);
  });

  test("linking again changes nothing when the explicit row is cached", () => {
    const fill = relinkedDocumentFill(record, explicit);
    expect(fill.apply([[mention, explicit], []])).toBeUndefined();
  });
});
