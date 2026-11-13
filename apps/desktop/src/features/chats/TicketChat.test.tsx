// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatClientContext, type LinkedRecord } from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import { LinkedChats } from "@/features/chats/LinkedChats";
import { createMockChatClient } from "@/features/chats/mock-client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(cleanup);

const ticket: LinkedRecord = {
  kind: "ticket",
  id: "t1",
  reference: "T-KQ12",
  title: "Login rate limits",
  status: "Todo",
};

test("Chat about this ticket prefills New Chat and sends nothing until the person does", async () => {
  const client = createMockChatClient({ enabled: true, records: [ticket] });
  const create = vi.spyOn(client, "createChat");
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <LinkedChats
          ticket={{ ...ticket, trashed: false }}
          folder="/work/api"
        />
        <ChatsView />
      </ChatProvider>
    </ChatClientContext>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Chat about this ticket" }),
  );
  const box = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Describe a task or ask a question",
  });
  expect(box.value).toBe("Work on T-KQ12: Login rate limits");
  expect(screen.getByRole("button", { name: "Back to T-KQ12" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Folder: /work/api" }),
  ).toBeTruthy();
  expect(create).not.toHaveBeenCalled();

  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /Send/ }).disabled,
    ).toBe(false),
  );
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    folder: "/work/api",
    links: [{ kind: "ticket", id: "t1" }],
    message: "Work on T-KQ12: Login rate limits",
  });
});
