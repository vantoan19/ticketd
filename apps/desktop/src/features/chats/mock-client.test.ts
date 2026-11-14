import { expect, test } from "vitest";
import type { ChatChange, TranscriptItem } from "@/features/chats/client";
import { chatState, createMockChatClient } from "@/features/chats/mock-client";

const at = "2026-11-10T10:00:00Z";
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
const working = (over = {}) =>
  createMockChatClient({
    chats: [
      {
        chat: chatState({
          id: "c1",
          title: "Limiter",
          activity: "working",
          ...over,
        }),
        items: [approval],
      },
    ],
  });

test("a request takes one answer; a second is refused as stale", async () => {
  const client = working({ activity: "waiting" });
  await client.answer("c1", "req-1", { option_id: "once" });
  await expect(
    client.answer("c1", "req-1", { option_id: "once" }),
  ).rejects.toMatchObject({ code: "stale" });
  const { items } = await client.openChat("c1");
  expect(items[0]).toMatchObject({
    state: "answered",
    outcome: 'You chose "Allow once"',
  });
});

test("Stop pauses the queue, keeps what was queued and expires the live request", async () => {
  const client = working();
  await client.queue("c1", "then add tests");
  await client.stop("c1");
  const { chat, items } = await client.openChat("c1");
  expect(chat).toMatchObject({
    activity: "interrupted",
    queue_paused: true,
    queue: [{ text: "then add tests" }],
  });
  expect(items[0]).toMatchObject({ state: "expired" });
  expect(items.at(-1)).toMatchObject({ kind: "marker", reason: "stopped" });
});

test("sending mid-turn is queued when the harness cannot be steered", async () => {
  const client = working({ steering: { available: false } });
  await client.send("c1", "also update the docs");
  const { chat, items } = await client.openChat("c1");
  expect(chat.queue).toEqual([
    { id: expect.any(String), text: "also update the docs" },
  ]);
  expect(items.some((item) => item.kind === "user")).toBe(false);
});

test("trash stops the work and restore never restarts it", async () => {
  const client = working();
  await client.queue("c1", "next");
  await client.trash("c1");
  expect(await client.listChats("active")).toEqual([]);
  await client.restore("c1");
  const { chat, items } = await client.openChat("c1");
  expect(chat).toMatchObject({
    retention: "active",
    activity: "interrupted",
    queue: [{ text: "next" }],
  });
  expect(items.filter((item) => item.kind === "user")).toEqual([]);
});

test("a subscriber whose cursor is older than the kept log is told to resync", async () => {
  const client = createMockChatClient({
    logLimit: 2,
    chats: [{ chat: chatState({ id: "c1", title: "Limiter" }) }],
  });
  for (const text of ["a", "b", "c"])
    client.push("c1", {
      id: text,
      at,
      kind: "marker",
      reason: "note",
      message: text,
    });
  const seen: ChatChange[] = [];
  client.subscribe("c1", 0, (change) => seen.push(change));
  expect(seen).toEqual([{ seq: 3, kind: "resync" }]);
  const recent: ChatChange[] = [];
  client.subscribe("c1", 2, (change) => recent.push(change));
  expect(recent).toMatchObject([{ seq: 3, kind: "item" }]);
});

test("the overview counts Chats that need the person and Chats at work", async () => {
  const client = working({ activity: "waiting" });
  expect(await client.overview()).toEqual({
    needs_you: 1,
    unread: 0,
    app_icon: 1,
    working: 1,
  });
  const seen: unknown[] = [];
  client.subscribeOverview((overview) => seen.push(overview));
  await client.stop("c1");
  expect(seen.at(-1)).toEqual({
    needs_you: 0,
    unread: 0,
    app_icon: 0,
    working: 0,
  });
});

test("the count takes uncertain delivery and failures, not a sign-in step alone", async () => {
  const chat = (id: string, over: object) => ({
    chat: chatState({ id, title: id, ...over }),
  });
  const client = createMockChatClient({
    chats: [
      chat("uncertain", { problem: { kind: "uncertain_delivery" } }),
      chat("failed", { activity: "failed" }),
      chat("lost", { problem: { kind: "failed" } }),
      chat("install", {
        activity: "failed",
        problem: { kind: "not_installed" },
      }),
      chat("sign-in", { problem: { kind: "not_signed_in" } }),
      chat("idle", {}),
    ],
  });
  expect((await client.overview()).needs_you).toBe(4);
  const counted = (await client.listChats("active"))
    .filter((row) => row.needs_you)
    .map((row) => row.id);
  // An install failure that stopped a turn counts until seen (spec 21.3).
  expect(counted.sort()).toEqual(["failed", "install", "lost", "uncertain"]);
});

test("quitting stops working Chats and says why in their history", async () => {
  const client = working();
  let asked: unknown = null;
  client.onQuitRequested((stopping) => (asked = stopping));
  client.requestQuit();
  expect(asked).toEqual({ chats: 1, runs: 0 });
  await client.answerQuit(true);
  const { items } = await client.openChat("c1");
  expect(items.at(-1)).toMatchObject({ kind: "marker", reason: "quit" });
  expect(client.quit).toBe(true);
});
