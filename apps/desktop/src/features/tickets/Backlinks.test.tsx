// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { Backlinks, type MentionTarget } from "./Backlinks";
import { useOpenTicket } from "./open-ticket";
import { TestOpenTicket } from "./open-ticket/testing";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
const ticket = { id: "ticket", reference: "T-KQ1", trashed: false } as Ticket;
function BacklinksPanel({
  select,
}: {
  select: (target: MentionTarget) => void;
}) {
  const mentions = useOpenTicket("backlinks");
  const documentLinks = useOpenTicket("documentBacklinks");
  return (
    <Backlinks
      select={select}
      mentions={mentions}
      documentLinks={documentLinks}
    />
  );
}

function backlinks(select = vi.fn()) {
  return (
    <TestOpenTicket ticket={ticket}>
      <BacklinksPanel select={select} />
    </TestOpenTicket>
  );
}
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  localStorage.clear();
});

const passage = (text: string, activityId: string | null = null) => ({
  activity_id: activityId,
  reported_at: activityId ? "2026-10-31T10:00:00Z" : null,
  passage: text,
  mention_start: 4,
  mention_end: 9,
});
const mention = (
  index: number,
  passages = [passage("See T-KQ1 for context.")],
) => ({
  reference: `T-REF${index}`,
  title: `Source ${index}`,
  status: "In review",
  mentioned_at: "2026-10-31T10:00:00Z",
  passages,
});

test("mentions start closed, reveal three tickets and keep them when showing more", async () => {
  bridge.invoke.mockImplementation(
    async (command: string, args?: { offset?: number }) => {
      if (command === "ticket_backlinks")
        return {
          items: args?.offset
            ? [mention(1)]
            : [
                mention(4, [
                  passage("See T-KQ1 and T-KQ12.", "n1"),
                  passage("See T-KQ1 for other context."),
                ]),
                mention(3),
                mention(2),
              ],
          total: 4,
        };
      if (command === "document_context_links") return [[], []];
      throw new Error(`Unexpected ${command}`);
    },
  );
  const select = vi.fn();
  render(backlinks(select));
  const group = await screen.findByRole("button", {
    name: /Mentioned in 4 tickets/,
    expanded: false,
  });
  expect(screen.queryByRole("button", { name: /Source 4/ })).toBeNull();
  fireEvent.click(group);
  expect(
    screen.getByText("Tickets whose text names T-KQ1, newest first"),
  ).toBeTruthy();
  expect(screen.getAllByRole("img", { name: "In review" })).toHaveLength(3);
  const highlights = screen.getAllByText("T-KQ1", { selector: "mark" });
  expect(highlights).toHaveLength(4);
  fireEvent.click(screen.getByRole("button", { name: /See T-KQ1 and T-KQ12/ }));
  expect(select).toHaveBeenCalledWith({
    reference: "T-REF4",
    mentioned: "T-KQ1",
    noteId: "n1",
    passage: "See T-KQ1 and T-KQ12.",
    start: 4,
    end: 9,
  });
  fireEvent.click(screen.getByRole("button", { name: "Show 1 more" }));
  await screen.findByRole("button", { name: /Source 1/ });
  expect(screen.getByRole("button", { name: /Source 4/ })).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("ticket_backlinks", {
    reference: "T-KQ1",
    limit: 3,
    offset: 3,
  });
  expect(bridge.invoke).not.toHaveBeenCalledWith(
    "get_activity",
    expect.anything(),
  );
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
      if (command === "ticket_backlinks") return { items: [], total: 0 };
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
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Mentioned in/,
      expanded: false,
    }),
  );
  expect(await screen.findByText("document 1")).toBeTruthy();
  // Page 0 is the read Files shares; only the pages after it are read here.
  expect(
    bridge.invoke.mock.calls.filter(
      ([command, args]) =>
        command === "document_context_links" && args.offset === 0,
    ),
  ).toHaveLength(1);
});
