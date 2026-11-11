import { expect, test } from "vitest";
import { historySentence } from "./history-sentence";
import { summarize } from "./inboxModel";

const lookups = {
  project: (id: string) => (id === "p1" ? "Platform" : undefined),
  plan: (id: string) => (id === "e1" ? "Quarter" : undefined),
};
const sentence = (kind: string, from_value: string, to_value: string) =>
  historySentence(
    { kind, from_value, to_value, timestamp: "", editing_agent: null },
    lookups,
  );

test("describes recorded changes as sentences without event keys", () => {
  expect(sentence("status", "Todo", "In progress")).toBe(
    "Status Todo → In progress",
  );
  expect(sentence("project", "", "p1")).toBe("Project set to Platform");
  expect(sentence("project", "p1", "gone")).toBe(
    "Project changed from Platform to gone",
  );
  expect(sentence("plan", "e1", "")).toBe("Plan cleared");
  expect(sentence("dependency", "", "T-KQ3")).toBe("Blocked by T-KQ3");
  expect(sentence("relationship:blocks", "T-KQ4", "")).toBe(
    "No longer blocks T-KQ4",
  );
  expect(sentence("relationship:duplicate", "", "T-KQ2")).toBe(
    "Marked as duplicate of T-KQ2",
  );
  expect(sentence("evidence", "", "Review")).toBe("Added evidence “Review”");
  expect(sentence("trash", "active", "trashed")).toBe("Moved to trash");
});

test("words subticket changes, and the Inbox shares the same sentences", () => {
  expect(sentence("relationship:child", "", "T-KQ7")).toBe(
    "Added subticket T-KQ7",
  );
  expect(sentence("relationship:child", "T-KQ7", "")).toBe(
    "Removed subticket T-KQ7",
  );
  expect(
    summarize({
      id: 1,
      reference: "T-KQ1",
      title: "Parent",
      kind: "relationship:child",
      from_value: "",
      to_value: "T-KQ7",
      timestamp: "",
      read: false,
      editing_agent: "codex",
    }),
  ).toBe("Added subticket T-KQ7 · codex");
});

test("an attached issue reads apart from a publication", () => {
  expect(sentence("source", "", "acme/api#7")).toBe("Published to acme/api#7");
  expect(sentence("source", "attached", "acme/api#7")).toBe(
    "Linked to acme/api#7 after an uncertain publication",
  );
});

test("falls back to a generic sentence for unknown kinds", () => {
  expect(sentence("future:kind", "a", "b")).not.toContain("future:kind");
});

test("source and publication history explain observations without inventing an import status", () => {
  expect(sentence("publication_unresolved", "attempt", "acme/api")).toBe(
    "Publish to acme/api — no response, outcome unknown",
  );
  expect(sentence("source_unavailable", "", "not_found")).toBe(
    "Source unavailable (not found)",
  );
  expect(sentence("source_import", "Todo", "acme/api#98")).toBe(
    "Imported from acme/api#98 as Todo",
  );
  expect(sentence("source_import", "", "acme/api#98")).toBe(
    "Imported from acme/api#98",
  );
});

test("history icons never give Canceled, Duplicate or source changes the completed look", async () => {
  const { historyIcon } = await import("./history-icon");
  const { statusIcons } = await import("./status-icons");
  expect(historyIcon("status", "Canceled")).toBe(statusIcons["Canceled"]!);
  expect(historyIcon("status", "Duplicate")).not.toBe(statusIcons["Done"]!);
  expect(historyIcon("status", "In progress")).not.toBe(
    historyIcon("status", "In review"),
  );
  for (const kind of [
    "external_duplicate",
    "ownership",
    "publication_unresolved",
    "future:kind",
  ])
    expect(historyIcon(kind)).not.toBe(statusIcons["Done"]!);
});
