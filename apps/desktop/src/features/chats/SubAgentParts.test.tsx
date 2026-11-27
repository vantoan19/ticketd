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
import { subAgentPartFixtures } from "@/features/chats/sub-agent-part-fixtures";

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

const fixtures = () => subAgentPartFixtures();

test("while sub-agents run after the reply, one pill counts them in the tray", async () => {
  await open(fixtures().reply);
  const pill = screen.getByRole("button", { name: "2 sub-agents running" });
  expect(pill.getAttribute("aria-haspopup")).toBe("dialog");
  expect(pill.getAttribute("aria-expanded")).toBe("false");
  // The strip is the only live signal: no working line, and the box offers a plain message.
  expect(screen.queryByText("Working…")).toBeNull();
  expect(screen.getByPlaceholderText("Message Claude Code")).toBeTruthy();
});

test("the pill opens a list of what runs, and Esc closes it", async () => {
  await open(fixtures().reply);
  const pill = screen.getByRole("button", { name: "2 sub-agents running" });
  fireEvent.click(pill);
  const list = await screen.findByRole("dialog", {
    name: "Running sub-agents",
  });
  expect(pill.getAttribute("aria-expanded")).toBe("true");
  expect(
    within(list)
      .getAllByRole("button", { name: /^(?!Stop)/ })
      .map((one) => one.textContent),
  ).toEqual([
    expect.stringMatching(/^Find limiter bypasses2m \d+s$/),
    expect.stringMatching(/^Check limiter test coverage2m \d+s$/),
  ]);
  fireEvent.keyDown(list, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("one running sub-agent: the pill names it and opens its view", async () => {
  await open(fixtures().one);
  const pill = screen.getByRole("button", {
    name: /^Find limiter bypasses, working, 2m \d+s$/,
  });
  expect(pill.getAttribute("aria-haspopup")).toBeNull();
  fireEvent.click(pill);
  expect(
    await screen.findByRole("heading", { name: "Find limiter bypasses" }),
  ).toBeTruthy();
});

test("in the list, arrows move between rows, Enter opens one, Tab reaches Stop", async () => {
  await open(fixtures().reply);
  fireEvent.click(screen.getByRole("button", { name: "2 sub-agents running" }));
  const list = await screen.findByRole("dialog", {
    name: "Running sub-agents",
  });
  const items = within(list).getAllByRole("button", { name: /^(?!Stop)/ });
  items[0]?.focus();
  fireEvent.keyDown(items[0] as HTMLElement, { key: "ArrowDown" });
  expect(document.activeElement).toBe(items[1]);
  fireEvent.keyDown(items[1] as HTMLElement, { key: "ArrowUp" });
  expect(document.activeElement).toBe(items[0]);
  expect(
    within(list).getByRole("button", { name: "Stop Find limiter bypasses" }),
  ).toBeTruthy();
  fireEvent.click(items[1] as HTMLElement);
  expect(
    await screen.findByRole("heading", { name: "Check limiter test coverage" }),
  ).toBeTruthy();
});

test("nested sub-agents sit one level in under their parent", async () => {
  await open(fixtures().codexNested);
  fireEvent.click(screen.getByRole("button", { name: "3 sub-agents running" }));
  const list = await screen.findByRole("dialog", {
    name: "Running sub-agents",
  });
  const nested = within(list)
    .getByRole("button", { name: /^Run the payment tests/ })
    .closest("li");
  expect(nested?.getAttribute("data-depth")).toBe("1");
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("data-depth")),
  ).toEqual([null, "1", null]);
});

test("the plan pill and the strip share one line", async () => {
  await open(fixtures().plan);
  const plan = screen.getByRole("button", { name: /2 of 4 done/ });
  const strip = screen.getByRole("button", { name: "2 sub-agents running" });
  expect(plan.parentElement).toBe(strip.parentElement);
});

test("Stop in a list row stops that sub-agent alone, with no confirmation", async () => {
  const client = await open(fixtures().reply);
  const stop = vi.spyOn(client, "stopSubAgent");
  fireEvent.click(screen.getByRole("button", { name: "2 sub-agents running" }));
  const list = await screen.findByRole("dialog", {
    name: "Running sub-agents",
  });
  fireEvent.click(
    within(list).getByRole("button", { name: "Stop Find limiter bypasses" }),
  );
  expect(stop).toHaveBeenCalledWith("c-limiter", "sa-bypass");
  // Its row says so, and the strip now names the one that is left.
  expect(
    (
      await screen.findByRole("button", {
        name: /^Sub-agent Find limiter bypasses, stopped/,
      })
    ).textContent,
  ).toBe("Find limiter bypasses · Stopped");
  expect(
    screen.getByRole("button", {
      name: /^Check limiter test coverage, working, 2m/,
    }),
  ).toBeTruthy();
});

test("no strip without a running sub-agent, and none in a Chat without any", async () => {
  await open(fixtures().stoppedAll);
  expect(screen.queryByText(/sub-agents? running/)).toBeNull();
});

test("Stop all says what it stops: the sub-agents alone, or the turn and the sub-agents", async () => {
  await open(fixtures().reply);
  expect(screen.getByRole("button", { name: "Stop 2 sub-agents" })).toBeTruthy();
  cleanup();
  await open(fixtures().inTurn);
  expect(
    screen.getByRole("button", { name: "Stop the turn and 2 sub-agents" }),
  ).toBeTruthy();
});

test("Stop all with no turn stops every sub-agent and leaves a row below the reply", async () => {
  await open(fixtures().reply);
  fireEvent.click(screen.getByRole("button", { name: "Stop 2 sub-agents" }));
  expect(await screen.findByText("You stopped 2 sub-agents.")).toBeTruthy();
  expect(
    screen
      .getAllByRole("button", { name: /^Sub-agent .*, stopped/ })
      .map((one) => one.textContent),
  ).toEqual([
    "Find limiter bypasses · Stopped",
    "Check limiter test coverage · Stopped",
  ]);
  // Nothing runs: no strip, no Stop, and the box offers a plain message.
  expect(screen.queryByText(/sub-agents? running/)).toBeNull();
  expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
});
