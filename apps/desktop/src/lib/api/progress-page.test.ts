import { expect, test, vi } from "vitest";
import { client } from "./client";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

test("reads and validates one filtered page with its authored summaries", async () => {
  const filter = {
    query: "checkpoint",
    project: null,
    unlinked: false,
    plan: null,
    status: "In progress",
    tags: [],
    availability: null,
    family: null,
    limit: 20,
    offset: 20,
  };
  const ticket = {
    id: "1",
    trashed: false,
    reference: "T-KQ1",
    title: "Work",
    status: "In progress",
    body: "",
    tags: [],
    project_id: null,
    plan_id: null,
    availability: null,
    parent: null,
    children: [],
    prerequisites: [],
  };
  const latest = {
    activity_id: "a1",
    brief: { text: "Checkpoint", truncated: false },
    reported_at: "2026-11-04T00:00:00Z",
    updated_at: "2026-11-04T00:00:00Z",
    editing_agent: "agent",
    supporting_document_id: null,
  };
  bridge.invoke.mockResolvedValueOnce([{ ticket, latest_update: latest }]);
  const page = await client.findTickets(filter);
  expect(bridge.invoke).toHaveBeenCalledOnce();
  expect(bridge.invoke).toHaveBeenCalledWith("find_tickets_with_updates", {
    filter,
  });
  expect(page[0]?.progress_summary).toEqual(latest);
  bridge.invoke.mockResolvedValueOnce([
    { ticket, latest_update: { ...latest, brief: "invalid" } },
  ]);
  await expect(client.findTickets(filter)).rejects.toThrow();
});
