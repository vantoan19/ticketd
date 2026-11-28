// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatClientContext } from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import { useChatFeature } from "@/features/chats/use-chats";
import type { ChatRequest } from "@/features/chats/ticket-chat";
import {
  createMockChatClient,
  type MockChat,
} from "@/features/chats/mock-client";
import {
  codexChat,
  subAgentFixtures,
} from "@/features/chats/sub-agent-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
afterEach(cleanup);

/** Stands in for the ticket page: asks Chat to open an agent. */
function Asker({
  request,
  label = "Ask to open",
}: {
  request: ChatRequest;
  label?: string;
}) {
  const { requestChat } = useChatFeature();
  return (
    <button type="button" onClick={() => requestChat(request)}>
      {label}
    </button>
  );
}

function show(chat: MockChat, request: ChatRequest, then?: ChatRequest) {
  const client = createMockChatClient({ enabled: true, chats: [chat] });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <Asker request={request} />
        {then && <Asker request={then} label="Then ask to open the Chat" />}
        <ChatsView />
      </ChatProvider>
    </ChatClientContext>,
  );
  return client;
}

/** Asks once Chat is on and its list is read: a request before that is dropped. */
async function ask(title: string) {
  await screen.findByRole("button", { name: new RegExp(`^${title}`) });
  fireEvent.click(screen.getByRole("button", { name: "Ask to open" }));
}

test("opening a sub-agent from outside lands in its view, and Back returns to the Chat", async () => {
  const chat = subAgentFixtures().running;
  show(chat, {
    kind: "open",
    chatId: chat.chat.id,
    retention: "active",
    from: "T-KQ29",
    subAgent: "sa-tests",
  });
  await ask(chat.chat.title);
  expect(
    await screen.findByRole("heading", { name: "Check limiter test coverage" }),
  ).toBeTruthy();
  // The Chat stays selected in the list while its sub-agent's view is open.
  const selected = screen
    .getAllByRole("button")
    .find((one) => one.getAttribute("aria-current") === "true");
  expect(selected?.textContent).toContain(chat.chat.title);
  const pane = screen
    .getByRole("heading", { name: "Check limiter test coverage" })
    .closest("section") as HTMLElement;
  fireEvent.click(
    within(pane).getByRole("button", { name: new RegExp(chat.chat.title) }),
  );
  const heading = await screen.findByRole("heading", { name: chat.chat.title });
  expect(heading).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Check limiter test coverage" }),
  ).toBeNull();
  // Back from the Chat still goes to the ticket it was opened from.
  expect(screen.getByRole("button", { name: /T-KQ29/ })).toBeTruthy();
});

test("a nested sub-agent opens with its parent in the crumbs", async () => {
  const chat = codexChat();
  show(chat, {
    kind: "open",
    chatId: chat.chat.id,
    retention: "active",
    subAgent: "sa-pay-tests",
  });
  await ask(chat.chat.title);
  const heading = await screen.findByRole("heading", {
    name: "Run the payment tests",
  });
  const pane = heading.closest("section") as HTMLElement;
  expect(
    within(pane).getByRole("button", { name: /Update the refund calls/ }),
  ).toBeTruthy();
  fireEvent.click(
    within(pane).getByRole("button", { name: /Update the refund calls/ }),
  );
  expect(
    await screen.findByRole("heading", { name: "Update the refund calls" }),
  ).toBeTruthy();
});

test("opening the Chat itself leaves a sub-agent's view", async () => {
  const chat = subAgentFixtures().running;
  const base = {
    kind: "open",
    chatId: chat.chat.id,
    retention: "active",
  } as const;
  show(chat, { ...base, subAgent: "sa-tests" }, base);
  await ask(chat.chat.title);
  await screen.findByRole("heading", { name: "Check limiter test coverage" });
  fireEvent.click(
    screen.getByRole("button", { name: "Then ask to open the Chat" }),
  );
  expect(
    await screen.findByRole("heading", { name: chat.chat.title }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Check limiter test coverage" }),
  ).toBeNull();
});

test("a notification for the Chat leaves a sub-agent's view for the Chat", async () => {
  const chat = subAgentFixtures().running;
  const client = show(chat, {
    kind: "open",
    chatId: chat.chat.id,
    retention: "active",
    subAgent: "sa-tests",
  });
  await ask(chat.chat.title);
  await screen.findByRole("heading", { name: "Check limiter test coverage" });
  act(() => client.requestOpen({ chat_id: chat.chat.id, retention: "active" }));
  expect(
    await screen.findByRole("heading", { name: chat.chat.title }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Check limiter test coverage" }),
  ).toBeNull();
});

test("a sub-agent the Chat does not know leaves the Chat open", async () => {
  const chat = subAgentFixtures().running;
  show(chat, {
    kind: "open",
    chatId: chat.chat.id,
    retention: "active",
    subAgent: "sa-gone",
  });
  await ask(chat.chat.title);
  expect(
    await screen.findByRole("heading", { name: chat.chat.title }),
  ).toBeTruthy();
});
