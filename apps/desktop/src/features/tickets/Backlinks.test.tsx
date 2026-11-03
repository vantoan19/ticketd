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
          source_reference: "T-2",
          source_title: "Cache layer",
          activity_id: null,
          passage: "Blocked on T-1 and T-12.",
          mention_start: 11,
          mention_end: 14,
        },
        {
          source_reference: "T-3",
          source_title: "Docs",
          activity_id: "n1",
          passage: "See T-1 for context.",
          mention_start: 4,
          mention_end: 7,
        },
      ];
    if (command === "get_activity")
      return {
        id: "n1",
        ticket_id: "ticket",
        brief: "See T-1 for context.",
        reported_at: "2026-10-31T10:00:00Z",
        updated_at: "2026-10-31T10:00:00Z",
        editing_agent: null,
      };
    throw new Error(`Unexpected ${command}`);
  });
  const select = vi.fn();
  render(<Backlinks reference="T-1" revision={0} select={select} />);
  await screen.findByText("Cache layer");
  expect(screen.getByRole("heading", { name: /Mentioned in/ })).toBeTruthy();
  expect(screen.getByText("Description")).toBeTruthy();
  expect(await screen.findByText(/^Update · /)).toBeTruthy();
  // Only the whole reference is emphasized, not the prefix of T-12.
  expect(
    screen
      .getAllByText("T-1", { selector: "mark" })
      .map((mark) => mark.tagName),
  ).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: /T-3/ }));
  expect(select).toHaveBeenCalledWith({
    reference: "T-3",
    mentioned: "T-1",
    noteId: "n1",
    passage: "See T-1 for context.",
    start: 4,
    end: 7,
  });
});
