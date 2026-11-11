import { expect, test } from "vitest";
import type { ChatSnapshot, ChatSummary } from "@/features/chats/client";
import {
  applyChange,
  chatTime,
  composerControls,
  elapsed,
  stepTally,
  summaryLine,
} from "@/features/chats/model";
import { chatState } from "@/features/chats/mock-client";

const at = "2026-11-10T10:00:00Z";
const snapshot = (): ChatSnapshot => ({
  chat: chatState({ id: "c1", title: "Limiter" }),
  items: [{ id: "r1", at, kind: "response", text: "Hel", state: "streaming" }],
  cursor: 4,
});

test("streamed text is appended to its response in order", () => {
  const next = applyChange(snapshot(), {
    seq: 5,
    kind: "text",
    item_id: "r1",
    text: "lo",
  });
  expect(next).toMatchObject({ cursor: 5, items: [{ text: "Hello" }] });
});

test("an item change replaces the item with the same id and appends a new one", () => {
  let next = applyChange(snapshot(), {
    seq: 5,
    kind: "item",
    item: { id: "r1", at, kind: "response", text: "Done.", state: "complete" },
  });
  next = applyChange(next as ChatSnapshot, {
    seq: 6,
    kind: "item",
    item: { id: "u2", at, kind: "user", text: "Thanks", delivery: "sending" },
  });
  expect((next as ChatSnapshot).items.map((item) => item.id)).toEqual([
    "r1",
    "u2",
  ]);
  expect((next as ChatSnapshot).items[0]).toMatchObject({ text: "Done." });
});

test("a gap in the sequence, or a resync marker, asks for a fresh snapshot", () => {
  const skipped = { seq: 7, kind: "text", item_id: "r1", text: "!" } as const;
  expect(applyChange(snapshot(), skipped)).toBe("resync");
  expect(applyChange(snapshot(), { seq: 5, kind: "resync" })).toBe("resync");
});

test("a change the snapshot already includes is ignored", () => {
  const before = snapshot();
  const old = { seq: 4, kind: "text", item_id: "r1", text: "x" } as const;
  expect(applyChange(before, old)).toBe(before);
});

test("the steps tally counts merged reads and handles singular and plural", () => {
  expect(
    stepTally([
      { verb: "read", target: "a.ts", more: 5 },
      { verb: "edited", target: "b.ts", more: 0 },
      { verb: "ran", target: "npm test", more: 0 },
      { verb: "ran", target: "npm run lint", more: 0 },
    ]),
  ).toBe("Read 6 files, edited 1 file, ran 2 commands");
  expect(
    stepTally([{ verb: "other", target: "Searched the web", more: 0 }]),
  ).toBe("1 other step");
});

const row = (over: Partial<ChatSummary>): ChatSummary => ({
  id: "c1",
  title: "Limiter",
  harness_name: "Codex",
  retention: "active",
  activity: "idle",
  needs_you: false,
  updated_at: at,
  ...over,
});

test("a list row says what the Chat is doing in the design's words", () => {
  expect(summaryLine(row({ activity: "waiting", needs_you: true }))).toBe(
    "Waiting for you",
  );
  expect(
    summaryLine(row({ needs_you: true, problem: "uncertain_delivery" })),
  ).toBe("Needs your decision");
  expect(summaryLine(row({ activity: "working" }))).toBe("Working…");
  expect(summaryLine(row({ activity: "failed", problem: "usage_limit" }))).toBe(
    "Stopped: usage limit reached",
  );
  expect(
    summaryLine(row({ activity: "interrupted", interruption: "stopped" })),
  ).toBe("You stopped this turn");
  expect(
    summaryLine(
      row({
        last_change: {
          kind: "status",
          reference: "T-12",
          title: "Rate-limit logins",
          from: "In progress",
          to: "In review",
        },
        preview: "All done",
      }),
    ),
  ).toBe("Moved T-12 to In review");
  expect(summaryLine(row({ preview: "All done" }))).toBe("All done");
});

test("plain states the design did not draw still read as words", () => {
  expect(summaryLine(row({ activity: "failed" }))).toBe("Failed");
  expect(summaryLine(row({ activity: "interrupted" }))).toBe("Interrupted");
  expect(
    summaryLine(row({ activity: "interrupted", interruption: "unconfirmed" })),
  ).toBe("Stop not confirmed");
  expect(summaryLine(row({}))).toBe("Idle");
});

test("the composer offers Send, Stop or Queue for the turn's state", () => {
  const chat = chatState({ id: "c1", title: "x" });
  expect(composerControls(chat, "")).toEqual({ kind: "send", enabled: false });
  expect(composerControls(chat, "hi")).toEqual({ kind: "send", enabled: true });
  const working = { ...chat, activity: "working" as const };
  expect(composerControls(working, " ")).toEqual({ kind: "stop" });
  expect(composerControls(working, "hi")).toEqual({
    kind: "steer",
    hint: "Send adds this to the turn in progress. Queue holds it until the turn ends.",
  });
});

test("when steering is unavailable, typing while working can only queue", () => {
  const working = chatState({
    id: "c1",
    title: "x",
    activity: "working",
    steering: { available: false },
  });
  expect(composerControls(working, "hi")).toEqual({
    kind: "queue-only",
    hint: "Codex can't take messages mid-turn. This will be queued until the turn ends.",
  });
});

test("a blocking problem disables Send without hiding what was typed", () => {
  const blocked = chatState({
    id: "c1",
    title: "x",
    activity: "failed",
    problem: { kind: "usage_limit" },
  });
  expect(composerControls(blocked, "hi")).toEqual({
    kind: "send",
    enabled: false,
  });
});

test("times read as now, minutes, hours, Yesterday, then a date", () => {
  const now = new Date(2026, 10, 10, 12, 0).getTime();
  const ago = (minutes: number) =>
    new Date(now - minutes * 60_000).toISOString();
  expect(chatTime(ago(0), now)).toBe("now");
  expect(chatTime(ago(2), now)).toBe("2m");
  expect(chatTime(ago(61), now)).toBe("1h");
  expect(chatTime(ago(60 * 20), now)).toBe("Yesterday");
  expect(chatTime(new Date(2026, 10, 8, 9).toISOString(), now)).toBe("Nov 8");
});

test("elapsed time reads in seconds, then minutes and seconds", () => {
  expect(elapsed(12_000)).toBe("12s");
  expect(elapsed(134_000)).toBe("2m 14s");
});
