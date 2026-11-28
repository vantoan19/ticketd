// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { ChatClientContext } from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { createMockChatClient } from "@/features/chats/mock-client";
import { creditedTests } from "@/features/chats/ticket-agent-fixtures";
import { useChatFeature } from "@/features/chats/use-chats";
import { Activity } from "./Activity";
import { OpenTicketFor } from "./open-ticket/parts/activity-testing";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@uiw/react-codemirror", () => ({
  default: () => <textarea />,
}));
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
beforeAll(async () => {
  const editor = await import("@/features/markdown/MarkdownEditor");
  await editor.LazySourceEditor.preload();
});
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

const note = {
  id: "n-credit",
  ticket_id: "ticket",
  brief: "Limiter tests: added a case for a request with no key; 15 pass.",
  reported_at: "2026-10-31T10:00:00Z",
  updated_at: "2026-10-31T10:00:00Z",
  editing_agent: "claude-code",
};
const status = (credited?: typeof creditedTests) => ({
  type: "automatic",
  id: 1,
  event: {
    kind: "status",
    from_value: "Todo",
    to_value: "In progress",
    timestamp: "2026-10-31T09:00:00Z",
    editing_agent: "claude-code",
    ...(credited && { credited_to: credited }),
  },
});

function Asked() {
  const { chatRequest } = useChatFeature();
  return (
    <output aria-label="asked">
      {JSON.stringify(chatRequest?.request ?? null)}
    </output>
  );
}

function show(feed: unknown[], chat = true) {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "activity_feed" ? feed : [],
  );
  const client = createMockChatClient({ enabled: chat });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <OpenTicketFor reference="T-KQ29">
          <Activity projects={[]} active trashed={false} reference="T-KQ29" />
        </OpenTicketFor>
        <Asked />
      </ChatProvider>
    </ChatClientContext>,
  );
}

test("an update credited to a sub-agent keeps its author and opens the sub-agent's view", async () => {
  show([
    {
      type: "authored",
      activity: { ...note, credited_to: creditedTests },
    },
  ]);
  const credit = await screen.findByRole("button", {
    name: "Check limiter test coverage",
  });
  const author = screen.getByText("claude-code");
  expect(author.tagName).toBe("STRONG");
  expect(credit.closest(".activity-author")).toBe(
    author.closest(".activity-author"),
  );
  fireEvent.click(credit);
  expect(
    JSON.parse(screen.getByLabelText("asked").textContent ?? "null"),
  ).toEqual({
    kind: "open",
    chatId: "c-limiter",
    retention: "active",
    from: "T-KQ29",
    subAgent: "sa-tests",
  });
});

test("a status change credited to a sub-agent shows it after the author", async () => {
  show([status(creditedTests)]);
  fireEvent.click(await screen.findByRole("button", { name: /^1 change:/ }));
  const credit = await screen.findByRole("button", {
    name: "Check limiter test coverage",
  });
  expect(credit.closest("li")?.textContent).toContain("claude-code");
});

test("an Activity with no credit shows only its author", async () => {
  show([{ type: "authored", activity: note }, status()]);
  await screen.findByText("claude-code");
  expect(
    screen.queryByRole("button", { name: "Check limiter test coverage" }),
  ).toBeNull();
});

test("with Chat off a credit is not shown", async () => {
  show(
    [{ type: "authored", activity: { ...note, credited_to: creditedTests } }],
    false,
  );
  await screen.findByText("claude-code");
  expect(screen.queryByText("Check limiter test coverage")).toBeNull();
});
