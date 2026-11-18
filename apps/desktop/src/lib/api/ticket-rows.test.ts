import { expect, test, vi } from "vitest";
import { client } from "./client";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

test("reads a page of list rows without bodies", async () => {
  const filter = {
    query: "",
    project: null,
    unlinked: false,
    plan: null,
    status: null,
    tags: [],
    availability: null,
    family: null,
    limit: 50,
    offset: 0,
  };
  const row = {
    id: "1",
    reference: "T-KQ1",
    title: "Work",
    status: "Todo",
    trashed: false,
    project_id: null,
    plan_id: null,
    availability: "Blocked",
    updated_at: "2026-11-04T00:00:00Z",
    tags: ["ui"],
    latest_update: {
      activity_id: "a1",
      brief: { text: "Checkpoint", truncated: false },
      reported_at: "2026-11-04T00:00:00Z",
      updated_at: "2026-11-04T00:00:00Z",
      editing_agent: null,
      supporting_document_id: null,
    },
    source: {
      provider: "github",
      provider_name: "GitHub",
      place: "owner/repo",
      number: "#98",
      display: "owner/repo#98",
    },
    parent: { reference: "T-KQ2", title: "Parent", trashed: false },
    duplicate_of: null,
    prerequisites: { total: 2, unresolved: 1 },
  };
  bridge.invoke.mockResolvedValueOnce([row]);
  await expect(client.findTicketRows(filter)).resolves.toEqual([row]);
  expect(bridge.invoke).toHaveBeenCalledWith("find_ticket_rows", { filter });
});
