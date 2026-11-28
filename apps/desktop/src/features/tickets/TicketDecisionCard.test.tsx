// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";
import { TestOpenTicket } from "./open-ticket/testing";
import { StatusLineRegion } from "@/components/ui/status-line";
import { ChatClientContext } from "@/features/chats/client";
import { chatState, createMockChatClient } from "@/features/chats/mock-client";
import { isMacPlatform } from "@/lib/platform";
import type { Evidence, Ticket } from "@/lib/api/client";
import { TicketPage } from "./TicketPage";
import { AgentContext } from "./ticket-agent-context";
import type { TicketAgentState } from "./ticket-agent-state";
import { applyTokens, instantTokens, rootTokens } from "@/test/motion-tokens";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const review: Ticket = {
  id: "review",
  reference: "T-KQ1",
  title: "Ship the rail",
  body: "## Draft\n\n- [x] An unrelated task\n\n## How would you know it worked?\n\n- [x] One\n- [ ] Two\n\n## Links\n\n- [x] Another unrelated task",
  status: "In review",
  status_history_number: 7,
  trashed: false,
  tags: [],
  project_id: null,
  plan_id: null,
  availability: null,
  parent: null,
  children: [],
  prerequisites: [],
};

let ticket: Ticket;
let latest: ReturnType<typeof update> | null;
let evidence: { items: Evidence[]; total: number; proof: Evidence[] };
let writeFailure: string | null;
let reportFailure: string | null;
let candidates: Ticket[];
function update(text: string): {
  activity_id: string;
  brief: { text: string; truncated: boolean };
  reported_at: string;
  updated_at: string;
  editing_agent: string | null;
  supporting_document_id: null;
} {
  return {
    activity_id: "report",
    brief: { text, truncated: false },
    reported_at: "2026-11-28T03:00:00Z",
    updated_at: "2026-11-28T03:00:00Z",
    editing_agent: "codex",
    supporting_document_id: null,
  };
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  ticket = review;
  latest = update("Implemented the rail.");
  evidence = { items: [], total: 0, proof: [] };
  writeFailure = null;
  reportFailure = null;
  candidates = [];
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "show_ticket")
      return (
        candidates.find(
          ({ reference }) =>
            reference === (args as { reference: string }).reference,
        ) ?? ticket
      );
    if (command === "latest_update") {
      if (reportFailure)
        throw { code: reportFailure, message: "Cannot read report." };
      return latest;
    }
    if (command === "ticket_evidence_page") return evidence;
    if (command === "contextual_relationships" && ticket.prerequisites.length) {
      const base = bridgeDefault(command) as {
        relationships: Record<string, unknown>;
      };
      return {
        relationships: {
          ...base.relationships,
          prerequisites: {
            items: ticket.prerequisites.map((blocker) => ({
              ...blocker,
              title: { text: blocker.title },
            })),
            next_offset: null,
          },
        },
      };
    }
    if (command === "change_ticket") {
      if (writeFailure) throw { code: writeFailure, message: "Cannot write." };
      const patch = (
        args as {
          patch: {
            status: string;
            expected_status: string;
            expected_status_history_number?: number;
          };
        }
      ).patch;
      if (
        ticket.status !== patch.expected_status ||
        (patch.expected_status_history_number !== undefined &&
          patch.expected_status_history_number !==
            (ticket.status_history_number ?? 0))
      )
        throw { code: "conflict", message: "This ticket has changed." };
      ticket = {
        ...ticket,
        status: patch.status,
        status_history_number: (ticket.status_history_number ?? 0) + 1,
      };
      return ticket;
    }
    if (command === "send_back") {
      if (writeFailure) throw { code: writeFailure, message: "Cannot write." };
      const { brief, expectedStatusHistoryNumber } = args as {
        brief: string;
        expectedStatusHistoryNumber?: number;
      };
      if (
        ticket.status !== "In review" ||
        (expectedStatusHistoryNumber !== undefined &&
          expectedStatusHistoryNumber !== (ticket.status_history_number ?? 0))
      )
        throw { code: "conflict", message: "This ticket has changed." };
      latest = {
        ...update(brief),
        activity_id: "send-back",
        editing_agent: null,
      };
      ticket = {
        ...ticket,
        status: "In progress",
        status_history_number: (ticket.status_history_number ?? 0) + 1,
      };
      return ticket;
    }
    if (command === "undo_send_back") {
      latest = update("Implemented the rail.");
      ticket = { ...ticket, status: "In review" };
      return ticket;
    }
    if (command === "add_activity_with_details") {
      if (writeFailure) throw { code: writeFailure, message: "Cannot write." };
      const { brief } = args as { brief: string };
      latest = update(brief);
      return {
        id: latest.activity_id,
        ticket_id: ticket.id,
        brief,
        reported_at: latest.reported_at,
        updated_at: latest.updated_at,
        editing_agent: null,
        supporting_document_id: null,
      };
    }
    if (command === "is_following") return false;
    if (command === "reminder") return null;
    return bridgeDefault(command, args as { reference?: string });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  bridge.invoke.mockReset();
  expect(unknownCommands.splice(0)).toEqual([]);
});

function open(select = vi.fn(), reviewQueue = [ticket]) {
  candidates = reviewQueue.filter(
    ({ reference }) => reference !== ticket.reference,
  );
  return render(ticketView(select, reviewQueue));
}

function ticketView(
  select: (reference: string | null) => void,
  reviewQueue: Ticket[],
  readReviewQueue = async () => reviewQueue,
  agentState: TicketAgentState | null = null,
) {
  return (
    <StatusLineRegion>
      <TestOpenTicket ticket={ticket}>
        <AgentContext.Provider
          value={
            agentState && {
              reference: ticket.reference,
              openedWithCard: true,
              ready: true,
              state: agentState,
              update: null,
            }
          }
        >
          <TicketPage
            active
            readReviewQueue={readReviewQueue}
            projects={[]}
            plans={[]}
            select={select}
            noteTarget={null}
            mention={null}
            onMention={vi.fn()}
          />
        </AgentContext.Provider>
      </TestOpenTicket>
    </StatusLineRegion>
  );
}

test("a report read failure offers Retry without claiming there is no report", async () => {
  reportFailure = "failed";
  open();
  const card = within(
    await screen.findByRole("region", { name: "Ready for review" }),
  );
  expect(await card.findByText("Couldn't load the latest update")).toBeTruthy();
  expect(card.queryByText("No report yet")).toBeNull();
  reportFailure = null;
  fireEvent.click(card.getByRole("button", { name: "Retry" }));
  expect(await card.findByText("Implemented the rail.")).toBeTruthy();
});

test("a reviewer reads the latest report and jumps to the acceptance checklist", async () => {
  open();
  const card = within(
    await screen.findByRole("region", { name: "Ready for review" }),
  );
  expect(await card.findByText("Implemented the rail.")).toBeTruthy();
  expect(card.getByText("codex")).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Acceptance 1 of 2" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "How would you know it worked?" }),
    ),
  );
});

test("a review decision uses the current status, stays on the ticket and offers Undo", async () => {
  const select = vi.fn();
  open(select);
  fireEvent.click(await screen.findByRole("button", { name: "Move to Done" }));
  const card = await screen.findByRole("region", { name: "Done" });
  expect(within(card).getByText("Done · just now · by you")).toBeTruthy();
  expect(document.activeElement).toBe(
    within(card).getByText("Nothing else in review"),
  );
  expect(screen.getByText("Moved T-KQ1 to Done")).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
  expect(bridge.invoke).toHaveBeenCalledWith("change_ticket", {
    reference: "T-KQ1",
    patch: {
      expected_status: "In review",
      expected_status_history_number: 7,
      status: "Done",
    },
    requestId: expect.any(String),
  });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(
    await screen.findByRole("region", { name: "Ready for review" }),
  ).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("change_ticket", {
    reference: "T-KQ1",
    patch: {
      expected_status: "Done",
      expected_status_history_number: 8,
      status: "In review",
    },
    requestId: expect.any(String),
  });
});

test("Reply posts an update in the card and keeps the ticket In progress", async () => {
  ticket = { ...review, status: "In progress" };
  open();
  const card = within(
    await screen.findByRole("region", { name: "Latest update" }),
  );
  expect(card.queryByText("Acceptance 1 of 2")).toBeNull();
  fireEvent.click(card.getByRole("button", { name: "Reply" }));
  const field = card.getByRole("textbox", { name: "Reply" });
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, {
    target: { value: "Please include the screenshots." },
  });
  fireEvent.click(card.getByRole("button", { name: "Post update" }));
  expect(await card.findByText("Please include the screenshots.")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Status: In progress" }),
  ).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("add_activity_with_details", {
    reference: "T-KQ1",
    brief: "Please include the screenshots.",
    details: null,
    existingDocumentId: null,
    requestId: expect.any(String),
  });
});

test("a successful Reply retry leaves a newer draft open", async () => {
  ticket = { ...review, status: "In progress" };
  writeFailure = "failed";
  open();
  const card = within(
    await screen.findByRole("region", { name: "Latest update" }),
  );
  fireEvent.click(card.getByRole("button", { name: "Reply" }));
  const field = card.getByRole("textbox", { name: "Reply" });
  fireEvent.change(field, { target: { value: "First reply" } });
  fireEvent.click(card.getByRole("button", { name: "Post update" }));
  const retry = await screen.findByRole("button", { name: "Retry" });
  fireEvent.change(field, { target: { value: "New draft" } });

  writeFailure = null;
  fireEvent.click(retry);
  expect(await card.findByText("First reply")).toBeTruthy();
  expect(card.getByRole("textbox", { name: "Reply" })).toHaveProperty(
    "value",
    "New draft",
  );
  const writes = bridge.invoke.mock.calls.filter(
    ([command]) => command === "add_activity_with_details",
  );
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

test.each(["Todo", "Done", "Canceled", "Duplicate", "Trash"])(
  "the review and update cards stay out of %s",
  async (status) => {
    ticket = {
      ...review,
      status: status === "Trash" ? "In review" : status,
      trashed: status === "Trash",
    };
    open();
    await screen.findByText("How would you know it worked?");
    expect(
      screen.queryByRole("region", {
        name: /Ready for review|Latest update|Done/,
      }),
    ).toBeNull();
  },
);

test("an unreported review is still actionable and has no empty acceptance count", async () => {
  latest = null;
  ticket = {
    ...review,
    body: `## Acceptance criteria

A paragraph without a checklist.`,
  };
  open();
  const card = within(
    await screen.findByRole("region", { name: "Ready for review" }),
  );
  expect(await card.findByText("No report yet")).toBeTruthy();
  expect(card.queryByRole("button", { name: /Acceptance/ })).toBeNull();
  expect(card.getByRole("button", { name: "Move to Done" })).toBeTruthy();
});

test("Show more expands a long report where the reviewer is reading", async () => {
  latest = update(`First line.

Second line.

Third line.

Fourth line.

Fifth line.`);
  // JSDOM does no layout. Supply a rendered height equivalent to five lines.
  const height = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockReturnValue(100);
  try {
    open();
    const card = within(
      await screen.findByRole("region", { name: "Ready for review" }),
    );
    const more = await card.findByRole("button", { name: "Show more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(
      card
        .getByRole("button", { name: "Show less" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(card.getByText("Fifth line.")).toBeTruthy();
  } finally {
    height.mockRestore();
  }
});

test("review proof leads with the pull request, then verification, then more evidence", async () => {
  const proof = (
    kind: Evidence["kind"],
    name: string,
    value: string,
  ): Evidence => ({
    id: name,
    kind,
    name,
    value,
    created_at: "2026-11-28T03:00:00Z",
    updated_at: "2026-11-28T03:00:00Z",
    editing_agent: null,
  });
  const pr = proof(
    "pull_request",
    "PR #23",
    "https://github.com/example/project/pull/23",
  );
  const checked = proof("verification", "Regression suite", "23 tests passed.");
  const branch = proof("branch", "Implementation branch", "feature/review");
  const commit = proof("commit", "Merge commit", "c0ffee");
  evidence = {
    items: [branch, commit, checked, pr],
    total: 4,
    proof: [pr, checked],
  };
  open();
  const group = within(
    await screen.findByRole("group", { name: "Review evidence" }),
  );
  expect(
    group
      .getByRole("link", { name: "PR #23" })
      .compareDocumentPosition(
        group.getByRole("button", { name: "Regression suite" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(group.getByRole("button", { name: "Regression suite" }));
  expect(
    within(
      await screen.findByRole("dialog", { name: "Regression suite" }),
    ).getByText("23 tests passed."),
  ).toBeTruthy();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  fireEvent.click(group.getByRole("button", { name: "+2 evidence" }));
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Evidence 4" }),
  );
  expect(
    screen
      .getByRole("button", { name: /1 more/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

test("a successful decision suggests the next In review ticket, wrapping at the end", async () => {
  const select = vi.fn();
  const ahead = { ...review, reference: "T-KQ2" };
  const behind = { ...review, reference: "T-KQ3" };
  const other = { ...review, reference: "T-KQ4", status: "Todo" };
  open(select, [ahead, other, behind, review]);
  fireEvent.click(await screen.findByRole("button", { name: "Move to Done" }));
  const next = await screen.findByRole("link", { name: "Next to review" });
  expect(document.activeElement).toBe(next);
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(next);
  await waitFor(() => expect(select).toHaveBeenCalledWith("T-KQ2"));
});

test("Next to review checks the suggested ticket again before opening it", async () => {
  const select = vi.fn();
  open(select, [review, { ...review, reference: "T-KQ2" }]);
  fireEvent.click(await screen.findByRole("button", { name: "Move to Done" }));
  const next = await screen.findByRole("link", { name: "Next to review" });
  candidates = [{ ...review, reference: "T-KQ2", status: "Done" }];
  next.focus();
  fireEvent.click(next);
  const stale = await screen.findByText("T-KQ2 is no longer in review");
  expect(document.activeElement).toBe(stale);
  expect(select).not.toHaveBeenCalled();
  expect(screen.queryByRole("link", { name: "Next to review" })).toBeNull();
});

test("a pending review decision preserves focus moved to another control", async () => {
  let finish!: () => void;
  const write = new Promise<void>((resolve) => (finish = resolve));
  const invoke = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "change_ticket") await write;
    return invoke(command, args);
  });
  open();
  const move = await screen.findByRole("button", { name: "Move to Done" });
  move.focus();
  fireEvent.click(move);
  await waitFor(() => expect(move.getAttribute("aria-busy")).toBe("true"));
  const title = screen.getByRole("textbox", { name: "Title" });
  title.focus();
  finish();
  expect(await screen.findByText("Nothing else in review")).toBeTruthy();
  expect(document.activeElement).toBe(title);
});

test("decision focus hands off after a request that hid the result clears", async () => {
  let finish!: () => void;
  const write = new Promise<void>((resolve) => (finish = resolve));
  const invoke = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "change_ticket") await write;
    return invoke(command, args);
  });
  const queue = [review, { ...review, reference: "T-KQ2" }];
  const select = vi.fn();
  const chat = createMockChatClient({
    chats: [{ chat: chatState({ id: "question", title: "Review question" }) }],
  });
  const page = (request?: TicketAgentState) => (
    <ChatClientContext value={chat}>
      {ticketView(select, queue, undefined, request)}
    </ChatClientContext>
  );
  const view = render(page());
  const move = await screen.findByRole("button", { name: "Move to Done" });
  move.focus();
  fireEvent.click(move);
  await waitFor(() => expect(move.getAttribute("aria-busy")).toBe("true"));
  view.rerender(
    page({
      kind: "request",
      request: "question",
      target: { chatId: "question", retention: "active" },
    }),
  );
  finish();
  await screen.findByText("Moved T-KQ1 to Done");
  expect(
    screen.getByRole("region", { name: "Request from an agent" }),
  ).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Next to review" })).toBeNull();
  view.rerender(page());
  const next = await screen.findByRole("link", { name: "Next to review" });
  expect(document.activeElement).toBe(next);
});

test("a failed queue read leaves the review decision available and reports the failure", async () => {
  const readReviewQueue = vi
    .fn()
    .mockRejectedValue(new Error("Queue unavailable"));
  render(ticketView(vi.fn(), [ticket], readReviewQueue));
  fireEvent.click(await screen.findByRole("button", { name: "Move to Done" }));
  const card = within(await screen.findByRole("region", { name: "Done" }));
  expect(card.queryByText("Nothing else in review")).toBeNull();
  expect(document.activeElement).toBe(
    card.getByText("Couldn't check what else is in review"),
  );
});

test("the shortcut skips a text field and a decision picks the later review before wrapping", async () => {
  const select = vi.fn();
  const earlier = { ...review, reference: "T-KQ2" };
  const later = { ...review, reference: "T-KQ3" };
  const todo = { ...review, reference: "T-KQ4", status: "Todo" };
  open(select, [earlier, review, todo, later]);
  const shortcut = {
    key: "Enter",
    ...(isMacPlatform() ? { metaKey: true } : { ctrlKey: true }),
  };
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Title" }), shortcut);
  expect(
    bridge.invoke.mock.calls.some(([command]) => command === "change_ticket"),
  ).toBe(false);
  fireEvent.keyDown(
    screen.getByRole("heading", { name: "Ready for review" }),
    shortcut,
  );
  fireEvent.click(await screen.findByRole("link", { name: "Next to review" }));
  await waitFor(() => expect(select).toHaveBeenCalledWith("T-KQ3"));
});

test("a rejected write keeps the report and Retry repeats the same decision", async () => {
  writeFailure = "failed";
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Move to Done" }));
  expect(await screen.findByText(/Couldn't move T-KQ1 to Done/)).toBeTruthy();
  expect(screen.getByRole("region", { name: "Ready for review" })).toBeTruthy();
  const first = bridge.invoke.mock.calls.find(
    ([command]) => command === "change_ticket",
  )?.[1];
  writeFailure = null;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("region", { name: "Done" })).toBeTruthy();
  expect(
    bridge.invoke.mock.calls
      .filter(([command]) => command === "change_ticket")
      .at(-1)?.[1],
  ).toEqual(first);
});

test("the write refuses when the ticket was moved elsewhere first", async () => {
  open();
  const move = await screen.findByRole("button", { name: "Move to Done" });
  ticket = { ...review, status: "In progress" };
  fireEvent.click(move);
  expect(
    await screen.findByText(/changed elsewhere since it was loaded/),
  ).toBeTruthy();
  expect(
    await screen.findByRole("region", { name: "Latest update" }),
  ).toBeTruthy();
  expect(screen.queryByText("Moved T-KQ1 to Done")).toBeNull();
});

test("a GitHub-owned review opens at its source", async () => {
  const url = "https://github.com/acme/api/issues/98";
  ticket = {
    ...review,
    source: {
      provider: "github",
      provider_name: "GitHub",
      place: "acme/api",
      number: "#98",
      status_choices: ["Todo", "In progress", "In review"],
      id: "42",
      locator: "acme/api#98",
      display: "acme/api#98",
      url,
      origin: "imported",
      ownership: "external",
      state: { category: "open", name: "Open" },
      closure_unrecognized: false,
      last_refreshed_at: null,
      last_attempt_at: null,
      last_error: null,
      content_locked: true,
      status_locked: false,
      duplicate_target: null,
    },
  };
  open();
  const card = within(
    await screen.findByRole("region", { name: "Ready for review" }),
  );
  expect(
    card.getByRole("link", { name: "Open on GitHub" }).getAttribute("href"),
  ).toBe(url);
  expect(card.queryByRole("button", { name: "Move to Done" })).toBeNull();
  fireEvent.click(card.getByRole("button", { name: "Send back" }));
  expect(await card.findByText("Not posted to GitHub")).toBeTruthy();
});

test("the review names open blockers and opens the same list as the context line", async () => {
  ticket = {
    ...review,
    prerequisites: [
      {
        reference: "T-KQ2",
        title: "Waiting for artwork",
        status: "Todo",
        trashed: false,
        unresolved: true,
      },
      {
        reference: "T-KQ3",
        title: "Final copy",
        status: "Done",
        trashed: false,
        unresolved: false,
      },
    ],
  };
  const select = vi.fn();
  open(select);
  const card = within(
    await screen.findByRole("region", { name: "Ready for review" }),
  );
  fireEvent.click(card.getByRole("button", { name: "1 blocker still open" }));
  const blockers = within(
    await screen.findByRole("dialog", { name: "Blockers" }),
  );
  expect(blockers.getByText("1 of 2 still open")).toBeTruthy();
  fireEvent.click(
    blockers.getByRole("button", { name: /Waiting for artwork/ }),
  );
  expect(select).toHaveBeenCalledWith("T-KQ2");
});

test("Send back keeps its draft after Escape and reopening, then sends and offers Undo", async () => {
  const select = vi.fn();
  const queued = [ticket, { ...review, reference: "T-KQ2" }];
  const view = open(select, queued);
  const report = await screen.findByRole("heading", {
    name: "Ready for review",
  });
  fireEvent.keyDown(report, { key: "b" });
  const field = await screen.findByRole("textbox", {
    name: "What needs to change?",
  });
  expect(document.activeElement).toBe(field);
  expect(field.getAttribute("placeholder")).toBe(
    "What needs to change? codex reads this next.",
  );
  expect(screen.getByText("Moves the ticket to In progress")).toBeTruthy();
  fireEvent.change(field, { target: { value: "Handle a narrow window." } });
  fireEvent.keyDown(field, { key: "Escape" });
  const sendBack = screen.getByRole("button", { name: "Send back" });
  expect(document.activeElement).toBe(sendBack);
  expect(
    screen.queryByRole("textbox", { name: "What needs to change?" }),
  ).toBeNull();
  view.unmount();
  open(select, queued);
  fireEvent.click(await screen.findByRole("button", { name: "Send back" }));
  const reopened = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "What needs to change?",
  });
  expect(reopened.value).toBe("Handle a narrow window.");
  fireEvent.keyDown(reopened, {
    key: "Enter",
    [isMacPlatform() ? "metaKey" : "ctrlKey"]: true,
  });
  const sent = await screen.findByRole("region", { name: "Sent back" });
  expect(within(sent).getByText("Sent back · waiting for codex")).toBeTruthy();
  expect(within(sent).getByText("Handle a narrow window.")).toBeTruthy();
  expect(document.activeElement).toBe(
    within(sent).getByRole("link", { name: "Next to review" }),
  );
  expect(select).not.toHaveBeenCalled();
  expect(screen.getByText("Sent T-KQ1 back to In progress")).toBeTruthy();
  const send = bridge.invoke.mock.calls.find(
    ([command]) => command === "send_back",
  );
  expect(send?.[1]).toEqual({
    reference: "T-KQ1",
    brief: "Handle a narrow window.",
    expectedStatusHistoryNumber: 7,
    requestId: expect.any(String),
  });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(
    await screen.findByRole("region", { name: "Ready for review" }),
  ).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("undo_send_back", {
    reference: "T-KQ1",
    sendRequestId: send?.[1].requestId,
    requestId: expect.any(String),
  });
});

test("Next to review keeps focus when motion resumes after a keyboard Send back", async () => {
  const queued = [ticket, { ...review, reference: "T-KQ2" }];
  const select = vi.fn();
  const restore = applyTokens({ ...rootTokens, ...instantTokens });
  try {
    const view = open(select, queued);
    fireEvent.click(await screen.findByRole("button", { name: "Send back" }));
    const field = await screen.findByRole("textbox", {
      name: "What needs to change?",
    });
    fireEvent.change(field, { target: { value: "Please verify the retry." } });
    fireEvent.keyDown(field, {
      key: "Enter",
      [isMacPlatform() ? "metaKey" : "ctrlKey"]: true,
    });
    const next = await screen.findByRole("link", { name: "Next to review" });
    expect(document.activeElement).toBe(next);

    applyTokens(rootTokens);
    view.rerender(ticketView(select, queued));
    expect(document.activeElement).toBe(next);
    expect(screen.getByText("Please verify the retry.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  } finally {
    restore();
  }
});

test("a failed Send back keeps the draft and Retry repeats the same write", async () => {
  writeFailure = "failed";
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Send back" }));
  const field = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "What needs to change?",
  });
  fireEvent.change(field, { target: { value: "Add one more example." } });
  fireEvent.click(screen.getByRole("button", { name: "Send back" }));
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(field.value).toBe("Add one more example.");
  writeFailure = null;
  fireEvent.click(retry);
  await screen.findByRole("region", { name: "Sent back" });
  const writes = bridge.invoke.mock.calls.filter(
    ([command]) => command === "send_back",
  );
  expect(writes).toHaveLength(2);
  expect(writes[0]).toEqual(writes[1]);
});

test("Retry sends the edited Send back draft with a new request ID", async () => {
  writeFailure = "failed";
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Send back" }));
  const field = screen.getByRole("textbox", { name: "What needs to change?" });
  fireEvent.change(field, { target: { value: "First reason" } });
  fireEvent.click(screen.getByRole("button", { name: "Send back" }));
  const retry = await screen.findByRole("button", { name: "Retry" });
  fireEvent.change(field, { target: { value: "Revised reason" } });

  writeFailure = null;
  fireEvent.click(retry);
  const decision = within(
    await screen.findByRole("region", { name: "Sent back" }),
  );
  expect(decision.getByText("Revised reason")).toBeTruthy();
  const writes = bridge.invoke.mock.calls.filter(
    ([command]) => command === "send_back",
  );
  expect(writes).toHaveLength(2);
  expect(writes[1]?.[1]).toMatchObject({ brief: "Revised reason" });
  expect(writes[1]?.[1].requestId).not.toBe(writes[0]?.[1].requestId);
});

test("Send back refreshes a ticket that left review without posting its draft", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Send back" }));
  const field = await screen.findByRole("textbox", {
    name: "What needs to change?",
  });
  fireEvent.change(field, { target: { value: "Use a shorter title." } });
  ticket = { ...ticket, status: "In progress" };
  fireEvent.click(screen.getByRole("button", { name: "Send back" }));
  const latest = await screen.findByRole("region", { name: "Latest update" });
  expect(within(latest).getByText("Implemented the rail.")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Sent back" })).toBeNull();
});

test.each(["Move to Done", "Send back"])(
  "%s does not decide a newer review the person did not see",
  async (action) => {
    open();
    const button = await screen.findByRole("button", { name: action });
    if (action === "Send back") {
      fireEvent.click(button);
      fireEvent.change(
        screen.getByRole("textbox", { name: "What needs to change?" }),
        { target: { value: "A change requested in the earlier review." } },
      );
    }
    ticket = { ...ticket, title: "A new review", status_history_number: 10 };
    fireEvent.click(screen.getByRole("button", { name: action }));

    expect(await screen.findByText(/It changed elsewhere/)).toBeTruthy();
    expect(ticket.status).toBe("In review");
    expect(screen.getByRole("heading", { name: "A new review" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  },
);

test("a saved Send back note can be submitted in a new review with a new request", async () => {
  ticket = { ...review, status_history_number: 10 };
  const brief = "Please verify keyboard focus.";
  localStorage.setItem(
    "ticketd:send-back:review",
    JSON.stringify({ brief, requestId: "first-review", reviewNumber: 7 }),
  );
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Send back" }));
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "What needs to change?",
    }).value,
  ).toBe(brief);
  fireEvent.click(screen.getByRole("button", { name: "Send back" }));
  await screen.findByRole("region", { name: "Sent back" });
  const write = bridge.invoke.mock.calls.find(
    ([command]) => command === "send_back",
  );
  expect(write?.[1]).toMatchObject({ brief, expectedStatusHistoryNumber: 10 });
  expect(write?.[1].requestId).not.toBe("first-review");
});

test("Retry does not show an older Send back as a decision in the current review", async () => {
  const invoke = bridge.invoke.getMockImplementation()!;
  let outcome: Ticket | undefined;
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command !== "send_back") return invoke(command, args);
    if (outcome) return outcome;
    outcome = await invoke(command, args);
    ticket = { ...review, status_history_number: 10 };
    throw { code: "failed", message: "Reply interrupted after commit." };
  });
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Send back" }));
  fireEvent.change(
    screen.getByRole("textbox", { name: "What needs to change?" }),
    { target: { value: "Feedback for the previous review." } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send back" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect(await screen.findByText(/It changed elsewhere/)).toBeTruthy();
  expect(screen.queryByText("Sent T-KQ1 back to In progress")).toBeNull();
  expect(screen.queryByRole("region", { name: "Sent back" })).toBeNull();
  expect(ticket.status).toBe("In review");
});

test.each(["add menu", "blockers popover"])(
  "B opens the blocker picker inside the %s on a ticket in review",
  async (surface) => {
    ticket = {
      ...review,
      prerequisites: [
        {
          reference: "T-KQ2",
          title: "Waiting for artwork",
          status: "Todo",
          trashed: false,
          unresolved: true,
        },
      ],
    };
    open();
    await screen.findByRole("button", { name: "Send back" });
    if (surface === "add menu") {
      fireEvent.keyDown(
        screen.getByRole("button", { name: "Add ticket property" }),
        { key: "Enter" },
      );
      fireEvent.keyDown(
        await screen.findByRole("menuitem", { name: "Blocked by…" }),
        { key: "b" },
      );
    } else {
      fireEvent.click(
        await screen.findByRole("button", { name: "1 blocker still open" }),
      );
      const blockers = within(
        await screen.findByRole("dialog", { name: "Blockers" }),
      );
      fireEvent.keyDown(
        blockers.getByRole("button", { name: "Add a blocker" }),
        { key: "b" },
      );
    }
    expect(
      await screen.findByRole("dialog", { name: "Link a ticket" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "What needs to change?" }),
    ).toBeNull();
  },
);
