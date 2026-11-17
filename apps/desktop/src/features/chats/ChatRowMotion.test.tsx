// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ChatClientContext } from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import { StatusLineRegion } from "@/components/ui/status-line";
import { chatState, createMockChatClient } from "@/features/chats/mock-client";
import * as rowMotion from "@/components/ui/row-motion";
import { motionTestbed } from "@/test/motion-testbed";
import { applyTokens, instantTokens } from "@/test/motion-tokens";

// A Chat row moves as every list row does (DESIGN.md section 12): the shared
// row motion, read as the row renders so a held key and reduced motion reach it.

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/components/ui/row-motion", async (original) => {
  const real = await original<typeof import("@/components/ui/row-motion")>();
  return { ...real, glide: vi.fn(real.glide) };
});
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

motionTestbed();

async function showList() {
  const client = createMockChatClient({
    enabled: true,
    chats: [
      { chat: chatState({ id: "c1", title: "Limiter" }) },
      { chat: chatState({ id: "c2", title: "Retries" }) },
    ],
    records: [],
  });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <StatusLineRegion>
          <ChatsView />
        </StatusLineRegion>
      </ChatProvider>
    </ChatClientContext>,
  );
  return screen.findByRole("button", { name: /^Retries/ });
}

test("every Chat row is marked for a page arrival", async () => {
  await showList();
  const rows = [...document.querySelectorAll(".chat-row-item")];
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.getAttribute("data-arrive"))).toEqual([
    "row",
    "row",
  ]);
});

test("a row reads its glide as it renders, so a held key reaches it", async () => {
  const retries = await showList();
  const glide = vi.mocked(rowMotion.glide);
  const last = () => glide.mock.results.at(-1)?.value.transition.layout;
  expect(last().duration).toBeGreaterThan(0);
  // Keys held: the guard zeroes the springs. The next render must see it.
  const restore = applyTokens(instantTokens);
  glide.mockClear();
  fireEvent.click(retries);
  expect(glide).toHaveBeenCalled();
  expect(last().duration).toBe(0);
  restore();
});

test("the rows share one order, so they are measured when it changes", async () => {
  await showList();
  const glide = vi.mocked(rowMotion.glide);
  const orders = new Set(glide.mock.calls.map(([order]) => String(order)));
  // One list order, with each row's group: not undefined, which measures always.
  expect([...orders].every((order) => order.startsWith("c1,c2:"))).toBe(true);
});
