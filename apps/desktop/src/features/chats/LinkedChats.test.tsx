// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ChatClientContext,
  type LinkedRecord,
  type TranscriptItem,
} from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { LinkedChats } from "@/features/chats/LinkedChats";
import {
  chatState,
  createMockChatClient,
  type MockChat,
} from "@/features/chats/mock-client";
import { useChatFeature } from "@/features/chats/use-chats";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(cleanup);

const ticket: LinkedRecord = {
  kind: "ticket",
  id: "t1",
  reference: "T-KQ12",
  title: "Login rate limits",
  status: "In progress",
};
const at = "2026-11-10T10:00:00Z";
const approval: TranscriptItem = {
  id: "req-1",
  at,
  kind: "request",
  request: "approval",
  title: "Codex wants to run a command",
  subject: "npm test",
  options: [{ id: "once", label: "Allow once" }],
  free_text: false,
  state: "pending",
};

let requested: unknown = null;
function Requests() {
  requested = useChatFeature().chatRequest?.request ?? null;
  return null;
}

function show(chats: MockChat[]) {
  const client = createMockChatClient({ enabled: true, chats });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <Requests />
        <LinkedChats
          ticket={{
            id: "t1",
            reference: "T-KQ12",
            title: "Login rate limits",
            status: "In progress",
            trashed: false,
          }}
          folder="/work/api"
        />
      </ChatProvider>
    </ChatClientContext>,
  );
  return client;
}

test("the Chats line names how many and the top-ranked status, and opens a Chat with the way back", async () => {
  show([
    {
      chat: chatState({ id: "a", title: "Tidy limiter", links: [ticket] }),
      updated_at: "2026-11-10T09:00:00Z",
    },
    {
      chat: chatState({
        id: "b",
        title: "Fix the lockout",
        activity: "waiting",
        links: [ticket],
      }),
      items: [approval],
      updated_at: "2026-11-10T09:30:00Z",
    },
    { chat: chatState({ id: "c", title: "Unrelated" }) },
  ]);
  const line = await screen.findByRole("button", {
    name: "Chats: 2, Approval needed",
  });
  expect(line.getAttribute("aria-haspopup")).toBe("menu");
  fireEvent.keyDown(line, { key: "Enter" });
  const item = await screen.findByRole("menuitem", {
    name: "Fix the lockout, Codex, Approval needed",
  });
  expect(screen.queryByText("Unrelated")).toBeNull();
  fireEvent.click(item);
  expect(requested).toEqual({
    kind: "open",
    chatId: "b",
    retention: "active",
    from: "T-KQ12",
  });
});

test("Chat about this ticket asks for New Chat with the ticket and its Project's folder", async () => {
  show([]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Chat about this ticket" }),
  );
  await waitFor(() =>
    expect(requested).toEqual({
      kind: "new",
      start: { ticket, folder: "/work/api" },
    }),
  );
  expect(screen.queryByRole("button", { name: /^Chats:/ })).toBeNull();
});
