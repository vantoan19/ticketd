import { expect, test } from "vitest";
import type {
  ChatSnapshot,
  ChatSummary,
  Problem,
} from "@/features/chats/client";
import {
  applyChange,
  chatTime,
  composerControls,
  elapsed,
  harnessUsable,
  hasComposer,
  problemNotice,
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

test("the row summary shows the last response as plain text", () => {
  expect(
    summaryLine(row({ preview: "There are **0 entries**. I ran `ls` here." })),
  ).toBe("There are 0 entries. I ran ls here.");
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

test("only a problem observed now disables Send; why the last turn stopped does not", () => {
  const withProblem = (problem: Problem) =>
    composerControls(
      chatState({ id: "c1", title: "x", activity: "failed", problem }),
      "hi",
    );
  expect(withProblem({ kind: "not_signed_in" })).toEqual({
    kind: "send",
    enabled: false,
  });
  expect(withProblem({ kind: "uncertain_delivery" })).toEqual({
    kind: "send",
    enabled: false,
  });
  for (const kind of [
    "usage_limit",
    "not_signed_in",
    "sandbox_unavailable",
    "session_in_use",
  ] as const)
    expect(withProblem({ kind, past: true }), kind).toEqual({
      kind: "send",
      enabled: true,
    });
  const composer = (problem: Problem) =>
    hasComposer(chatState({ id: "c1", title: "x", problem }));
  expect(composer({ kind: "history_lost" })).toBe(false);
  expect(composer({ kind: "history_lost", past: true })).toBe(true);
});

test("a past failure is told as the last turn's, with Check again only where a probe can tell", () => {
  const signIn = problemNotice(
    { kind: "not_signed_in", past: true, command: "codex login" },
    "Codex",
  );
  expect(signIn.body).toMatch(/^The last turn stopped because/);
  expect(signIn.actions).toEqual(["copy-command", "check"]);
  for (const kind of ["usage_limit", "session_in_use"] as const) {
    const notice = problemNotice({ kind, past: true }, "Codex");
    expect(notice.actions, kind).toEqual([]);
    expect(notice.body, kind).toMatch(/last turn/);
  }
  const sandbox = problemNotice(
    { kind: "sandbox_unavailable", past: true },
    "Codex",
  );
  expect(sandbox.actions).toEqual(["help"]);
  expect(sandbox.body).toMatch(/last turn/);
  // Met now, the same kinds keep Check again and say nothing of a last turn.
  const live = problemNotice({ kind: "session_in_use" }, "Codex");
  expect(live.actions).toEqual(["check"]);
  expect(live.body).not.toMatch(/last turn/);
});

test("a row says a past sign-in failure as a stopped turn, not as unsent", () => {
  const line = (over: Partial<ChatSummary>) =>
    summaryLine({
      id: "c1",
      title: "x",
      harness_name: "Codex",
      retention: "active",
      activity: "failed",
      needs_you: false,
      updated_at: at,
      ...over,
    });
  expect(line({ problem: "not_signed_in" })).toBe("Not sent");
  expect(line({ problem: "not_signed_in", problem_past: true })).toBe(
    "Stopped: not signed in",
  );
  expect(line({ problem: "usage_limit", problem_past: true })).toBe(
    "Stopped: usage limit reached",
  );
});

test("a usage limit says when it resets, or says that the provider did not", () => {
  const at = new Date(2026, 10, 12, 15, 0).getTime() / 1000;
  const told = problemNotice(
    { kind: "usage_limit", message: "You've hit your limit.", resets_at: at },
    "Codex",
  ).body;
  expect(told).toContain("You've hit your limit.");
  expect(told).toContain("It says the limit resets on Nov 12 at 3:00 PM.");
  expect(told).not.toContain("didn't say");

  const untold = problemNotice(
    { kind: "usage_limit", message: "You've hit your limit." },
    "Codex",
  ).body;
  expect(untold).toContain("You've hit your limit.");
  expect(untold).toContain("It didn't say when the limit resets.");
  expect(problemNotice({ kind: "usage_limit" }, "Codex").body).toContain(
    "It didn't say when the limit resets.",
  );
});

test("a refused resend is said first, and the first attempt stays unconfirmed", () => {
  const notice = problemNotice(
    {
      kind: "uncertain_delivery",
      message:
        "You asked to send it again and Codex did not accept that: busy.",
    },
    "Codex",
  );
  expect(notice.body).toMatch(
    /^You asked to send it again and Codex did not accept that: busy\. /,
  );
  expect(notice.body).not.toContain("It hasn't been sent again");
  expect(notice.body).toContain("no confirmation");
  expect(notice.actions).toEqual(["resend", "discard"]);
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

test("an uncertain delivery is worded without assuming why, and a set-aside harness status is usable", () => {
  const notice = problemNotice({ kind: "uncertain_delivery" }, "Codex");
  expect(notice.body).not.toMatch(/connection dropped/);
  expect(notice.actions).toEqual(["resend", "discard"]);
  expect(harnessUsable("not_subscription")).toBe(true);
  expect(harnessUsable("sign_in_unknown")).toBe(true);
  expect(harnessUsable("not_signed_in")).toBe(false);
});

test("a missing folder is told without claiming a restore happened", () => {
  const notice = problemNotice(
    { kind: "folder_missing", path: "/work/app" },
    "Codex",
  );
  expect(notice.body).toBe(
    "`/work/app` wasn't found. Nothing was re-run. Put it back and check again, or pick another folder to keep going here.",
  );
  // L9: a folder moved back is seen without picking another one.
  expect(notice.actions).toEqual(["check", "pick-folder"]);
});

test("a step that has not run, or did not complete, is not counted as run", () => {
  expect(
    stepTally([
      { verb: "ran", target: "npm test", more: 0, state: "done" },
      { verb: "ran", target: "rm -rf dist", more: 0, state: "running" },
      { verb: "ran", target: "touch hello.txt", more: 0, state: "failed" },
    ]),
  ).toBe("Ran 1 command, 1 step in progress, 1 step did not complete");
  expect(
    stepTally([{ verb: "ran", target: "touch a", more: 0, state: "running" }]),
  ).toBe("1 step in progress");
});

test("a missing ticketd component is a reinstall notice, not an update of the harness", () => {
  const notice = problemNotice(
    {
      kind: "unavailable",
      message: "ticketd's Claude bridge is missing. Reinstall ticketd.",
    },
    "Claude Code",
  );
  expect(notice.title).toBe("Claude Code isn't available");
  expect(notice.body).not.toMatch(/Update it/);
  expect(notice.actions).toEqual(["check"]);
});
