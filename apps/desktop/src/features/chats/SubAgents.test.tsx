// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatClientContext } from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import {
  createMockChatClient,
  type MockChat,
} from "@/features/chats/mock-client";
import {
  antigravityChat,
  codexChat,
  failedChat,
  subAgentFixtures,
} from "@/features/chats/sub-agent-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(cleanup);

async function open(chat: MockChat) {
  const client = createMockChatClient({ enabled: true, chats: [chat] });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <ChatsView />
      </ChatProvider>
    </ChatClientContext>,
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: new RegExp(`^${chat.chat.title}`),
    }),
  );
  await screen.findByRole("heading", { name: chat.chat.title });
  return client;
}

const row = (name: RegExp | string) =>
  screen.getByRole("button", { name: name });

test("a Chat shows one row per direct sub-agent, with its state, and none of its work", async () => {
  await open(subAgentFixtures().finished);
  expect(row("Sub-agent Find limiter bypasses, finished, 2m 40s")).toBeTruthy();
  expect(
    row("Sub-agent Check limiter test coverage, finished, 4m"),
  ).toBeTruthy();
  expect(row("Sub-agent Proofread the API docs, finished, 1m 4s")).toBeTruthy();
  // Rows stay under the folded turn, and the sub-agents' own steps are not in the Chat.
  expect(screen.queryByText(/x-api-key/)).toBeNull();
  expect(screen.queryByText(/The key lookup returns early/)).toBeNull();
});

test("running, failed, stopped, lost and resumed rows say so in their suffix", async () => {
  await open(subAgentFixtures().running);
  const running = row(/^Sub-agent Find limiter bypasses, working, 2m/);
  expect(running.getAttribute("data-running")).toBe("");
  expect(running.textContent).toMatch(/Find limiter bypasses · 2m \d+s/);
  cleanup();
  await open(subAgentFixtures().stopped);
  expect(row(/^Sub-agent Find limiter bypasses, stopped/).textContent).toBe(
    "Find limiter bypasses · Stopped",
  );
  cleanup();
  await open(subAgentFixtures().lost);
  expect(
    row(/^Sub-agent Find limiter bypasses, contact lost/).textContent,
  ).toBe("Find limiter bypasses · Contact lost");
  cleanup();
  await open(subAgentFixtures().resumed);
  expect(
    screen
      .getAllByRole("button", { name: /^Sub-agent Find limiter bypasses/ })
      .map((one) => one.textContent),
  ).toEqual([
    "Find limiter bypasses · Contact lost",
    expect.stringMatching(/^Find limiter bypasses · Resumed · \d+s$/),
  ]);
  cleanup();
  await open(failedChat());
  expect(row(/^Sub-agent Review the retry backoff, failed/).textContent).toBe(
    "Review the retry backoff · Failed",
  );
});

test("Antigravity's sub-agent ends with the turn", async () => {
  await open(antigravityChat());
  expect(
    row(/^Sub-agent Scan the session routes, ended with the turn/).textContent,
  ).toBe("Scan the session routes · Ended with the turn");
});

test("only direct sub-agents are rows in the Chat", async () => {
  await open(codexChat());
  expect(
    screen.getByRole("button", { name: /^Sub-agent Update the refund calls/ }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /Run the payment tests/ }),
  ).toBeNull();
});

test("Enter opens a sub-agent's view: the path back, the brief, its own work and no composer", async () => {
  await open(subAgentFixtures().finished);
  fireEvent.click(row(/^Sub-agent Find limiter bypasses/));
  const heading = await screen.findByRole("heading", {
    name: "Find limiter bypasses",
  });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(
    screen.getByRole("button", { name: "Back to Review the rate limiter" }),
  ).toBeTruthy();
  expect(
    screen.getByText("Asked by the main agent · Explore · Claude Haiku 5.5"),
  ).toBeTruthy();
  expect(
    screen.getByText(/^Find every way a request could get past/),
  ).toBeTruthy();
  // Its own work, and its result as the final response.
  expect(screen.getByText(/^Found one way around the limiter/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /^Worked for 2m 40s/ }),
  ).toBeTruthy();
  // Not the main agent's, not a composer, no Chat actions.
  const pane = within(
    screen.getByRole("region", { name: "Find limiter bypasses" }),
  );
  expect(pane.queryByText(/I started three reviewers/)).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Chat actions" })).toBeNull();
  expect(screen.getByRole("button", { name: "Close Chat" })).toBeTruthy();
});

test("Back, Esc and Cmd+[ return to the Chat with the row focused, and Esc stops nothing", async () => {
  const client = await open(subAgentFixtures().running);
  const stop = vi.spyOn(client, "stop");
  for (const leave of [
    () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Back to Review the rate limiter" }),
      ),
    () =>
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      }),
    () =>
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "[",
        metaKey: true,
      }),
  ]) {
    fireEvent.click(row(/^Sub-agent Check limiter test coverage/));
    await screen.findByRole("heading", { name: "Check limiter test coverage" });
    leave();
    await screen.findByRole("heading", { name: "Review the rate limiter" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        row(/^Sub-agent Check limiter test coverage/),
      ),
    );
  }
  expect(stop).not.toHaveBeenCalled();
});

test("how a sub-agent ended is said under its last words", async () => {
  const states = subAgentFixtures();
  await open(states.stopped);
  fireEvent.click(row(/^Sub-agent Find limiter bypasses/));
  await screen.findByRole("heading", { name: "Find limiter bypasses" });
  expect(screen.getByText("You stopped it.")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Stopped after/ })).toBeTruthy();
  cleanup();
  await open(states.stopped);
  fireEvent.click(row(/^Sub-agent Check limiter test coverage/));
  await screen.findByRole("heading", { name: "Check limiter test coverage" });
  expect(screen.getByText("The main agent stopped it.")).toBeTruthy();
  cleanup();
  await open(states.stoppedByTicketd);
  fireEvent.click(row(/^Sub-agent Find limiter bypasses/));
  await screen.findByRole("heading", { name: "Find limiter bypasses" });
  expect(screen.getByText("Stopped when Chat was turned off.")).toBeTruthy();
  cleanup();
  await open(states.stoppedByTicketd);
  fireEvent.click(row(/^Sub-agent Check limiter test coverage/));
  await screen.findByRole("heading", { name: "Check limiter test coverage" });
  expect(screen.getByText("ticketd stopped it.")).toBeTruthy();
  cleanup();
  await open(states.lost);
  fireEvent.click(row(/^Sub-agent Find limiter bypasses/));
  await screen.findByRole("heading", { name: "Find limiter bypasses" });
  expect(
    screen.getByText(
      "Contact lost when ticketd quit. Claude Code can resume it.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /^Contact lost after/ }),
  ).toBeTruthy();
  cleanup();
  await open(failedChat());
  fireEvent.click(row(/^Sub-agent Review the retry backoff/));
  await screen.findByRole("heading", { name: "Review the retry backoff" });
  expect(screen.getByRole("button", { name: /^Failed after/ })).toBeTruthy();
  expect(
    screen.getByText(
      /^This sub-agent failed\. Claude Code ended it with an error/,
    ),
  ).toBeTruthy();
});

test("a resumed sub-agent shows its runs, split by a quiet line", async () => {
  await open(subAgentFixtures().resumed);
  fireEvent.click(
    screen.getAllByRole("button", {
      name: /^Sub-agent Check limiter test coverage/,
    })[1]!,
  );
  await screen.findByRole("heading", { name: "Check limiter test coverage" });
  expect(
    screen.getByRole("separator", { name: "Resumed by the main agent" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /^Contact lost after/ }),
  ).toBeTruthy();
  // No "Contact lost when ticketd quit" line while its second run goes on.
  expect(screen.queryByText(/Contact lost when ticketd quit/)).toBeNull();
});

test("a nested sub-agent opens from its parent's view with the whole path back, and Codex says what it does not report", async () => {
  await open(codexChat());
  fireEvent.click(row(/^Sub-agent Update the refund calls/));
  await screen.findByRole("heading", { name: "Update the refund calls" });
  fireEvent.click(row(/^Sub-agent Run the payment tests/));
  const heading = await screen.findByRole("heading", {
    name: "Run the payment tests",
  });
  expect(
    screen.getByRole("button", { name: "Back to Upgrade the payment client" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Back to Update the refund calls" }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Asked by the sub-agent Update the refund calls · GPT-6.2",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText("Codex doesn't report what a sub-agent was asked."),
  ).toBeTruthy();
  expect(heading).toBeTruthy();
  // One step back goes to the parent, with its row focused.
  fireEvent.click(
    screen.getByRole("button", { name: "Back to Update the refund calls" }),
  );
  await screen.findByRole("heading", { name: "Update the refund calls" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      row(/^Sub-agent Run the payment tests/),
    ),
  );
});

test("Antigravity's view says what ticketd cannot show", async () => {
  await open(antigravityChat());
  fireEvent.click(row(/^Sub-agent Scan the session routes/));
  await screen.findByRole("heading", { name: "Scan the session routes" });
  expect(
    screen.getByText(
      "Antigravity doesn't report a sub-agent's messages or when it finishes, and can't stop one alone. ticketd shows its steps and counts it as ended when the turn ends.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /^Ended with the turn after 2m/ }),
  ).toBeTruthy();
});

test("a sub-agent just started says it is starting, and a running one has no tray until something needs it", async () => {
  const states = subAgentFixtures();
  await open(states.running);
  fireEvent.click(row(/^Sub-agent Check limiter test coverage/));
  await screen.findByRole("heading", { name: "Check limiter test coverage" });
  expect(document.querySelector(".chat-tray")).toBeNull();
  expect(within(document.body).queryByRole("textbox")).toBeNull();
});
