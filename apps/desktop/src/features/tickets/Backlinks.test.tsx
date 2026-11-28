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
      if (command === "ticket_document_mentions")
        return { items: [], total: 0 };
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

test("a failed later Document mention page keeps the first page and retries that read", async () => {
  const link = (index: number) => ({
    source_id: `document-${index}`,
    passage: `Mentions T-KQ1 ${index}`,
    source_label: `Document ${index}`,
    source_trashed: false,
  });
  let unavailable = true;
  bridge.invoke.mockImplementation(
    async (command: string, args?: { offset?: number }) => {
      if (command === "ticket_backlinks") return { items: [], total: 0 };
      if (command === "ticket_document_mentions") {
        if (args?.offset && unavailable)
          throw { code: "failed", message: "Document page unavailable" };
        return {
          items: args?.offset ? [link(4)] : [link(1), link(2), link(3)],
          total: 4,
        };
      }
      throw new Error(`Unexpected ${command}`);
    },
  );
  render(backlinks());
  fireEvent.click(await screen.findByRole("button", { name: /Mentioned in/ }));
  expect(await screen.findByText("Document 1")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Show 1 more Document mentions" }),
  );
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.getByText("Document 1")).toBeTruthy();
  unavailable = false;
  fireEvent.click(retry);
  expect(await screen.findByText("Document 4")).toBeTruthy();
  expect(screen.getByText("Document 1")).toBeTruthy();
  expect(bridge.invoke).toHaveBeenLastCalledWith("ticket_document_mentions", {
    reference: "T-KQ1",
    limit: 3,
    offset: 3,
  });
});

test("one mentioning ticket can reveal passages beyond the first three", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "ticket_backlinks")
      return {
        items: [
          {
            ...mention(2, [
              passage("First T-KQ1", "n1"),
              passage("Second T-KQ1", "n2"),
              passage("Third T-KQ1", "n3"),
            ]),
            next_offset: 3,
          },
        ],
        total: 1,
      };
    if (command === "ticket_document_mentions") return { items: [], total: 0 };
    if (command === "ticket_mention_passages")
      return {
        items: [passage("Fourth T-KQ1", "n4")],
        next_offset: null,
      };
    throw new Error(`Unexpected ${command}`);
  });
  render(backlinks());
  fireEvent.click(
    await screen.findByRole("button", { name: /Mentioned in 1 ticket/ }),
  );
  expect(screen.queryByRole("button", { name: /Fourth T-KQ1/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Show more passages/ }));
  expect(
    await screen.findByRole("button", { name: /Fourth T-KQ1/ }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: /Third T-KQ1/ })).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("ticket_mention_passages", {
    reference: "T-KQ1",
    sourceReference: "T-REF2",
    limit: 3,
    offset: 3,
  });
});
