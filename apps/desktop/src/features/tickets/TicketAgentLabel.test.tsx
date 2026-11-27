// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChatClientContext } from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { createMockChatClient } from "@/features/chats/mock-client";
import { ticketAgentFixtures } from "@/features/chats/ticket-agent-fixtures";
import { useChatFeature } from "@/features/chats/use-chats";
import { TestReads } from "@/lib/workspace-reads/testing";
import { TicketAgentSession, TicketAgentStrip } from "./TicketAgent";
import { ticketFor } from "./open-ticket/parts/ticket-fixture";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
beforeEach(() => bridge.invoke.mockResolvedValue(null));
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

const ticket = ticketFor("T-KQ29");

/** What the ticket asked Chat to open, as the Chats screen would read it. */
function Asked() {
  const { chatRequest } = useChatFeature();
  return (
    <output aria-label="asked">
      {JSON.stringify(chatRequest?.request ?? null)}
    </output>
  );
}

function open(agents = ticketAgentFixtures().one) {
  const client = createMockChatClient({
    enabled: true,
    ticketAgents: { [ticket.id]: agents },
  });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <TestReads primed={{ ticket }}>
          <TicketAgentSession ticket={ticket}>
            {(loading) => (
              <>
                <output aria-label="agent state">
                  {loading ? "loading" : "ready"}
                </output>
                <TicketAgentStrip reference={ticket.reference} />
                <Asked />
              </>
            )}
          </TicketAgentSession>
        </TestReads>
      </ChatProvider>
    </ChatClientContext>,
  );
  return client;
}

const label = async () => screen.findByRole("status", { name: "Ticket agent" });
const asked = () =>
  JSON.parse(screen.getByLabelText("asked").textContent ?? "null");

test("one agent: its model, what it is doing, and Open Chat", async () => {
  open(ticketAgentFixtures().one);
  const strip = await label();
  expect(strip.getAttribute("aria-live")).toBe("polite");
  expect(strip.getAttribute("aria-atomic")).toBe("true");
  expect(strip.textContent).toContain(
    "Claude Opus 5.5 is working on this ticket",
  );
  expect(strip.textContent).toContain("Waiting for 2 sub-agents");
  // The clock is for the eye: it is not read.
  expect(
    strip.querySelector('.text-muted-foreground[aria-hidden="true"]')
      ?.textContent,
  ).toMatch(/· 1m \d+s/);
  within(strip).getByRole("button", { name: "Open Chat" });
});

test("a sub-agent alone is named by its model and its title", async () => {
  open(ticketAgentFixtures().subAgent);
  const strip = await label();
  expect(strip.textContent).toContain(
    "Claude Sonnet 5.5 is working on this ticket · Check limiter test coverage",
  );
});

test("two agents are both named", async () => {
  open(ticketAgentFixtures().two);
  const strip = await label();
  expect(strip.textContent).toContain(
    "Claude Opus 5.5 and Claude Sonnet 5.5 are working on this ticket",
  );
  within(strip).getByRole("button", {
    name: "Claude Sonnet 5.5, open sub-agent Check limiter test coverage",
  });
});

test("from three, the rest are a menu with a row per agent", async () => {
  const user = userEvent.setup();
  open(ticketAgentFixtures().many);
  const strip = await label();
  expect(strip.textContent).toContain(
    "Claude Opus 5.5 and 3 others are working on this ticket",
  );
  const others = within(strip).getByRole("button", { name: "3 others" });
  expect(others.getAttribute("aria-haspopup")).toBe("menu");
  await user.click(others);
  const rows = await screen.findAllByRole("menuitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringMatching(
      /^Claude Sonnet 5\.5.*Check limiter test coverage · sub-agent in Review the rate limiter$/,
    ),
    expect.stringMatching(/^GPT-6\.2.*Add rate-limit headers to the SDK$/),
    expect.stringMatching(
      /^GPT-6\.2 mini.*Update the SDK docs · sub-agent in Add rate-limit headers to the SDK$/,
    ),
  ]);
  await user.click(rows[0]!);
  expect(asked()).toMatchObject({
    kind: "open",
    chatId: "c-limiter",
    subAgent: "sa-tests",
    from: "T-KQ29",
  });
});

test("a main agent's name opens its Chat, a sub-agent's name its view", async () => {
  const user = userEvent.setup();
  open(ticketAgentFixtures().two);
  const strip = await label();
  await user.click(
    within(strip).getByRole("button", {
      name: "Claude Opus 5.5, open its Chat",
    }),
  );
  expect(asked()).toEqual({
    kind: "open",
    chatId: "c-limiter",
    retention: "active",
    from: "T-KQ29",
  });
  await user.click(
    within(strip).getByRole("button", {
      name: "Claude Sonnet 5.5, open sub-agent Check limiter test coverage",
    }),
  );
  expect(asked().subAgent).toBe("sa-tests");
  await user.click(within(strip).getByRole("button", { name: "Open Chat" }));
  expect(asked().subAgent).toBeUndefined();
});

test("a sub-agent's request names it, shows the command and opens its view to review", async () => {
  const user = userEvent.setup();
  open(ticketAgentFixtures().approval);
  const strip = await label();
  expect(strip.textContent).toContain("Claude Sonnet 5.5 wants to run");
  expect(strip.querySelector("code")?.textContent).toBe(
    "npm test -- rate-limit",
  );
  expect(within(strip).queryByText(/is working on this ticket/)).toBeNull();
  await user.click(
    within(strip).getByRole("button", { name: "Review request" }),
  );
  expect(asked().subAgent).toBe("sa-tests");
});

test("the label goes when the work ends, and comes back with new work", async () => {
  const client = open(ticketAgentFixtures().one);
  const strip = await label();
  expect(strip.textContent).toContain("is working on this ticket");
  await act(async () => client.setTicketAgents(ticket.id, []));
  await vi.waitFor(() =>
    expect(strip.textContent).not.toContain("is working on this ticket"),
  );
  expect(within(strip).queryByRole("button", { name: /Open Chat/ })).toBeNull();
  await act(async () =>
    client.setTicketAgents(ticket.id, ticketAgentFixtures().two),
  );
  await vi.waitFor(() =>
    expect(strip.textContent).toContain("are working on this ticket"),
  );
});

test("a request that arrives while the ticket is open takes the slot, so its sentence shows and Review request opens the sub-agent", async () => {
  const user = userEvent.setup();
  const client = open([]);
  await screen.findByText("ready");
  expect(screen.queryByRole("status", { name: "Ticket agent" })).toBeNull();
  await act(async () =>
    client.setTicketAgents(ticket.id, ticketAgentFixtures().approval),
  );
  const strip = await label();
  expect(strip.textContent).toContain("wants to run");
  await user.click(
    within(strip).getByRole("button", { name: "Review request" }),
  );
  expect(asked().subAgent).toBe("sa-tests");
});

test("a ticket nobody works on has no label", async () => {
  open([]);
  await screen.findByText("ready");
  expect(screen.queryByRole("status", { name: "Ticket agent" })).toBeNull();
});

test("an Activity row's credit chip gives way with an ellipsis, so it never sits under the time or Latest", () => {
  // Every part of the author line keeps its width but the chip (T-UB282, F-A5).
  const css = readFileSync(join(__dirname, "activity.css"), "utf8");
  expect(css).toMatch(/\.activity-author > \* \{\s*flex: none/);
  expect(css).toMatch(
    /\.activity-author > \.activity-subagent \{\s*flex: 0 1 auto/,
  );
  expect(css).toMatch(
    /\.activity-subagent > span \{[^}]*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap/,
  );
});

test("the label's own clock uses tabular figures, like every other sub-agent clock", async () => {
  open(ticketAgentFixtures().one);
  const strip = await label();
  const clock = strip.querySelector('[aria-hidden="true"].ticket-agent-clock');
  expect(clock?.textContent).toMatch(/· 1m \d+s/);
  const css = readFileSync(join(__dirname, "properties.css"), "utf8");
  expect(css).toMatch(
    /\.ticket-agent-clock \{[^}]*font-variant-numeric: tabular-nums/,
  );
});
