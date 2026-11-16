// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { Backlinks } from "./Backlinks";
import { TestOpenTicket } from "./open-ticket/testing";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
const ticket = { id: "ticket", reference: "T-KQ1", trashed: false } as Ticket;
function backlinks(select = vi.fn()) {
  return (
    <TestOpenTicket ticket={ticket}>
      <Backlinks select={select} />
    </TestOpenTicket>
  );
}
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
  render(backlinks(select));
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
  render(backlinks());
  expect(await screen.findByText("document 1")).toBeTruthy();
  // Page 0 is the read Files shares; only the pages after it are read here.
  expect(
    bridge.invoke.mock.calls.filter(
      ([command, args]) =>
        command === "document_context_links" && args.offset === 0,
    ),
  ).toHaveLength(1);
});

test("pages through backlinks by window, keeping the shown window while the next one loads", async () => {
  const link = (index: number) => ({
    source_reference: `T-S${index}`,
    source_title: `Source ${index}`,
    activity_id: null,
    passage: "Mentions T-KQ1",
    mention_start: 9,
    mention_end: 14,
  });
  let release: () => void = () => {};
  bridge.invoke.mockImplementation(
    async (command: string, args?: { offset?: number }) => {
      if (command === "ticket_backlinks") {
        if (args?.offset) {
          await new Promise<void>((resolve) => (release = resolve));
          return [link(99)];
        }
        return Array.from({ length: 20 }, (_, index) => link(index));
      }
      if (command === "document_context_links") return [[], []];
      throw new Error(`Unexpected ${command}`);
    },
  );
  render(backlinks());
  fireEvent.click(
    await screen.findByRole("button", { name: "More backlinks" }),
  );
  // The first window stays until the next arrives, so nothing jumps.
  expect(screen.getByText("Source 0")).toBeTruthy();
  release();
  expect(await screen.findByText("Source 99")).toBeTruthy();
  expect(screen.queryByText("Source 0")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Previous backlinks" }));
  expect(await screen.findByText("Source 0")).toBeTruthy();
});
