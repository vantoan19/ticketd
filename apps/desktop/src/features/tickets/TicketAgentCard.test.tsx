// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChatClientContext, type ChatSummary } from "@/features/chats/client";
import { createHostChatClient } from "@/features/chats/host-client";
import {
  ChatFeatureContext,
  NO_CHAT_OVERVIEW,
} from "@/features/chats/use-chats";
import { ticketAgentFixtures } from "@/features/chats/ticket-agent-fixtures";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";
import { StatusLineRegion } from "@/components/ui/status-line";
import { isMacPlatform } from "@/lib/platform";
import { deferred } from "@/lib/workspace-reads/test-support";
import { TestReads } from "@/lib/workspace-reads/testing";
import type { Ticket } from "@/lib/api/client";
import { TicketDetails } from "./TicketDetails";
import { useLatestUpdateOf } from "./open-ticket";
import { ticketFor } from "./open-ticket/parts/ticket-fixture";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@uiw/react-codemirror", () => ({ default: () => null }));

const ticket = ticketFor("T-KQ29");
const main = ticketAgentFixtures().one[0]!;
const now = new Date().toISOString();
const tenMinutesAgo = new Date(Date.parse(now) - 600_000).toISOString();
const requestChat = vi.fn();
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
let linked: ChatSummary[];
let agents: ReturnType<typeof ticketAgentFixtures>["one"];
let items: object[];
let answer: Promise<null> | null;
let savedTicket: Promise<Ticket> | null;
let changedTicket: Ticket | null;

function summary(
  rank: ChatSummary["status"]["rank"],
  extra: Partial<ChatSummary> = {},
): ChatSummary {
  return {
    id: main.chat_id,
    title: main.chat_title,
    harness_id: main.harness_id,
    harness_name: main.harness_name,
    retention: "active",
    tickets: [{ reference: ticket.reference, status: ticket.status }],
    activity:
      rank === "working"
        ? "working"
        : rank === "failed"
          ? "interrupted"
          : "waiting",
    needs_you: rank === "approval" || rank === "question",
    updated_at: now,
    status: { rank, word: rank, unseen: false },
    muted: false,
    ...extra,
  };
}

const request = {
  id: "request-from-host",
  at: now,
  kind: "request",
  request: "approval",
  title: "Claude Code wants to",
  command: "npm test -- rate-limit",
  options: [
    { id: "host-once", label: "Allow once" },
    {
      id: "host-session",
      label: "Allow for this session",
      warning: "Future commands of this kind will run without asking first.",
    },
    { id: "host-deny", label: "Deny" },
  ],
  state: "pending",
};

beforeEach(() => {
  linked = [];
  agents = [];
  items = [];
  answer = null;
  savedTicket = null;
  changedTicket = null;
  requestChat.mockClear();
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      if (command === "change_ticket" && changedTicket) return changedTicket;
      if (command === "show_ticket" && changedTicket) return changedTicket;
      if (command === "show_ticket" && savedTicket) return savedTicket;
      if (command === "chat_harness_catalog") return [];
      if (command === "chat_ticket_agents") return agents;
      if (command === "chat_linked_to") return linked;
      if (command === "chat_open")
        return {
          subscription: 1,
          snapshot: {
            chat: {
              id: main.chat_id,
              title: main.chat_title,
              harness: { id: main.harness_id, name: main.harness_name },
              folder: {
                path: "/work/rate-limiter",
                name: "rate-limiter",
                managed: false,
                missing: false,
                shared_with: [],
              },
              activity: "waiting",
              retention: "active",
              steering: { available: false },
              links: [],
              queue: [],
              queue_paused: false,
              unseen: false,
              muted: false,
              has_composer: true,
            },
            items,
            cursor: 0,
          },
        };
      if (command === "chat_answer") return answer;
      if (command === "is_following") return false;
      if (command === "chat_close" || command === "reminder") return null;
      if (command === "latest_update")
        return {
          activity_id: "report",
          brief: { text: "Reviewed the rate limiter.", truncated: false },
          reported_at: now,
          updated_at: now,
          editing_agent: "codex",
          supporting_document_id: null,
        };
      return bridgeDefault(command, args);
    },
  );
});
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  expect(unknownCommands.splice(0)).toEqual([]);
});

function LatestUpdateRead({ reference }: { reference: string }) {
  const latest = useLatestUpdateOf(reference);
  return latest.current && <output>Latest update read</output>;
}

function open(record: Ticket, fromPreview = false) {
  const client = createHostChatClient({
    invoke: bridge.invoke,
    channel: () => null,
    listen: async () => () => {},
    pickFolder: async () => null,
    saveFile: async () => null,
    stored: { get: () => true, set: () => true },
  });
  const select = vi.fn();
  const view = (selection: string | null, revision: number) => (
    <ChatClientContext value={client}>
      <ChatFeatureContext
        value={{
          enabled: true,
          setEnabled: async () => {},
          overview: NO_CHAT_OVERVIEW,
          revision,
          openRequest: null,
          chatRequest: null,
          requestChat,
        }}
      >
        <TestReads {...(!fromPreview && { primed: { ticket: record } })}>
          {fromPreview && <LatestUpdateRead reference={record.reference} />}
          <StatusLineRegion>
            <TicketDetails
              mention={null}
              selected={selection}
              expanded={false}
              onExpand={vi.fn()}
              onReturn={vi.fn()}
              setSelected={select}
              opened={selection ? [selection] : []}
              onMentionReady={vi.fn()}
              onClearMention={vi.fn()}
              preview={fromPreview ? record : undefined}
              projects={[]}
              plans={[]}
            />
          </StatusLineRegion>
        </TestReads>
      </ChatFeatureContext>
    </ChatClientContext>
  );
  const mounted = render(view(record.reference, 0));
  return (revision: number, selection: string | null = record.reference) =>
    mounted.rerender(view(selection, revision));
}

test("a pending request replaces both working and ready for review, and answers only within the request", async () => {
  linked = [summary("approval")];
  agents = [{ ...main, approval: { summary: request.command } }];
  linked.push(summary("failed", { id: "stopped", interruption: "stopped" }));
  items = [request];
  open({ ...ticket, status: "In review" });
  const card = await screen.findByRole("region", {
    name: "Request from an agent",
  });
  expect(within(card).getByRole("alert").textContent).toContain(
    "Claude Opus 5.5 wants to run",
  );
  expect(within(card).queryByText(/working on this ticket/)).toBeNull();
  expect(screen.queryByRole("region", { name: "Ready for review" })).toBeNull();
  const deny = await within(card).findByRole("button", { name: "Deny" });
  expect(within(card).getByText(request.command)).toBeTruthy();
  expect(within(card).getByText("/work/rate-limiter")).toBeTruthy();
  const title = screen.getByRole("heading", { level: 1 });
  fireEvent.keyDown(title, { key: "3" });
  expect(bridge.invoke).not.toHaveBeenCalledWith(
    "chat_answer",
    expect.anything(),
  );
  deny.focus();
  fireEvent.keyDown(deny, { key: "3" });
  expect(bridge.invoke).toHaveBeenCalledWith("chat_answer", {
    chatId: main.chat_id,
    requestId: request.id,
    answer: { option_id: "host-deny" },
  });
});

test("a rejected answer keeps the chosen button focused and the same shortcut can retry", async () => {
  linked = [summary("approval")];
  agents = [{ ...main, approval: { summary: request.command } }];
  items = [{ ...request, folder: "/work/other-folder" }];
  const pending = deferred<null>();
  answer = pending.promise;
  open(ticket);
  const card = within(
    await screen.findByRole("region", { name: "Request from an agent" }),
  );
  const allow = await card.findByRole<HTMLButtonElement>("button", {
    name: "Allow in this Chat",
  });
  const deny = card.getByRole<HTMLButtonElement>("button", { name: "Deny" });
  expect(card.getByText("/work/other-folder")).toBeTruthy();
  expect(card.getByText(request.options[1]!.warning!)).toBeTruthy();
  deny.focus();
  fireEvent.keyDown(deny, { key: "2" });
  expect(document.activeElement).toBe(allow);
  expect(allow.getAttribute("aria-busy")).toBe("true");
  expect(allow.disabled).toBe(false);
  expect(deny.disabled).toBe(true);
  fireEvent.keyDown(allow, { key: "2" });
  await act(async () =>
    pending.reject({ code: "failed", message: "Could not answer" }),
  );
  expect(
    await card.findByText("Answer not sent · Pick again to retry"),
  ).toBeTruthy();
  expect(document.activeElement).toBe(allow);
  expect(deny.disabled).toBe(false);
  answer = null;
  fireEvent.keyDown(allow, { key: "2" });
  await waitFor(() =>
    expect(
      card.queryByText("Answer not sent · Pick again to retry"),
    ).toBeNull(),
  );
  const answers = bridge.invoke.mock.calls.filter(
    ([command]) => command === "chat_answer",
  );
  expect(answers).toEqual(
    Array.from({ length: 2 }, () => [
      "chat_answer",
      {
        chatId: main.chat_id,
        requestId: request.id,
        answer: { option_id: "host-session" },
      },
    ]),
  );
});

test("the agent’s question opens its Chat and is answered there", async () => {
  linked = [summary("question")];
  items = [
    {
      ...request,
      request: "question",
      subject: "Which release are we targeting?",
    },
  ];
  open(ticket);
  const card = within(
    await screen.findByRole("region", { name: "Request from an agent" }),
  );
  expect(await card.findByText("Which release are we targeting?")).toBeTruthy();
  expect(card.queryByRole("button", { name: "Allow once" })).toBeNull();
  fireEvent.click(card.getByRole("button", { name: "Open Chat" }));
  expect(requestChat).toHaveBeenCalledWith({
    kind: "open",
    chatId: main.chat_id,
    retention: "active",
    from: ticket.reference,
  });
});

test("working shows the report, current step, and other agents; O opens the main Chat", async () => {
  agents = ticketAgentFixtures().many;
  linked = [summary("working")];
  open({ ...ticket, status: "In review" });
  const card = within(
    await screen.findByRole("region", { name: "Agents on this ticket" }),
  );
  const working = card.getByRole("status");
  expect(working.getAttribute("aria-live")).toBe("polite");
  expect(working.textContent).toContain(
    "Claude Opus 5.5 and 3 others are working on this ticket",
  );
  expect(working.textContent).toContain("Waiting for 2 sub-agents");
  expect(working.textContent).toMatch(/1m 3[1-9]s/);
  expect(card.getByText(/Last report/).textContent).toContain("from codex");
  expect(card.getByRole("button", { name: "Show" })).toBeTruthy();
  const openChat = card.getByRole("button", { name: "Open Chat" });
  openChat.focus();
  fireEvent.keyDown(openChat, { key: "o" });
  expect(requestChat).toHaveBeenCalledWith({
    kind: "open",
    chatId: main.chat_id,
    retention: "active",
    from: ticket.reference,
  });
  const trigger = card.getByRole("button", { name: "3 others" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(screen.getByRole("menuitem", { name: /Claude Sonnet 5.5/ }));
  expect(requestChat).toHaveBeenLastCalledWith({
    kind: "open",
    chatId: main.chat_id,
    retention: "active",
    from: ticket.reference,
    subAgent: "sa-tests",
  });
});

test("a stopped agent takes precedence over working and keeps a path to its Chat", async () => {
  linked = [
    summary("working"),
    summary("failed", {
      id: "stopped",
      interruption: "stopped",
      model: "GPT-6.2",
    }),
  ];
  agents = [main];
  open({ ...ticket, status: "In review" });
  const card = within(
    await screen.findByRole("region", { name: "Agents on this ticket" }),
  );
  expect(card.getByText("GPT-6.2 stopped")).toBeTruthy();
  expect(card.queryByRole("status")).toBeNull();
  fireEvent.click(card.getByRole("button", { name: "Open Chat" }));
  expect(requestChat).toHaveBeenLastCalledWith(
    expect.objectContaining({ chatId: "stopped" }),
  );
});

test("a running turn with ten silent minutes shows the quiet state ahead of working", async () => {
  linked = [
    summary("working", {
      turn_running: true,
      updated_at: tenMinutesAgo,
      model: "Claude Opus 5.5",
    }),
  ];
  agents = [main];
  open({ ...ticket, status: "In progress" });
  const card = within(
    await screen.findByRole("region", { name: "Agents on this ticket" }),
  );
  expect(
    card.getByText("No word from Claude Opus 5.5 for 10 min"),
  ).toBeTruthy();
  expect(card.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("region", { name: "Latest update" })).toBeNull();
});

test("a fresh update after a silent turn returns the card to Working, then Ready for review", async () => {
  linked = [
    summary("working", {
      turn_running: true,
      updated_at: tenMinutesAgo,
    }),
  ];
  agents = [main];
  const refresh = open({ ...ticket, status: "In review" });
  await screen.findByText(/^No word from/);
  linked = [summary("working", { turn_running: true })];
  refresh(1);
  await screen.findByText(/is working on this ticket/);
  linked = [summary("done")];
  agents = [];
  refresh(2);
  expect(
    await screen.findByRole("region", { name: "Ready for review" }),
  ).toBeTruthy();
});

test.each(["Todo", "Done", "Canceled", "Trash"])(
  "a %s ticket has a card when it opens with live work",
  async (status) => {
    agents = [main];
    open({
      ...ticket,
      status: status === "Trash" ? "Todo" : status,
      trashed: status === "Trash",
    });
    expect(
      await screen.findByRole("region", { name: "Agents on this ticket" }),
    ).toBeTruthy();
  },
);

test("working, questions, and approvals stay in the header when the ticket opened without a card", async () => {
  const reopen = open(ticket);
  await waitFor(() =>
    expect(
      screen.queryByRole("status", { name: "Loading ticket agent context" }),
    ).toBeNull(),
  );
  agents = [main];
  reopen(1);
  await screen.findByRole("status", { name: "Working" });
  fireEvent.keyDown(screen.getByRole("button", { name: "Copy reference" }), {
    key: "o",
  });
  expect(requestChat).toHaveBeenCalledWith(
    expect.objectContaining({ chatId: main.chat_id }),
  );
  expect(
    screen.queryByRole("region", { name: "Agents on this ticket" }),
  ).toBeNull();
  agents = [];
  linked = [summary("question")];
  items = [{ ...request, request: "question", subject: "Which release?" }];
  reopen(2);
  const question = await screen.findByRole("button", {
    name: "Review request",
  });
  expect(question.textContent).toBe("Question");
  expect(question.getAttribute("aria-description")).toBe("Question");
  fireEvent.click(question);
  expect(requestChat).toHaveBeenLastCalledWith(
    expect.objectContaining({ chatId: main.chat_id }),
  );
  agents = [{ ...main, approval: { summary: request.command } }];
  linked = [summary("approval")];
  items = [request];
  reopen(3);
  await within(question).findByText("Approval needed");
  expect(question.getAttribute("aria-description")).toBe("Approval needed");
  expect(
    screen.queryByRole("region", { name: "Request from an agent" }),
  ).toBeNull();
  await act(async () => reopen(3, null));
  reopen(3);
  expect(
    await screen.findByRole("region", { name: "Request from an agent" }),
  ).toBeTruthy();
});

test("a stale Todo preview cannot keep a review ticket's later request out of its card", async () => {
  const pending = deferred<Ticket>();
  savedTicket = pending.promise;
  const refresh = open(ticket, true);
  expect(
    screen.getByRole("heading", { name: ticket.title, level: 1 }),
  ).toBeTruthy();
  await screen.findByText("Latest update read");
  expect(
    screen.getByRole("status", { name: "Loading ticket agent context" }),
  ).toBeTruthy();

  await act(async () => pending.resolve({ ...ticket, status: "In review" }));
  await screen.findByRole("region", { name: "Ready for review" });
  linked = [summary("approval")];
  items = [request];
  refresh(1);
  expect(
    await screen.findByRole("region", { name: "Request from an agent" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Review request" })).toBeNull();
});

test("review shortcuts work from a focused button in the ticket header", async () => {
  open({ ...ticket, status: "In review" });
  await screen.findByRole("region", { name: "Ready for review" });
  const headerControl = screen.getByRole("button", { name: "Copy reference" });
  headerControl.focus();
  fireEvent.keyDown(headerControl, { key: "b" });
  const reason = await screen.findByRole("textbox", {
    name: "What needs to change?",
  });
  expect(document.activeElement).toBe(reason);
  fireEvent.keyDown(reason, { key: "Escape" });
  changedTicket = { ...ticket, status: "Done", status_history_number: 8 };
  headerControl.focus();
  fireEvent.keyDown(headerControl, {
    key: "Enter",
    ...(isMacPlatform() ? { metaKey: true } : { ctrlKey: true }),
  });
  expect(await screen.findByText("Done · just now · by you")).toBeTruthy();
});

test("an approval arriving after a review decision takes the card while Undo remains available", async () => {
  const reopen = open({ ...ticket, status: "In review" });
  const move = await screen.findByRole("button", { name: "Move to Done" });
  changedTicket = { ...ticket, status: "Done", status_history_number: 8 };
  fireEvent.click(move);
  await screen.findByText("Done · just now · by you");

  linked = [summary("approval")];
  items = [request];
  reopen(1);
  const card = await screen.findByRole("region", {
    name: "Request from an agent",
  });
  expect(
    await within(card).findByRole("button", { name: "Allow once" }),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();

  linked = [summary("done")];
  reopen(2);
  expect(await screen.findByText("Done · just now · by you")).toBeTruthy();
});
