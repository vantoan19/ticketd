// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ChatClientContext,
  type TranscriptItem,
} from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import { StatusLineContext } from "@/components/ui/use-status-line";
import { StatusLineRegion } from "@/components/ui/status-line";
import { drafts } from "@/features/chats/drafts";
import {
  chatState,
  createMockChatClient,
  type MockChat,
} from "@/features/chats/mock-client";
import { steersAwaitingRead } from "@/features/chats/steer-caption";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(() => {
  cleanup();
  drafts.clear();
});

const at = "2026-11-10T10:00:00Z";
const approval: TranscriptItem = {
  id: "req-1",
  at,
  kind: "request",
  request: "approval",
  title: "Codex wants to run",
  subject: "npm install demo-package",
  options: [
    { id: "once", label: "Allow once" },
    { id: "deny", label: "Deny" },
  ],
  free_text: false,
  state: "pending",
};
const steer = (
  id: string,
  delivery: "delivered" | "sending",
): TranscriptItem => ({
  id,
  at,
  kind: "user",
  steer: true,
  text: "Use the shorter name",
  delivery,
});

async function open(chat: MockChat, tree = (view: React.ReactNode) => view) {
  const client = createMockChatClient({ enabled: true, chats: [chat] });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        {tree(
          <StatusLineRegion>
            <ChatsView />
          </StatusLineRegion>,
        )}
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
const working = (items: TranscriptItem[]): MockChat => ({
  chat: chatState({ id: "c1", title: "Demo Chat", activity: "working" }),
  items,
});

test("a steer the harness has taken says when it is read, until the agent answers after it", async () => {
  const client = await open(working([steer("s1", "delivered")]));
  expect(
    screen.getByText("Codex reads this after its current step"),
  ).toBeTruthy();
  act(() =>
    client.push("c1", {
      id: "r1",
      at,
      kind: "response",
      text: "Renaming it now.",
      state: "streaming",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByText(/reads this after its current step/)).toBeNull(),
  );
});

test("a steer still being sent keeps its own caption, and none is said once the turn is over", () => {
  const items = [steer("s1", "sending"), steer("s2", "delivered")];
  expect([...steersAwaitingRead(items, true)]).toEqual(["s2"]);
  expect([...steersAwaitingRead(items, false)]).toEqual([]);
  const acted: TranscriptItem = {
    id: "r1",
    at,
    kind: "response",
    text: "Done",
    state: "complete",
  };
  expect([...steersAwaitingRead([...items, acted], true)]).toEqual([]);
});

test("after Deny the box takes focus and invites what to do instead, until the next message", async () => {
  await open({
    chat: chatState({ id: "c1", title: "Demo Chat", activity: "waiting" }),
    items: [approval],
  });
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  const box = await screen.findByLabelText("Tell Codex what to do instead");
  expect(document.activeElement).toBe(box);
  fireEvent.change(box, { target: { value: "Use the cached copy" } });
  fireEvent.click(screen.getByRole("button", { name: "Steer" }));
  await screen.findByLabelText("Steer Codex");
});

test("allowing a request leaves the box with its usual words", async () => {
  await open({
    chat: chatState({ id: "c1", title: "Demo Chat", activity: "waiting" }),
    items: [approval],
  });
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await screen.findByLabelText("Steer Codex");
  expect(screen.queryByLabelText(/what to do instead/)).toBeNull();
});

test("a Chat asks the pane's status line to rise from its tray, not from the pane's bottom edge", async () => {
  const setAbove = vi.fn();
  const region = {
    show: () => {},
    dismiss: () => {},
    setInset: () => {},
    setAbove,
  };
  const client = createMockChatClient({
    enabled: true,
    chats: [working([])],
  });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <StatusLineContext value={region}>
          <ChatsView />
        </StatusLineContext>
      </ChatProvider>
    </ChatClientContext>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /^Demo Chat/ }));
  await screen.findByRole("heading", { name: "Demo Chat" });
  const asked = setAbove.mock.calls
    .map(([element]) => element as HTMLElement | null)
    .filter((element) => element !== null);
  expect(asked.at(-1)?.classList.contains("chat-tray")).toBe(true);
});
