import { expect, test } from "vitest";
import type {
  ChatSnapshot,
  ChatSummary,
  Problem,
  Step,
} from "@/features/chats/client";
import {
  applyChange,
  chatTime,
  composerControls,
  composerPlaceholder,
  elapsed,
  harnessUsable,
  hasComposer,
  problemNotice,
  mergeSteps,
  stepWords,
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

const step = (over: Partial<Step> & Pick<Step, "kind">): Step => ({
  target: "",
  ...over,
});
const paths = (...texts: string[]) => texts.map((text) => ({ text }));
/** A row as one line: code targets in backticks, then the suffix after " · ". */
const line = (s: Step) => {
  const words = stepWords(s);
  const text = words.parts
    .map((part) => (part.code ? `\`${part.text}\`` : part.text))
    .join(" ");
  return words.suffix ? `${text} · ${words.suffix.text}` : text;
};

// The rows of the #366 design's fixtures, as the host classifies them.
test.each<[Step, string, string]>([
  [
    step({ kind: "read", targets: paths("src/auth/limiter.ts") }),
    "Read `src/auth/limiter.ts`",
    "",
  ],
  [
    step({ kind: "read", targets: paths("a.ts", "b.ts", "c.ts") }),
    "Read 3 files",
    "",
  ],
  [
    step({ kind: "search", targets: [{ text: "RateLimiter", scope: "src" }] }),
    "Searched for `RateLimiter` in `src`",
    "",
  ],
  [
    step({ kind: "search", targets: paths("*.test.ts") }),
    "Searched for `*.test.ts`",
    "",
  ],
  [
    step({
      kind: "search",
      targets: [{ text: "legacyLimiter", scope: "src" }],
      no_matches: true,
    }),
    "Searched for `legacyLimiter` in `src` · No matches",
    "",
  ],
  [
    step({
      kind: "search",
      targets: [
        { text: "a", scope: "src" },
        { text: "b", scope: "lib" },
      ],
    }),
    "Searched for `a` and `b`",
    "",
  ],
  [
    step({ kind: "read", variant: "list", targets: paths("src/auth") }),
    "Listed `src/auth`",
    "",
  ],
  [step({ kind: "read", variant: "list", targets: [] }), "Listed files", ""],
  [
    step({ kind: "edit", targets: paths("src/auth/config.ts") }),
    "Edited `src/auth/config.ts`",
    "",
  ],
  [
    step({ kind: "delete", targets: paths("coverage/*.json", "coverage") }),
    "Deleted `coverage/*.json` and `coverage`",
    "",
  ],
  [
    step({ kind: "run", command: "npm run typecheck", folder: "apps/desktop" }),
    "Ran `npm run typecheck`",
    "in apps/desktop",
  ],
  [
    step({ kind: "run", variant: "script", targets: paths("python3") }),
    "Ran a `python3` script",
    "",
  ],
  [
    step({
      kind: "run",
      command: "npm run test:limiter",
      state: "failed",
      exit_code: 1,
    }),
    "Run `npm run test:limiter` · Failed",
    "Exit 1",
  ],
  [
    step({
      kind: "run",
      command: "npm run test:e2e",
      state: "failed",
      exit_code: 124,
      timed_out: true,
      duration_ms: 600_000,
    }),
    "Run `npm run test:e2e` · Failed",
    "Timed out after 10m",
  ],
  [
    step({ kind: "delete", targets: paths("node_modules"), state: "declined" }),
    "Delete `node_modules` · Declined",
    "",
  ],
  [
    step({ kind: "run", command: "npm run dev", state: "not_finished" }),
    "Run `npm run dev` · Not finished",
    "",
  ],
  [
    step({ kind: "run", command: "npm run bench", state: "unknown" }),
    "Run `npm run bench` · Not confirmed",
    "",
  ],
  [
    step({ kind: "read", targets: paths("a.ts"), state: "running" }),
    "Reading `a.ts`",
    "",
  ],
  [
    step({ kind: "web", targets: paths("tauri updater") }),
    "Searched the web for “tauri updater”",
    "",
  ],
  [
    step({ kind: "web", variant: "fetch", targets: paths("docs.rs/serde") }),
    "Fetched `docs.rs/serde`",
    "",
  ],
  [
    step({ kind: "create", targets: paths("a.ts", "b.ts", "c.ts") }),
    "Created 3 files",
    "",
  ],
  [
    step({ kind: "other", targets: paths("mcp__linear__get_issue") }),
    "Used `mcp__linear__get_issue`",
    "",
  ],
  [
    step({ kind: "other", target: "ticketd gave Codex this Chat's context" }),
    "ticketd gave Codex this Chat's context",
    "",
  ],
  [
    step({ kind: "read", targets: [{ text: "a.ts", lines: [40, 90] }] }),
    "Read `a.ts`",
    "lines 40–90",
  ],
])("a step reads as one line: %#", (s, row, detail) => {
  expect(line(s)).toBe(row);
  expect(stepWords(s).detail).toBe(detail);
});

test("a command shows its first line, and its name says its outcome", () => {
  const words = stepWords(
    step({ kind: "run", command: "python3 -c '\nprint(1)'", state: "failed" }),
  );
  expect(words.parts[1]?.text).toBe("python3 -c '");
  expect(words.label).toBe("Run python3 -c ', Failed");
});

test("steps of the same kind and outcome merge, but commands never do", () => {
  const merged = mergeSteps([
    step({ kind: "read", targets: paths("a.ts"), output: "x" }),
    step({ kind: "read", targets: paths("b.ts", "c.ts") }),
    step({ kind: "read", targets: paths("d.ts"), state: "failed" }),
    step({ kind: "run", command: "npm test" }),
    step({ kind: "run", command: "npm run lint" }),
    step({ kind: "search", targets: paths("x"), no_matches: true }),
    step({ kind: "search", targets: paths("y") }),
  ]);
  expect(merged.map(line)).toEqual([
    "Read 3 files",
    "Read `d.ts` · Failed",
    "Ran `npm test`",
    "Ran `npm run lint`",
    "Searched for `x` and `y`",
  ]);
  // A merged row opens to its targets, not to one step's output.
  expect(merged[0]?.output).toBeUndefined();
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

test("the send button reads Send, Steer or Queue, set by the turn", () => {
  const idle = chatState({ id: "c1", title: "x" });
  expect(composerControls(idle, "")).toEqual({ send: "send", enabled: false });
  expect(composerControls(idle, "hi")).toEqual({ send: "send", enabled: true });
  const working = chatState({
    id: "c1",
    title: "x",
    activity: "working",
    steering: {
      available: true,
      effect: "Joins after the current tool finishes",
    },
  });
  // Nothing typed: the button still names what Enter would do.
  expect(composerControls(working, " ")).toEqual({
    send: "steer",
    enabled: false,
    queues: false,
    effect: "Joins after the current tool finishes",
  });
  expect(composerControls(working, "hi")).toMatchObject({
    send: "steer",
    enabled: true,
    queues: true,
  });
  const noSteer = { ...working, steering: { available: false } };
  expect(composerControls(noSteer, "hi")).toEqual({
    send: "queue",
    enabled: true,
    queues: true,
    effect: "Codex can't steer, so this waits for the turn to end.",
  });
});

test("an open question makes Send answer it; stopping makes Send wait while Cmd+Enter still queues", () => {
  const waiting = chatState({ id: "c1", title: "x", activity: "waiting" });
  expect(composerControls(waiting, "hi", true)).toEqual({
    send: "send",
    enabled: true,
    queues: true,
  });
  const stopping = { ...waiting, activity: "working" as const, stopping: true };
  expect(composerControls(stopping, "hi")).toEqual({
    send: "send",
    enabled: false,
    queues: true,
  });
});

test("the placeholder says what sending will do", () => {
  const idle = chatState({ id: "c1", title: "x" });
  expect(composerPlaceholder(idle, false)).toBe("Message Codex");
  const working = { ...idle, activity: "working" as const };
  expect(composerPlaceholder(working, false)).toBe("Steer Codex");
  expect(composerPlaceholder(working, true)).toBe("Answer, or pick above");
  expect(composerPlaceholder({ ...working, stopping: true }, false)).toBe(
    "Message Codex",
  );
  expect(
    composerPlaceholder({ ...working, steering: { available: false } }, false),
  ).toBe("Queue for Codex");
});

test("only a problem observed now disables Send; why the last turn stopped does not", () => {
  const withProblem = (problem: Problem) =>
    composerControls(
      chatState({ id: "c1", title: "x", activity: "failed", problem }),
      "hi",
    );
  expect(withProblem({ kind: "not_signed_in" })).toEqual({
    send: "send",
    enabled: false,
  });
  expect(withProblem({ kind: "uncertain_delivery" })).toEqual({
    send: "send",
    enabled: false,
  });
  for (const kind of [
    "usage_limit",
    "not_signed_in",
    "sandbox_unavailable",
    "session_in_use",
  ] as const)
    expect(withProblem({ kind, past: true }), kind).toEqual({
      send: "send",
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

test("a stop that was not confirmed is one notice, and Stop itself is the retry", () => {
  expect(problemNotice({ kind: "stop_unconfirmed" }, "Codex")).toEqual({
    tone: "neutral",
    title: "Stop not confirmed",
    body: "Codex may still be running.",
    actions: [],
  });
});
