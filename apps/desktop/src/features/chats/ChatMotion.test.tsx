// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Fragment, type ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ChatClientContext,
  type Step,
  type TranscriptItem,
} from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import { MotionProvider } from "@/components/ui/motion";
import { StatusLineRegion } from "@/components/ui/status-line";
import { drafts } from "@/features/chats/drafts";
import { freezeMotionClock } from "@/test/motion-clock";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
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
  Motion: (props: { children: ReactNode }) => ReactNode = Fragment,
) {
  const chats: MockChat[] = [{ chat: chatState(over), items }];
  const client = createMockChatClient({ enabled: true, chats, records: [] });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <StatusLineRegion>
          <Motion>
            <ChatsView />
          </Motion>
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

// By key: a click right after the one that opened the Chat is a rapid click,
// and the input guard would make the exit instant.
const answer = () =>
  fireEvent.keyDown(screen.getByRole("button", { name: /Allow once/ }), {
    key: "1",
  });

const approvalTwo: TranscriptItem = {
  ...approval,
  id: "req-2",
  title: "Codex wants to edit",
  subject: "package.json",
};

test("a request replaced by the next waits for it to leave: two never stack", async () => {
  const restoreTokens = applyTokens(rootTokens);
  const clock = freezeMotionClock();
  try {
    await open(
      { id: "c1", title: "Limiter", activity: "waiting" },
      [approval, approvalTwo],
      MotionProvider,
    );
    const shown = () =>
      [...document.querySelectorAll("[data-request]")].map(
        (request) => request.textContent ?? "",
      );
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain("npm install");
    answer();
    await clock.advance(10);
    // The answered one is leaving; the next has not begun.
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain("npm install");
    await clock.advance(400);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain("package.json");
  } finally {
    clock.restore();
    restoreTokens();
  }
});

test("a request that leaves cannot be reached while it fades", async () => {
  const restoreTokens = applyTokens(rootTokens);
  const clock = freezeMotionClock();
  try {
    await open(
      { id: "c1", title: "Limiter", activity: "waiting" },
      [approval],
      MotionProvider,
    );
    const request = screen.getByRole("group", { name: /Codex wants to run/ });
    expect(request.hasAttribute("inert")).toBe(false);
    answer();
    await clock.advance(10);
    expect(request.isConnected).toBe(true);
    expect(request.hasAttribute("inert")).toBe(true);
    await clock.advance(400);
    expect(request.isConnected).toBe(false);
  } finally {
    clock.restore();
    restoreTokens();
  }
});

test("an answered question's receipt rises into the transcript", async () => {
  const question: TranscriptItem = {
    id: "q-1",
    at,
    kind: "request",
    request: "question",
    title: "Codex is asking you",
    subject: "What should the limiter do?",
    options: [{ id: "open", label: "Fail open" }],
    free_text: false,
    state: "pending",
  };
  await open({ id: "c1", title: "Limiter", activity: "waiting" }, [question]);
  // Asked and unanswered: nothing in the transcript yet.
  expect(document.querySelector(".chat-receipt")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Fail open/ }));
  const receipt = await waitFor(() => {
    const found = document.querySelector(".chat-receipt");
    expect(found).toBeTruthy();
    return found!;
  });
  expect(receipt.textContent).toBe("Answered · Fail open");
  expect(receipt.closest('[data-slot="appear"]')).toBeTruthy();
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

// jsdom lays nothing out, so a box leaving from `auto` has no height to close
// from. Report a size for every element.
function withLayoutSize() {
  const box = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 40, 40));
  return () => box.mockRestore();
}

test("a removed queue card fades out, out of reach, as its space closes; the cards below glide up", async () => {
  const restoreTokens = applyTokens(rootTokens);
  const clock = freezeMotionClock();
  const restoreLayout = withLayoutSize();
  let clickTime = 0;
  const inputClock = vi
    .spyOn(performance, "now")
    .mockImplementation(() => clickTime);
  try {
    await open(
      { id: "c1", title: "Limiter", activity: "working" },
      [],
      MotionProvider,
    );
    const box = screen.getByLabelText(
      /Steer Codex|Message Codex|Queue for Codex/,
    );
    for (const text of ["first thing", "second thing"]) {
      fireEvent.change(box, { target: { value: text } });
      fireEvent.keyDown(box, { key: "Enter", metaKey: true });
      await screen.findByText(text);
    }
    const cards = () => [
      ...document.querySelectorAll<HTMLElement>(".chat-queue-card"),
    ];
    expect(cards()).toHaveLength(2);
    // The click that opened the Chat must not count as part of a rapid click.
    clickTime += 400;
    fireEvent.click(
      screen.getAllByRole("button", { name: "Remove from queue" })[0]!,
    );
    await clock.advance(10);
    // Still drawn, but nothing in it can be reached.
    const leaving = cards().find((card) => card.textContent === "first thing");
    expect(leaving).toBeTruthy();
    expect(
      leaving?.querySelector('[data-slot="appear"]')?.hasAttribute("inert"),
    ).toBe(true);
    // Its own space closes with the fade, so the cards below move up as it
    // goes instead of jumping when it has gone.
    expect(leaving?.style.overflow).toBe("clip");
    const closing = () => Number.parseFloat(leaving?.style.height ?? "");
    expect(closing()).toBeLessThan(40);
    const early = closing();
    await clock.advance(60);
    expect(closing()).toBeLessThan(early);
    await clock.advance(500);
    expect(cards().map((card) => card.textContent)).toEqual(["second thing"]);
  } finally {
    inputClock.mockRestore();
    restoreLayout();
    clock.restore();
    restoreTokens();
  }
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
