// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Backlinks } from "./Backlinks";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

test("lists each mention with its location and opens the source passage", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "ticket_backlinks")
      return [
        {
          source_reference: "T-KQ2",
          source_title: "Cache layer",
          activity_id: null,
          passage: "Blocked on T-KQ1 and T-KQ12.",
          mention_start: 11,
          mention_end: 14,
        },
        {
          source_reference: "T-KQ3",
          source_title: "Docs",
          activity_id: "n1",
          passage: "See T-KQ1 for context.",
          mention_start: 4,
          mention_end: 7,
        },
      ];
    if (command === "get_activity")
      return {
        id: "n1",
        ticket_id: "ticket",
        brief: "See T-KQ1 for context.",
        reported_at: "2026-10-31T10:00:00Z",
        updated_at: "2026-10-31T10:00:00Z",
        editing_agent: null,
      };
    throw new Error(`Unexpected ${command}`);
  });
  const select = vi.fn();
  render(<Backlinks reference="T-KQ1" revision={0} select={select} />);
  await screen.findByText("Cache layer");
  expect(screen.getByRole("heading", { name: /Mentioned in/ })).toBeTruthy();
  expect(screen.getByText("Description")).toBeTruthy();
  expect(await screen.findByText(/^Update · /)).toBeTruthy();
  // Only the whole reference is emphasized, not the prefix of T-KQ12.
  expect(
    screen
      .getAllByText("T-KQ1", { selector: "mark" })
      .map((mark) => mark.tagName),
  ).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: /T-KQ3/ }));
  expect(select).toHaveBeenCalledWith({
    reference: "T-KQ3",
    mentioned: "T-KQ1",
    noteId: "n1",
    passage: "See T-KQ1 for context.",
    start: 4,
    end: 7,
  });
});

test("finds Document mentions beyond the first hundred incoming links", async () => {
  const link = (index: number, kind: string) => ({
    source_id: `${kind}-${index}`,
    target_id: "ticket",
    source_kind: kind,
    target_kind: "ticket",
    passage: `Mentions T-KQ1 ${index}`,
    source_label: `${kind} ${index}`,
    target_label: "T-KQ1",
    source_trashed: false,
    target_trashed: false,
    activity_id: null,
  });
  bridge.invoke.mockImplementation(
    async (command: string, args?: { offset?: number }) => {
      if (command === "ticket_backlinks") return [];
      if (command === "document_context_links")
        return [
          [],
          args?.offset
            ? [link(1, "document")]
            : Array.from({ length: 100 }, (_, index) => link(index, "ticket")),
        ];
      throw new Error(`Unexpected ${command}`);
    },
  );
  render(
    <Backlinks
      reference="T-KQ1"
      ticketId="ticket"
      revision={0}
      select={vi.fn()}
    />,
  );
  expect(await screen.findByText("document 1")).toBeTruthy();
});
