// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ChatClientContext } from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import { createMockChatClient } from "@/features/chats/mock-client";
import { subAgentFixtures } from "@/features/chats/sub-agent-fixtures";
import { ticketAgentsSchema } from "@/features/chats/ticket-agents";
import sent from "@/features/chats/ticket-agents-command.fixture.json";
import { bridgeDefault } from "@/test/bridge-defaults";
import { TestReads } from "@/lib/workspace-reads/testing";
import { TicketDetails } from "./TicketDetails";
import { ticketFor } from "./open-ticket/parts/ticket-fixture";

// What `chat_ticket_agents` sends for a Chat that works on the ticket with a credited
// sub-agent: the Rust test `the_command_sends_what_the_desktops_label_reads` holds the
// file to the real command's output.
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
afterEach(cleanup);

const ticket = ticketFor("T-KQ29");

test("what the command sends reads as the label and a sub-agent's name opens its view", async () => {
  bridge.invoke.mockImplementation(bridgeDefault);
  const user = userEvent.setup();
  const agents = ticketAgentsSchema.parse(sent);
  const chat = subAgentFixtures().running;
  expect(agents.map((agent) => agent.chat_id)).toEqual([
    chat.chat.id,
    chat.chat.id,
  ]);
  const client = createMockChatClient({
    enabled: true,
    chats: [chat],
    ticketAgents: { [ticket.id]: agents },
  });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <TestReads primed={{ ticket }}>
          <TicketDetails
            mention={null}
            selected={ticket.reference}
            expanded={false}
            onExpand={vi.fn()}
            onReturn={vi.fn()}
            setSelected={vi.fn()}
            opened={[ticket.reference]}
            onMentionReady={vi.fn()}
            onClearMention={vi.fn()}
            projects={[]}
            plans={[]}
          />
        </TestReads>
        <ChatsView />
      </ChatProvider>
    </ChatClientContext>,
  );

  const strip = await screen.findByRole("region", {
    name: "Agents on this ticket",
  });
  expect(strip.textContent).toContain(
    "Claude Opus 5.5 and Claude Sonnet 5.5 are working on this ticket",
  );
  await user.click(
    within(strip).getByRole("button", {
      name: "Claude Sonnet 5.5, open sub-agent Check limiter test coverage",
    }),
  );

  expect(
    await screen.findByRole("heading", { name: "Check limiter test coverage" }),
  ).toBeTruthy();
});
