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
import { ChatClientContext } from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { chatState, createMockChatClient } from "@/features/chats/mock-client";
import { NEW_CHAT, clearQuotes, useQuotes } from "@/features/chats/quotes";
import { chatSource } from "@/features/chats/quotes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  cleanup();
  clearQuotes(NEW_CHAT);
  clearQuotes("linked");
});

function Quotes({ id }: { id: string }) {
  const { quotes } = useQuotes(id);
  return (
    <output aria-label={`Quotes in ${id}`}>
      {quotes.map((quote) => `${quote.source}: ${quote.text}`).join("|")}
    </output>
  );
}

function selectText(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

test("⌘L on selected rendered text offers linked Chats first and quotes the text into the one picked", async () => {
  const ticket = {
    kind: "ticket" as const,
    id: "t1",
    reference: "T-KQ12",
    title: "Login",
    status: "Todo",
  };
  const client = createMockChatClient({
    enabled: true,
    chats: [
      {
        chat: chatState({ id: "recent", title: "Recent work" }),
        updated_at: "2026-11-10T09:50:00Z",
      },
      {
        chat: chatState({ id: "linked", title: "Lockout", links: [ticket] }),
        updated_at: "2026-11-10T09:00:00Z",
      },
    ],
  });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <div
          {...chatSource("T-KQ12 · Description", { kind: "ticket", id: "t1" })}
        >
          <p>Lock the account after five tries.</p>
        </div>
        <Quotes id="linked" />
      </ChatProvider>
    </ChatClientContext>,
  );
  await waitFor(() => expect(client.getEnabled()).resolves.toBe(true));
  act(() => selectText(screen.getByText("Lock the account after five tries.")));
  fireEvent.keyDown(document, { key: "l", metaKey: true });
  await screen.findAllByRole("menuitem");
  await waitFor(() =>
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["LockoutIdle", "Recent workIdle", "New Chat"]),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: /^Lockout/ }));
  expect(
    screen.getByRole("status", { name: "Quotes in linked" }).textContent,
  ).toBe("T-KQ12 · Description: Lock the account after five tries.");
});

test("a triple-clicked last paragraph, whose selection ends at the next block, still offers Add to chat", async () => {
  const client = createMockChatClient({ enabled: true, chats: [] });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <div {...chatSource("T-KQ12 · Description", { kind: "ticket", id: "t1" })}>
          <p>Lock the account after five tries.</p>
        </div>
        <section>
          <p>Subtickets</p>
        </section>
        <Quotes id={NEW_CHAT} />
      </ChatProvider>
    </ChatClientContext>,
  );
  await waitFor(() => expect(client.getEnabled()).resolves.toBe(true));
  // WebKit selects a paragraph up to offset 0 of the block after it.
  act(() => {
    const range = document.createRange();
    range.setStart(
      screen.getByText("Lock the account after five tries.").firstChild!,
      0,
    );
    range.setEnd(screen.getByText("Subtickets"), 0);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  fireEvent.keyDown(document, { key: "l", metaKey: true });
  fireEvent.click(await screen.findByRole("menuitem", { name: "New Chat" }));
  expect(
    screen.getByRole("status", { name: `Quotes in ${NEW_CHAT}` }).textContent,
  ).toBe("T-KQ12 · Description: Lock the account after five tries.");
});

test("a selection running past the source into other text is not offered", async () => {
  const client = createMockChatClient({ enabled: true, chats: [] });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <div {...chatSource("T-KQ12 · Description", { kind: "ticket", id: "t1" })}>
          <p>Lock the account after five tries.</p>
        </div>
        <p>Subtickets</p>
      </ChatProvider>
    </ChatClientContext>,
  );
  await waitFor(() => expect(client.getEnabled()).resolves.toBe(true));
  act(() => {
    const range = document.createRange();
    range.setStart(
      screen.getByText("Lock the account after five tries.").firstChild!,
      0,
    );
    range.setEnd(screen.getByText("Subtickets").firstChild!, 4);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  fireEvent.keyDown(document, { key: "l", metaKey: true });
  expect(screen.queryByRole("menuitem")).toBeNull();
});
