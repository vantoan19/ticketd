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
import { afterEach, expect, test, vi } from "vitest";
import { App } from "@/app/App";
import { ChatClientContext } from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ExperimentalCard } from "@/features/chats/ExperimentalCard";
import {
  SettingsStateContext,
  type SettingsState,
} from "@/features/settings/use-settings-state";
import {
  chatState,
  createMockChatClient,
  type MockChatClient,
} from "@/features/chats/mock-client";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: never) =>
    command === "workspace_change_token"
      ? 1
      : command === "find_tickets_with_updates"
        ? []
        : bridgeDefault(command, args),
}));
vi.mock("@/features/tickets/DependencyGraph", () => ({ default: () => null }));
Element.prototype.scrollIntoView = () => {};
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Object.defineProperty(window, "matchMedia", {
  value: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  expect(unknownCommands).toEqual([]);
});

const waitingChat = () => ({
  chat: chatState({ id: "c1", title: "Limiter", activity: "waiting" }),
  items: [
    {
      id: "req-1",
      at: "2026-11-10T10:00:00Z",
      kind: "request" as const,
      request: "approval" as const,
      title: "Codex wants to run",
      subject: "npm test",
      options: [{ id: "once", label: "Allow once" }],
      free_text: false,
      state: "pending" as const,
    },
  ],
});
const settings = (client: MockChatClient) =>
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <ExperimentalCard />
      </ChatProvider>
    </ChatClientContext>,
  );
const chatSwitch = () => screen.getByRole("switch", { name: "Show Chat" });

test("Chat is off by default and turns on at once", async () => {
  const client = createMockChatClient();
  settings(client);
  expect(chatSwitch().getAttribute("aria-checked")).toBe("false");
  fireEvent.click(chatSwitch());
  await waitFor(() =>
    expect(chatSwitch().getAttribute("aria-checked")).toBe("true"),
  );
  expect(await client.getEnabled()).toBe(true);
});

test("the Show Chat row explains itself and the notice links to About", async () => {
  const openPage = vi.fn();
  const state: SettingsState = {
    query: "",
    setQuery: () => {},
    openPage,
    needsSetup: {},
    refreshIndicators: () => {},
  };
  render(
    <SettingsStateContext.Provider value={state}>
      <ChatClientContext value={createMockChatClient()}>
        <ChatProvider>
          <ExperimentalCard />
        </ChatProvider>
      </ChatClientContext>
    </SettingsStateContext.Provider>,
  );
  expect(
    screen.getByText("Not yet qualified against real subscriptions"),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Adds Chats and Automations to the sidebar, where you start and follow your agents’ work.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Turning Chat off hides Chats and Automations and keeps them. Running Chats and runs are stopped first, after you confirm.",
    ),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "About › Report an issue" }),
  );
  expect(openPage).toHaveBeenCalledWith("about");
});

test("turning Chat off while Chats work asks first, and stops them only on confirmation", async () => {
  const client = createMockChatClient({
    enabled: true,
    chats: [waitingChat()],
  });
  settings(client);
  await waitFor(() =>
    expect(chatSwitch().getAttribute("aria-checked")).toBe("true"),
  );
  fireEvent.click(chatSwitch());
  let dialog = await screen.findByRole("dialog", { name: "Turn off Chat?" });
  expect(dialog.textContent).toContain(
    "1 Chat is working. Turning Chat off stops it first.",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep Chat on" }));
  expect(await client.getEnabled()).toBe(true);
  expect((await client.openChat("c1")).chat.activity).toBe("waiting");

  fireEvent.click(chatSwitch());
  dialog = await screen.findByRole("dialog", { name: "Turn off Chat?" });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Stop it and turn off" }),
  );
  await waitFor(() =>
    expect(chatSwitch().getAttribute("aria-checked")).toBe("false"),
  );
  // The Chat is kept, stopped, and will not restart by itself.
  expect((await client.openChat("c1")).chat.activity).toBe("interrupted");
});

test("turning Chat off while a run is going and no Chat works asks first, naming both", async () => {
  const client = createMockChatClient({ enabled: true });
  client.runsGoing = 2;
  settings(client);
  await waitFor(() =>
    expect(chatSwitch().getAttribute("aria-checked")).toBe("true"),
  );
  fireEvent.click(chatSwitch());
  let dialog = await screen.findByRole("dialog", { name: "Turn off Chat?" });
  expect(dialog.textContent).toContain(
    "2 runs are working. Turning Chat off stops them first.",
  );
  // #387 M28: what happens to the runs it stops, and to queued ones.
  expect(dialog.textContent).toContain(
    "A stopped run ends as Needs attention. Queued runs wait until Chat is on again.",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep Chat on" }));
  expect(await client.getEnabled()).toBe(true);

  client.runsGoing = 1;
  await client.createChat({
    command_id: "c",
    harness_id: "codex",
    folder: null,
    links: [],
    message: "go",
  });
  fireEvent.click(chatSwitch());
  dialog = await screen.findByRole("dialog", { name: "Turn off Chat?" });
  expect(dialog.textContent).toContain(
    "1 Chat and 1 run are working. Turning Chat off stops them first.",
  );
});

test("Quit names the runs it would stop", async () => {
  const client = createMockChatClient({ enabled: true });
  client.runsGoing = 1;
  settings(client);
  act(() => client.requestQuit());
  const dialog = await screen.findByRole("dialog", { name: "Quit ticketd?" });
  expect(dialog.textContent).toContain(
    "1 run is still working. Quitting stops it. Closing the window instead keeps it running.",
  );
  expect(client.quit).toBe(false);
});

test("Quit asks before stopping working Chats; Cancel leaves them running", async () => {
  const client = createMockChatClient({
    enabled: true,
    chats: [waitingChat()],
  });
  settings(client);
  act(() => client.requestQuit());
  let dialog = await screen.findByRole("dialog", { name: "Quit ticketd?" });
  expect(dialog.textContent).toContain(
    "1 Chat is still working. Quitting stops it. Closing the window instead keeps it running.",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(client.quit).toBe(false);
  expect((await client.openChat("c1")).chat.activity).toBe("waiting");

  act(() => client.requestQuit());
  dialog = await screen.findByRole("dialog", { name: "Quit ticketd?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Quit" }));
  await waitFor(() => expect(client.quit).toBe(true));
});

test("Quit goes straight through when no Chat is working", async () => {
  const client = createMockChatClient({ enabled: true });
  settings(client);
  act(() => client.requestQuit());
  await waitFor(() => expect(client.quit).toBe(true));
  expect(screen.queryByRole("dialog")).toBeNull();
});

const app = (client: MockChatClient) =>
  render(
    <ChatClientContext value={client}>
      <App />
    </ChatClientContext>,
  );

test("with Chat off, nothing about Chat is in the workspace", async () => {
  app(createMockChatClient({ chats: [waitingChat()] }));
  await screen.findByRole("button", { name: /All tickets/ });
  expect(screen.queryByRole("button", { name: /^Chats/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Automations" })).toBeNull();
  // Capture moved from the header to the shared palette.
  expect(
    screen.queryByRole("button", { name: "Capture a thought" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "More ways to create" }),
  ).toBeNull();
});

test("with Chat on, Automations opens from the sidebar", async () => {
  app(createMockChatClient({ enabled: true }));
  await screen.findByRole("button", { name: "Chats" });
  const entry = await screen.findByRole("button", { name: "Automations" });
  fireEvent.click(entry);
  expect(entry.getAttribute("aria-current")).toBe("page");
  const tabs = within(await screen.findByRole("radiogroup", { name: "Show" }));
  expect(tabs.getByRole("radio", { name: /^Automations/ })).toBeTruthy();
  fireEvent.click(tabs.getByRole("radio", { name: /^Agents/ }));
  expect(await screen.findByRole("list", { name: "Agents" })).toBeTruthy();
});

test("with Chat on, the sidebar entry says how many Chats wait and opens them", async () => {
  const client = createMockChatClient({
    enabled: true,
    chats: [waitingChat()],
  });
  app(client);
  const entry = await screen.findByRole("button", {
    name: "Chats, 1 waiting",
  });
  fireEvent.click(entry);
  expect(entry.getAttribute("aria-current")).toBe("page");
  expect(await screen.findByRole("list", { name: "Chats" })).toBeTruthy();

  // Answered elsewhere: the indicator follows the host, not the workspace poll.
  await act(() => client.stop("c1"));
  expect(
    await within(
      screen.getByRole("navigation", { name: "Workspace views" }),
    ).findByRole("button", { name: "Chats" }),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Search or jump to…" }));
  fireEvent.click(await screen.findByRole("option", { name: "New Chat" }));
  expect(
    await screen.findByRole("heading", { name: "What should we work on?" }),
  ).toBeTruthy();
});
