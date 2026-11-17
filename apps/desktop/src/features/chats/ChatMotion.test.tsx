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
  type Step,
  type TranscriptItem,
} from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import { StatusLineRegion } from "@/components/ui/status-line";
import { drafts } from "@/features/chats/drafts";
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

afterEach(() => {
  cleanup();
  drafts.clear();
});

const at = "2026-11-10T10:00:00Z";
const user = (id: string, text: string): TranscriptItem => ({
  id,
  at,
  kind: "user",
  text,
  delivery: "delivered",
});
const reply = (
  id: string,
  text: string,
  state: "streaming" | "complete" = "complete",
): TranscriptItem => ({ id, at, kind: "response", text, state });
const approval: TranscriptItem = {
  id: "req-1",
  at,
  kind: "request",
  request: "approval",
  title: "Codex wants to run",
  subject: "npm install",
  options: [{ id: "once", label: "Allow once" }],
  free_text: false,
  state: "pending",
};
const running: Step = {
  kind: "run",
  target: "npm test",
  command: "npm test",
  folder: "apps/desktop",
  state: "running",
};
const done: Step = { ...running, state: "done", exit_code: 0 };

async function open(
  over: Parameters<typeof chatState>[0],
  items: TranscriptItem[],
) {
  const chats: MockChat[] = [{ chat: chatState(over), items }];
  const client = createMockChatClient({ enabled: true, chats, records: [] });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <StatusLineRegion>
          <ChatsView />
        </StatusLineRegion>
      </ChatProvider>
    </ChatClientContext>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: new RegExp(`^${over.title}`) }),
  );
  await screen.findByRole("heading", { name: over.title });
  return client;
}

const appearing = () =>
  document.querySelectorAll('.chat-scroll [data-slot="appear"]');

test("history never animates; a message that arrives rises into view", async () => {
  const client = await open({ id: "c1", title: "Limiter" }, [
    user("u1", "Rate-limit failed logins"),
    reply("r1", "Done."),
  ]);
  expect(appearing()).toHaveLength(0);
  act(() => client.push("c1", user("u2", "And the IPs?")));
  const message = await screen.findByText("And the IPs?");
  expect(message.closest('[data-slot="appear"]')).toBeTruthy();
  // What was there before is still still.
  expect(
    screen.getByText("Rate-limit failed logins").closest("[data-slot=appear]"),
  ).toBeNull();
});

test("streamed text fades in chunk by chunk; what the reply opened with is plain", async () => {
  const client = await open(
    { id: "c1", title: "Limiter", activity: "working" },
    [reply("r1", "Reading", "streaming")],
  );
  act(() => client.streamText("c1", "r1", " the spec,"));
  act(() => client.streamText("c1", "r1", " then the tests."));
  await waitFor(() =>
    expect(document.querySelectorAll(".chat-ai .chat-chunk")).toHaveLength(2),
  );
  const chunks = [...document.querySelectorAll(".chat-ai .chat-chunk")];
  expect(chunks.map((chunk) => chunk.textContent)).toEqual([
    " the spec,",
    " then the tests.",
  ]);
  expect(document.querySelector(".chat-ai")?.textContent).toContain(
    "Reading the spec, then the tests.",
  );
});

test("the step that runs shimmers; a finished step is still", async () => {
  const client = await open(
    { id: "c1", title: "Limiter", activity: "working" },
    [
      { ...user("u1", "Run it"), turn_id: "t1" },
      {
        id: "turn:t1",
        at,
        kind: "turn",
        turn_id: "t1",
        started_at: at,
        outcome: "active",
      } as TranscriptItem,
      { id: "s1", at, kind: "steps", turn_id: "t1", steps: [done] },
    ],
  );
  expect(
    document.querySelectorAll(".chat-step-verb [data-slot=shimmer]"),
  ).toHaveLength(0);
  act(() =>
    client.push("c1", {
      id: "s2",
      at,
      kind: "steps",
      turn_id: "t1",
      steps: [{ ...running, target: "npm run lint", command: "npm run lint" }],
    }),
  );
  await waitFor(() =>
    expect(
      document.querySelectorAll(".chat-step-verb [data-slot=shimmer]"),
    ).toHaveLength(1),
  );
  // The new step rises as it arrives; the finished one before it does not.
  expect(appearing().length).toBeGreaterThan(0);
});

test("an approval request fades up in the tray and leaves once answered", async () => {
  await open({ id: "c1", title: "Limiter", activity: "waiting" }, [approval]);
  const request = screen.getByRole("group", { name: /Codex wants to run/ });
  expect(request.getAttribute("data-slot")).toBe("appear");
  fireEvent.click(screen.getByRole("button", { name: /Allow once/ }));
  await waitFor(() =>
    expect(
      screen.queryByRole("group", { name: /Codex wants to run/ }),
    ).toBeNull(),
  );
});

test("queued messages open and close their own space; the queue leaves with its last card", async () => {
  await open({ id: "c1", title: "Limiter", activity: "working" }, []);
  expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull();
  const box = screen.getByLabelText(
    /Steer Codex|Message Codex|Queue for Codex/,
  );
  fireEvent.change(box, { target: { value: "then the docs" } });
  fireEvent.keyDown(box, { key: "Enter", metaKey: true });
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  expect(queue.querySelector('[data-slot="appear"]')).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove from queue" }));
  await waitFor(() =>
    expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull(),
  );
});

test("Jump to latest is a button that fades in only while the reader is away", async () => {
  await open({ id: "c1", title: "Limiter" }, [reply("r1", "Hello")]);
  const strip = document.querySelector<HTMLElement>(".chat-jump")!;
  expect(strip.hasAttribute("inert")).toBe(true);
  expect(strip.querySelector("button")).toBeNull();
  const scroller = document.querySelector<HTMLElement>(".chat-scroll")!;
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: 200,
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  scroller.scrollTop = 800;
  fireEvent.scroll(scroller);
  fireEvent.wheel(scroller, { deltaY: -500 });
  scroller.scrollTop = 300;
  fireEvent.scroll(scroller);
  expect(strip.hasAttribute("inert")).toBe(false);
  expect(strip.querySelector('[data-slot="appear"] button')).toBeTruthy();
});
