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
import {
  ChatClientContext,
  type TranscriptItem,
} from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import {
  chatState,
  createMockChatClient,
  type MockChat,
} from "@/features/chats/mock-client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(cleanup);

const at = "2026-11-10T10:00:00Z";
const you: TranscriptItem = {
  id: "u1",
  at,
  kind: "user",
  text: "Add a limiter",
  delivery: "delivered",
};
const reply: TranscriptItem = {
  id: "r1",
  at,
  kind: "response",
  text: "Added the limiter.",
  state: "complete",
};
const steps = [
  { text: "Read the handler", status: "completed" as const },
  {
    text: "Add the limiter",
    status: "in_progress" as const,
    active_label: "Adding the limiter",
  },
];
const plan = (state: "running" | "ended"): TranscriptItem => ({
  id: "plan-1",
  at,
  kind: "plan",
  turn_id: "turn-1",
  state,
  steps,
});

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

test("reasoning reads how long it took and opens its text; one without text leaves", async () => {
  await open({
    chat: chatState({ id: "reasoning-fold", title: "Limiter" }),
    items: [
      you,
      {
        id: "rs-1",
        at,
        kind: "reasoning",
        turn_id: "turn-1",
        state: "done",
        started_at: 1_000,
        ended_at: 13_000,
        text: "The handler has **no** limit.",
      },
      {
        id: "rs-2",
        at,
        kind: "reasoning",
        turn_id: "turn-1",
        state: "done",
        started_at: 1_000,
        ended_at: 2_000,
      },
      {
        id: "rs-3",
        at,
        kind: "reasoning",
        turn_id: "turn-1",
        state: "not_finished",
        started_at: 1_000,
        ended_at: 9_000,
      },
      reply,
    ],
  });
  // Reasoning folds with the turn's steps.
  fireEvent.click(screen.getByRole("button", { name: /^Worked/ }));
  fireEvent.click(document.querySelector<HTMLElement>(".chat-stretch-row")!);
  const row = screen.getByRole("button", {
    name: "Show reasoning, thought for 12 seconds",
  });
  expect(row.textContent).toContain("Thought for 12s");
  fireEvent.click(row);
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("no").tagName).toBe("STRONG");
  // Cut off, it says so; finished with nothing shown, it is gone.
  expect(screen.getByText("Not finished")).toBeTruthy();
  expect(screen.getAllByText(/^Thought for/)).toHaveLength(2);
});

test("a running plan lives in the dock; an unfinished one becomes a card that saves as a checklist", async () => {
  const client = await open({
    chat: chatState({ id: "c1", title: "Limiter", activity: "working" }),
    items: [you, plan("running")],
  });
  const pill = screen.getByRole("button", { name: /1 of 2 done/ });
  expect(pill.textContent).toContain("Adding the limiter");
  expect(screen.queryByRole("region", { name: /^Plan/ })).toBeNull();

  client.push("c1", plan("ended"));
  client.push("c1", reply);
  client.patch("c1", { activity: "idle" });
  const card = await screen.findByRole("region", { name: "Plan, 1 of 2 done" });
  expect(within(card).getByText("Not finished")).toBeTruthy();
  expect(within(card).getByRole("img", { name: "Done" })).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /1 of 2 done/ })).toBeNull(),
  );

  fireEvent.click(
    within(card).getAllByRole("button", { name: /Save as Document/ })[0]!,
  );
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("only finished steps are checked");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(client.savedDocuments).toHaveLength(1));
});

test("a finished plan is one row in its turn", async () => {
  await open({
    chat: chatState({ id: "plan-fold", title: "Limiter" }),
    items: [
      you,
      {
        ...plan("ended"),
        steps: steps.map((step) => ({ ...step, status: "completed" })),
      } as TranscriptItem,
      reply,
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: /^Worked/ }));
  fireEvent.click(document.querySelector<HTMLElement>(".chat-stretch-row")!);
  expect(screen.getByText("Plan · 2 of 2 done")).toBeTruthy();
  expect(screen.queryByRole("region", { name: /^Plan/ })).toBeNull();
});

test("changed files sit below the response, open in their app, and say why one did not", async () => {
  const files: TranscriptItem = {
    id: "files-1",
    at,
    kind: "files",
    turn_id: "turn-1",
    state: "ended",
    files: [
      {
        path: "src/limiter.ts",
        open_path: "/work/src/limiter.ts",
        kind: "added",
        added_lines: 48,
        removed_lines: 0,
        confirmed: true,
      },
      {
        path: "src/handler.ts",
        open_path: "/work/src/handler.ts",
        kind: "modified",
        added_lines: 5,
        removed_lines: 7,
        confirmed: true,
      },
      {
        path: "README.md",
        open_path: "/work/README.md",
        kind: "modified",
        confirmed: false,
      },
    ],
  };
  const client = await open({
    chat: chatState({
      id: "c1",
      title: "Limiter",
      folder: { path: "/work", name: "work" },
    }),
    // Recorded at the first edit, before the response.
    items: [you, files, reply],
  });
  const row = screen.getByRole("button", { name: /3 files changed/ });
  expect(row.textContent).toBe("3 files changed · +53 −7 · 1 not confirmed");
  // Below the response.
  const response = within(screen.getByLabelText("Conversation")).getByText(
    "Added the limiter.",
  );
  expect(
    response.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  fireEvent.click(row);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Open src/limiter.ts in your editor, new file, 48 lines added",
    }),
  );
  await waitFor(() =>
    expect(client.openedFiles).toEqual(["/work/src/limiter.ts"]),
  );
  expect(screen.getByText("—")).toBeTruthy();
  expect(screen.getByText("Not confirmed")).toBeTruthy();
  // A file with nothing removed says "+48" alone; its folder is muted before its name.
  expect(screen.getByText("+48")).toBeTruthy();
  expect(screen.getByText("+5 −7")).toBeTruthy();
  const path = row.parentElement?.querySelector(".chat-file-path");
  expect(path?.textContent).toBe("src/limiter.ts");
  expect(path?.querySelector(".chat-path-dir")?.textContent).toBe("src/");
});

test("the context count sits before Stop, reads as tokens, and turns to a percentage from 80%", async () => {
  const context = (used: number) => ({
    used,
    window: 200_000,
    categories: [{ name: "Messages", tokens: 100_000 }],
    compacts_at: 167_000,
    at: Date.now(),
  });
  const client = await open({
    chat: chatState({
      id: "c1",
      title: "Limiter",
      activity: "working",
      context: context(124_000),
    }),
    items: [you],
  });
  const count = screen.getByRole("button", {
    name: "Context window: 62% used, 124k of 200k tokens",
  });
  expect(count.textContent).toBe("124k");
  // Fixed before Stop, so Send leads the row.
  const stop = screen.getByRole("button", { name: "Stop" });
  expect(
    count.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // It opens the Chat's one context popover, at its Context group.
  fireEvent.click(count);
  const popover = await screen.findByRole("dialog", { name: "Chat context" });
  const group = within(popover).getByRole("group", { name: "Context" });
  expect(group.textContent).toContain("124k / 200k");
  expect(group.textContent).toContain("62% used · Compacts near 167k");
  // Esc closes it and the person is back in the message box.
  fireEvent.keyDown(popover, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Chat context" })).toBeNull(),
  );
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: /Codex$/ }),
  );

  act(() => client.patch("c1", { context: context(164_000) }));
  expect(
    (await screen.findByRole("button", { name: /^Context window: 82%/ }))
      .textContent,
  ).toBe("82% context");
});

test("while reasoning runs it is the turn's one spinner: no working line under it", async () => {
  await open({
    chat: chatState({ id: "c1", title: "Limiter", activity: "working" }),
    items: [
      { ...you, turn_id: "turn-1" },
      {
        id: "turn:turn-1",
        at,
        kind: "turn",
        turn_id: "turn-1",
        started_at: at,
        outcome: "active",
      },
      {
        id: "rs-1",
        at,
        kind: "reasoning",
        turn_id: "turn-1",
        state: "running",
        started_at: Date.now(),
      },
    ],
  });
  expect(screen.getByText(/^Thinking/)).toBeTruthy();
  expect(document.querySelector(".chat-working")).toBeNull();
});
