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
  type Suggestion,
  type TranscriptItem,
} from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import { drafts } from "@/features/chats/drafts";
import {
  chatState,
  createMockChatClient,
  type MockChat,
} from "@/features/chats/mock-client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
/** What each ResizeObserver watches, so a test can report a size change. */
const watching = new Map<Element, ResizeObserverCallback>();
window.ResizeObserver = class {
  constructor(private callback: ResizeObserverCallback) {}
  observe(element: Element) {
    watching.set(element, this.callback);
  }
  unobserve() {}
  disconnect() {}
};

afterEach(() => {
  cleanup();
  drafts.clear();
  watching.clear();
});

const at = "2026-11-10T10:00:00Z";
const ticket = (id: string, reference: string, status: string) => ({
  kind: "ticket" as const,
  id,
  reference,
  title: `${reference} title`,
  status,
});

async function show(
  chats: MockChat[],
  extra: Parameters<typeof createMockChatClient>[0] = {},
) {
  const client = createMockChatClient({ enabled: true, chats, ...extra });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <ChatsView />
      </ChatProvider>
    </ChatClientContext>,
  );
  const first = chats[0];
  if (first) {
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(`^${first.chat.title}`),
      }),
    );
    await screen.findByRole("heading", { name: first.chat.title });
  }
  return client;
}

/** A turn still running, so its rows show unfolded. */
const steps = (
  ...list: Extract<TranscriptItem, { kind: "steps" }>["steps"]
): TranscriptItem[] => [
  {
    id: "u1",
    at,
    kind: "user",
    text: "Go",
    delivery: "delivered",
    turn_id: "t1",
  },
  {
    id: "turn:t1",
    at,
    kind: "turn",
    turn_id: "t1",
    started_at: at,
    outcome: "active",
  },
  { id: "s1", at, kind: "steps", steps: list, turn_id: "t1" },
];

test("each step kind has its own icon; a running step shows the spinner instead", async () => {
  await show([
    {
      chat: chatState({ id: "c1", title: "Limiter", activity: "working" }),
      items: steps(
        { kind: "read", target: "a.ts", targets: [{ text: "a.ts" }] },
        { kind: "search", target: "x", targets: [{ text: "x" }] },
        {
          kind: "run",
          target: "npm test",
          command: "npm test",
          state: "running",
        },
      ),
    },
  ]);
  const rows = [...document.querySelectorAll(".chat-steps")];
  const icon = (row: Element | undefined) =>
    row?.querySelector(".chat-row-icon svg")?.getAttribute("class");
  expect(icon(rows[0])).toContain("lucide-eye");
  expect(icon(rows[1])).toContain("lucide-search");
  expect(icon(rows[2])).toContain("chat-spin");
});

test("a file name opens the file; one that is gone becomes plain text and says so", async () => {
  const client = await show(
    [
      {
        chat: chatState({ id: "c1", title: "Limiter", activity: "working" }),
        items: steps(
          {
            kind: "edit",
            target: "src/auth/index.ts",
            targets: [
              { text: "src/auth/index.ts" },
              { text: "src/api/index.ts" },
            ],
          },
          { kind: "create", target: "old.ts", targets: [{ text: "old.ts" }] },
        ),
      },
    ],
    { goneFiles: ["old.ts"] },
  );
  const first = button("Open src/auth/index.ts");
  // A repeated name gains its folder.
  expect(first.textContent).toBe("auth/index.ts");
  fireEvent.click(first);
  await waitFor(() =>
    expect(client.openedFiles).toEqual(["src/auth/index.ts"]),
  );
  fireEvent.click(button("Open old.ts"));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "old.ts is no longer in this folder.",
  );
  expect(screen.queryByRole("button", { name: "Open old.ts" })).toBeNull();
  expect(screen.getByText("old.ts", { selector: "code *" })).toBeTruthy();
});

test("a command's detail strips terminal colour and says its exit and folder", async () => {
  await show([
    {
      chat: chatState({ id: "c1", title: "Limiter", activity: "working" }),
      items: steps({
        kind: "run",
        target: "npm test",
        command: "npm test",
        state: "failed",
        exit_code: 1,
        output: "\u001b[31mFAIL\u001b[0m limiter",
      }),
    },
  ]);
  fireEvent.click(button("Run npm test, Failed"));
  expect(
    screen.getByRole("region", { name: "Output of npm test" }).textContent,
  ).toBe("$ npm test\n\nFAIL limiter");
  // The Chat's own folder, when the command did not name another.
  expect(screen.getByText("Exit 1 · in web-app")).toBeTruthy();
});

test("your message offers Copy, and its images are tiles: three, then +N", async () => {
  const image = (id: string) => ({
    id,
    display_name: `${id}.png`,
    original_filename: `${id}.png`,
    size_bytes: 10,
    kind: "local_snapshot" as const,
    locator: id,
  });
  await show([
    {
      chat: chatState({ id: "c1", title: "Limiter" }),
      items: [
        {
          id: "u1",
          at,
          kind: "user",
          text: "Both screens from staging.",
          delivery: "delivered",
          images: ["a", "b", "c", "d", "e"].map(image),
        },
      ],
    },
  ]);
  expect(button("Copy message")).toBeTruthy();
  const tiles = within(document.querySelector<HTMLElement>(".chat-tiles")!);
  expect(
    tiles.getAllByRole("button").map((tile) => tile.getAttribute("aria-label")),
  ).toEqual([
    "Open image a.png",
    "Open image b.png",
    "Open image c.png",
    "Open 2 more images",
  ]);
});

const suggestions: Suggestion[] = [
  { kind: "continue", ticket: ticket("t14", "T-KQ14", "In progress"), at },
  { kind: "review", ticket: ticket("t12", "T-KQ12", "In review"), at },
  {
    kind: "triage",
    count: 3,
    links: [ticket("t7", "T-KQ7", "Todo"), ticket("t8", "T-KQ8", "Todo")],
    at,
  },
];

const button = (name: string) => screen.getByRole("button", { name });
const box = () =>
  screen.getByLabelText<HTMLTextAreaElement>(
    "Describe a task or ask a question",
  );

test("a suggestion fills the box and links its record, never sends, and undoes as one step", async () => {
  const client = await show([], { suggestions });
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  const suggested = await screen.findByRole("region", { name: "Suggested" });
  expect(within(suggested).getAllByRole("button")).toHaveLength(3);
  fireEvent.click(within(suggested).getByRole("button", { name: /^Continue/ }));
  expect(box().value).toBe(
    "Continue T-KQ14 (T-KQ14 title). Read its latest update and linked Documents first, then pick up where it left off.",
  );
  expect(screen.getByRole("status").textContent).toBe("Linked T-KQ14.");
  expect(
    screen.getByText("T-KQ14 title", { selector: ".chat-chips *" }),
  ).toBeTruthy();
  // Hidden while the box holds text; nothing was sent.
  expect(screen.queryByRole("region", { name: "Suggested" })).toBeNull();
  expect(await client.listChats("active")).toEqual([]);
  fireEvent.keyDown(box(), { key: "z", metaKey: true });
  expect(box().value).toBe("");
  expect(
    screen.queryByText("T-KQ14 title", { selector: ".chat-chips *" }),
  ).toBeNull();
  expect(await screen.findByRole("region", { name: "Suggested" })).toBeTruthy();
});

test("New Chat shows the harness notice instead of the suggestions, never both", async () => {
  await show([], {
    suggestions,
    harnesses: [
      { id: "claude-code", name: "Claude Code", status: "not_signed_in" },
      { id: "codex", name: "Codex", status: "not_signed_in" },
    ],
  });
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  expect(await screen.findByText("Claude Code isn't signed in")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Suggested" })).toBeNull();
});

test("New Chat's folder button shows the folder's Project icon", async () => {
  const client = await show([]);
  client.folderProjects.set("/work/web-app", { id: "p1", title: "Web App" });
  client.nextFolder = "/work/web-app";
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "Scratch folder" }), {
    key: "Enter",
  });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Choose a folder…" }),
  );
  const folder = await screen.findByRole("button", {
    name: "Folder: /work/web-app",
  });
  await waitFor(() => expect(folder.textContent).toBe("WFolder: web-app"));
});

test("suggestions that fail to load say so and try again", async () => {
  const client = await show([], { suggestions });
  const real = client.suggestions;
  client.suggestions = () => Promise.reject(new Error("locked"));
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  expect(await screen.findByText(/Couldn't load suggestions\./)).toBeTruthy();
  client.suggestions = real;
  fireEvent.click(button("Try again"));
  expect(await screen.findByRole("region", { name: "Suggested" })).toBeTruthy();
});

test("a message that the pane later narrows to more than four lines offers Show more", async () => {
  await show([
    {
      chat: chatState({ id: "c1", title: "Limiter" }),
      items: [
        {
          id: "u1",
          at,
          kind: "user",
          text: "Work on T-MP2: read README.md and say what it says.",
          delivery: "delivered",
        },
      ],
    },
  ]);
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  const box = document.querySelector<HTMLElement>(".chat-you > div")!;
  Object.defineProperty(box, "clientHeight", { configurable: true, value: 80 });
  Object.defineProperty(box, "scrollHeight", {
    configurable: true,
    value: 100,
  });
  act(() => watching.get(box)?.([], {} as unknown as ResizeObserver));
  expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
});

test("a one-line message whose mention pokes past its line offers no Show more", async () => {
  // CH-31: the mention chip overflows the 20px line by 2px.
  await show([
    {
      chat: chatState({ id: "c1", title: "Limiter" }),
      items: [
        {
          id: "u1",
          at,
          kind: "user",
          text: "Implement T-MP2.",
          delivery: "delivered",
        },
      ],
    },
  ]);
  const box = document.querySelector<HTMLElement>(".chat-you > div")!;
  box.style.lineHeight = "20px";
  Object.defineProperty(box, "clientHeight", { configurable: true, value: 20 });
  Object.defineProperty(box, "scrollHeight", {
    configurable: true,
    value: 22,
  });
  act(() => watching.get(box)?.([], {} as unknown as ResizeObserver));
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});
