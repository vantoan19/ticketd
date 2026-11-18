// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ChatClientContext } from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import { StatusLineRegion } from "@/components/ui/status-line";
import { chatState, createMockChatClient } from "@/features/chats/mock-client";
import * as rowMotion from "@/components/ui/row-motion";
import { motionTestbed } from "@/test/motion-testbed";
import { applyTokens, instantTokens } from "@/test/motion-tokens";
import { spring } from "@/lib/motion-tokens";

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
const travelMs = () => spring("travel").duration * 1000;

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

test("the header count is one child, so a changed number crossfades", async () => {
  await showList();
  const count = document.querySelector('[data-slot="count"]');
  expect(count?.querySelector('[data-slot="crossfade"]')?.textContent).toBe(
    "2",
  );
  // Read aloud with its noun, outside what crossfades.
  expect(count?.parentElement?.textContent).toContain("2 chats");
});

test("a Chat that now needs you travels to its group, then its fill arrives", async () => {
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
  await screen.findByRole("button", { name: /^Retries/ });
  const glide = vi.mocked(rowMotion.glide);
  glide.mockClear();
  // Only timers are faked: the fill waits on one, and time is the test's.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    expect(document.querySelector(".ui-arrival")).toBeNull();
    await act(async () => {
      client.push("c2", {
        id: "req-1",
        at: "2026-11-10T10:00:00Z",
        kind: "request",
        request: "approval",
        title: "Codex wants to run",
        subject: "npm test",
        options: [{ id: "once", label: "Allow once" }],
        free_text: false,
        state: "pending",
      });
      client.patch("c2", { activity: "waiting" });
    });
    expect(
      [...document.querySelectorAll(".chat-list-group")].map(
        (group) => group.textContent,
      ),
    ).toContain("Needs you");
    // The row that moved glides on the travel spring; the one that stayed does not.
    expect(glide.mock.calls.some(([, name]) => name === "travel")).toBe(true);
    // The fill waits for the row to get there: it is not on the page before
    // the travel spring ends, and is when it has.
    act(() => void vi.advanceTimersByTime(travelMs() - 1));
    expect(document.querySelector(".ui-arrival")).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    const fill = document.querySelector(".ui-arrival");
    expect(fill).toBeTruthy();
    expect(fill?.closest(".chat-row-item")?.textContent).toContain("Retries");
    expect(document.querySelectorAll(".ui-arrival")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
