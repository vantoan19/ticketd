import { expect, test, vi } from "vitest";
import type {
  ChatSnapshot,
  Step,
  TranscriptItem,
} from "@/features/chats/client";
import {
  applyChange,
  firstNew,
  unseenFrom,
  receiptLine,
  turns,
  workedFor,
  type TranscriptPart,
  type Turn,
  chatTime,
  composerControls,
  composerPlaceholder,
  duration,
  problemNotice,
  mergeSteps,
  stepWords,
} from "@/features/chats/model";
import {
  chatState,
  hostProblem,
  type ProblemInput,
} from "@/features/chats/mock-client";

/** The notice for a problem as the host would send it for Codex. */
const noticeOf = (problem: ProblemInput, harness = "Codex") =>
  problemNotice(hostProblem(problem, harness), harness);

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
    "Run `npm run test:e2e` · Timed out",
    "Stopped after 10m",
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

test("a command with a description reads the description, and one without reads its first line", () => {
  const run = (over: Partial<Step>) =>
    step({ kind: "run", target: "npm test", command: "npm test", ...over });
  const described = run({ description: "Run the unit tests" });
  expect(line(described)).toBe("Run the unit tests");
  expect(stepWords(described).label).toBe("Run the unit tests");
  // Running: the same words (the row adds the clock); failed: the outcome follows.
  expect(line({ ...described, state: "running" })).toBe("Run the unit tests");
  expect(line({ ...described, state: "failed" })).toBe(
    "Run the unit tests · Failed",
  );
  expect(stepWords({ ...described, state: "failed" }).label).toBe(
    "Run the unit tests, Failed",
  );
  // No description: the command's first line, set apart as one muted line.
  const plain = stepWords(run({ command: "npm test\n--watch" }));
  expect(plain.parts).toEqual([
    { text: "Ran" },
    { text: "npm test", code: true, command: true },
  ]);
  // ticketd calls keep their sentences, and a script reads the description too.
  const ticketd = run({
    description: "Move the ticket",
    ticketd: [{ verb: "set", words: [{ text: "T-1", code: true }] }],
  });
  expect(line(ticketd)).not.toContain("Move the ticket");
  expect(line(run({ variant: "script", description: "Check the icons" }))).toBe(
    "Check the icons",
  );
});

test("a path in a row is a path part, and a glob scope is not", () => {
  const parts = (s: Step) => stepWords(s).parts;
  expect(
    parts(step({ kind: "read", targets: paths("gen/icons.py") }))[1],
  ).toEqual({
    text: "gen/icons.py",
    code: true,
    path: true,
  });
  expect(
    parts(step({ kind: "search", targets: [{ text: "x", scope: "src" }] }))[3],
  ).toEqual({ text: "src", code: true, path: true });
  expect(
    parts(
      step({ kind: "search", targets: [{ text: "x", scope: "src/**/*.ts" }] }),
    )[3],
  ).toEqual({ text: "src/**/*.ts", code: true });
  // A search's pattern is not a path.
  expect(parts(step({ kind: "search", targets: paths("a/b") }))[1]).toEqual({
    text: "a/b",
    code: true,
  });
});

test("nothing removed is not said as a count of zero", () => {
  const edit = step({
    kind: "create",
    targets: paths("gen/icons.py"),
    added_lines: 57,
    removed_lines: 0,
  });
  const words = stepWords(edit);
  expect(words.suffix?.text).toBe("+57");
  expect(words.label).toBe("Created gen/icons.py, 57 lines added");
  expect(stepWords({ ...edit, removed_lines: 2 }).suffix?.text).toBe("+57 −2");
});

test("a run of reads and searches is one row, 'Explored 6 files · 2 searches'", () => {
  const read = (...files: string[]) =>
    step({ kind: "read", targets: paths(...files), output: "x" });
  const search = (query: string, over: Partial<Step> = {}) =>
    step({ kind: "search", targets: [{ text: query, scope: "src" }], ...over });
  const merged = mergeSteps([
    read("a.ts", "b.ts"),
    search("x"),
    read("c.ts"),
    read("d.ts", "e.ts", "f.ts"),
    search("y"),
    step({ kind: "run", command: "npm test", target: "npm test" }),
    read("g.ts"),
  ]);
  expect(merged.map(line)).toEqual([
    "Explored 6 files · 2 searches",
    "Ran `npm test`",
    "Read `g.ts`",
  ]);
  expect(merged[0]?.output).toBeUndefined();
  // Opened, it lists what each kind named.
  expect(merged[0]?.explored?.files.map((target) => target.text)).toEqual([
    "a.ts",
    "b.ts",
    "c.ts",
    "d.ts",
    "e.ts",
    "f.ts",
  ]);
  expect(merged[0]?.explored?.searches).toHaveLength(2);
  // One of each is already an exploration; its words count the singular.
  expect(mergeSteps([read("a.ts"), search("x")]).map(line)).toEqual([
    "Explored 1 file · 1 search",
  ]);
  // A failure, a search that found nothing, and a folder listing keep their own rows.
  expect(
    mergeSteps([
      read("a.ts"),
      step({ kind: "read", targets: paths("b.ts"), state: "failed" }),
      search("x", { no_matches: true }),
      read("c.ts"),
      step({ kind: "read", variant: "list", targets: paths("src") }),
    ]).map(line),
  ).toEqual([
    "Read `a.ts`",
    "Read `b.ts` · Failed",
    "Searched for `x` in `src` · No matches",
    "Read `c.ts`",
    "Listed `src`",
  ]);
  // Only reads, or only searches, keep the words they had.
  expect(
    mergeSteps([read("a.ts"), read("b.ts"), read("c.ts")]).map(line),
  ).toEqual(["Read 3 files"]);
});

test("a file step ends in its diffstat, and merged steps add theirs up only when each has one", () => {
  const edit = (file: string, added?: number, removed?: number) =>
    step({
      kind: "edit",
      targets: paths(file),
      ...(added !== undefined && {
        added_lines: added,
        removed_lines: removed,
      }),
    });
  const one = stepWords(edit("src/a.ts", 48, 6));
  expect(one.suffix).toEqual({
    text: "+48 −6",
    outcome: false,
    diffstat: true,
  });
  expect(one.label).toBe("Edited src/a.ts, 48 lines added, 6 removed");
  expect(
    mergeSteps([edit("a.ts", 3, 1), edit("b.ts", 1, 1)]).map(line),
  ).toEqual(["Edited `a.ts` and `b.ts` · +4 −2"]);
  expect(mergeSteps([edit("a.ts", 3, 1), edit("b.ts")]).map(line)).toEqual([
    "Edited `a.ts` and `b.ts`",
  ]);
  // A step that did not finish has no diffstat: its outcome word is the suffix.
  expect(line({ ...edit("a.ts", 3, 1), state: "failed" })).toBe(
    "Edit `a.ts` · Failed",
  );
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
    // STATIC-8: a search that found nothing keeps its own row and its words.
    "Searched for `x` · No matches",
    "Searched for `y`",
  ]);
  // A merged row opens to its targets, not to one step's output.
  expect(merged[0]?.output).toBeUndefined();
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
  // After Deny, while the turn runs; an ended turn has nothing to redirect.
  expect(composerPlaceholder(working, false, true)).toBe(
    "Tell Codex what to do instead",
  );
  expect(composerPlaceholder(idle, false, true)).toBe("Message Codex");
});

test("only a problem observed now disables Send; why the last turn stopped does not", () => {
  const withProblem = (problem: ProblemInput) =>
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
});

test("a past failure is told as the last turn's, with Check again only where a probe can tell", () => {
  const signIn = noticeOf({
    kind: "not_signed_in",
    past: true,
    command: "codex login",
  });
  expect(signIn.body).toMatch(/^The last turn stopped because/);
  expect(signIn.actions).toEqual(["copy-command", "check"]);
  for (const kind of ["usage_limit", "session_in_use"] as const) {
    const notice = noticeOf({ kind, past: true });
    expect(notice.actions, kind).toEqual([]);
    expect(notice.body, kind).toMatch(/last turn/);
  }
  const sandbox = noticeOf({ kind: "sandbox_unavailable", past: true });
  expect(sandbox.actions).toEqual(["help"]);
  expect(sandbox.body).toMatch(/last turn/);
  // Met now, the same kinds keep Check again and say nothing of a last turn.
  const live = noticeOf({ kind: "session_in_use" });
  expect(live.actions).toEqual(["check"]);
  expect(live.body).not.toMatch(/last turn/);
});

test("a usage limit says when it resets, or says that the provider did not", () => {
  const at = new Date(2026, 10, 12, 15, 0).getTime() / 1000;
  const told = noticeOf({
    kind: "usage_limit",
    message: "You've hit your limit.",
    resets_at: at,
  }).body;
  expect(told).toContain("You've hit your limit.");
  expect(told).toContain("It resets on Nov 12 at 3:00 PM.");
  expect(told).not.toContain("didn't say");

  const untold = noticeOf({
    kind: "usage_limit",
    message: "You've hit your limit.",
  }).body;
  expect(untold).toContain("You've hit your limit.");
  expect(untold).toContain("It didn't say when it resets.");
  expect(noticeOf({ kind: "usage_limit" }).body).toContain(
    "It didn't say when it resets.",
  );
});

test("CH-34: a reset time reads in the computer's own clock, as message times do", () => {
  // A computer set to a 24-hour clock: only the default locale says 15:00.
  const clock = vi
    .spyOn(Date.prototype, "toLocaleTimeString")
    .mockImplementation(function (this: Date, locale) {
      return locale === undefined ? "15:00" : "3:00 PM";
    });
  try {
    const at = new Date(2026, 10, 12, 15, 0).getTime() / 1000;
    const told = noticeOf({ kind: "usage_limit", resets_at: at }).body;
    expect(told).toContain(`resets on ${shortDay(at)} at 15:00.`);
  } finally {
    clock.mockRestore();
  }
});

/** The day as the computer's own locale writes it. */
const shortDay = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

test("a refused resend is said first, and the first attempt stays unconfirmed", () => {
  const notice = noticeOf({
    kind: "uncertain_delivery",
    message: "You asked to send it again and Codex did not accept that: busy.",
  });
  expect(notice.body).toMatch(
    /^You asked to send it again and Codex did not accept that: busy\. /,
  );
  expect(notice.body).not.toContain("It hasn't been sent again");
  expect(notice.body).toContain("may still have received the first attempt");
  // It needs the person: the attention tone (CH-35).
  expect(notice.tone).toBe("attention");
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

test("every time a Chat says reads the same: seconds, minutes and seconds, then hours and minutes", () => {
  expect(duration(12_000)).toBe("12s");
  expect(duration(134_000)).toBe("2m 14s");
  // A live clock past an hour reads like a finished turn's time, not "64m 0s".
  expect(duration(64 * 60_000)).toBe("1h 4m");
  expect(duration(0)).toBe("1s");
});

test("an uncertain delivery is worded without assuming why", () => {
  const notice = noticeOf({ kind: "uncertain_delivery" });
  expect(notice.body).not.toMatch(/connection dropped/);
  expect(notice.actions).toEqual(["resend", "discard"]);
});

test("a missing folder is told without claiming a restore happened", () => {
  const notice = noticeOf({ kind: "folder_missing", path: "/work/app" });
  expect(notice.body).toBe(
    "`/work/app` wasn't found. Nothing was re-run. Put it back and check again, or pick another folder to keep going here.",
  );
  // L9: a folder moved back is seen without picking another one.
  expect(notice.actions).toEqual(["check", "pick-folder"]);
});

test("a missing ticketd component is a reinstall notice, not an update of the harness", () => {
  const notice = noticeOf(
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

const you = (id: string, when: string, steer = false): TranscriptItem => ({
  id,
  at: when,
  kind: "user",
  text: id,
  delivery: "delivered",
  ...(steer && { steer }),
});
const timing = (
  outcome: Extract<TranscriptItem, { kind: "turn" }>["outcome"],
  ended?: string,
): TranscriptItem => ({
  id: "turn:t1",
  at: "2026-11-10T10:00:00Z",
  kind: "turn",
  turn_id: "t1",
  started_at: "2026-11-10T10:00:00Z",
  ...(ended && { ended_at: ended }),
  outcome,
});
const did = (id: string, ...steps: Step[]): TranscriptItem => ({
  id,
  at: "",
  kind: "steps",
  turn_id: "t1",
  steps,
});
const said = (id: string, text = id): TranscriptItem => ({
  id,
  at: "",
  kind: "response",
  text,
  state: "complete",
  turn_id: "t1",
});
const read = (path: string): Step => ({
  kind: "read",
  target: path,
  targets: [{ text: path }],
});
const ran = (command: string, state?: Step["state"]): Step => ({
  kind: "run",
  target: command,
  command,
  ...(state && { state }),
});
const idle = { activity: "idle", problem: null } as const;
const turnsOf = (parts: TranscriptPart[]) =>
  parts.flatMap((part) => (part.kind === "turn" ? [part.turn] : []));
const rowWords = (turn: Turn) =>
  turn.rows.map((row) =>
    row.kind === "step"
      ? stepWords(row.step).label
      : row.kind === "response"
        ? row.item.text
        : row.kind,
  );

test("a finished turn folds its work under one row and keeps the final response outside", () => {
  const parts = turns(
    [
      you("u1", at),
      timing("completed", "2026-11-10T10:02:13Z"),
      did("s1", read("a.ts")),
      did("s2", read("b.ts")),
      said("r1", "Reading done."),
      did("s3", ran("npm test", "failed")),
      said("r2", "Fixed."),
      {
        id: "rec1",
        at: "",
        kind: "records",
        turn_id: "t1",
        changes: [
          { kind: "update", reference: "T-1", excerpt: "Fixed the limiter" },
        ],
      },
    ],
    idle,
  );
  expect(parts.map((part) => part.kind)).toEqual(["item", "turn"]);
  const [turn] = turnsOf(parts);
  expect(turn?.live).toBe(false);
  expect(turn?.label).toBe("Worked for 2m 13s · 1 failed");
  expect(turn?.final?.text).toBe("Fixed.");
  // Steps merge across the items they came in; records are step rows too.
  expect(rowWords(turn!)).toEqual([
    "Read a.ts and b.ts",
    "Reading done.",
    "Run npm test, Failed",
    "record",
  ]);
});

test("a response is final only when no step follows it", () => {
  const [turn] = turnsOf(
    turns(
      [
        you("u1", at),
        timing("completed", "2026-11-10T10:00:30Z"),
        said("r1"),
        did("s1", read("a.ts")),
      ],
      idle,
    ),
  );
  expect(turn?.final).toBeUndefined();
  expect(rowWords(turn!)).toEqual(["r1", "Read a.ts"]);
});

test("a steer starts a new segment that continues the turn", () => {
  const segments = turnsOf(
    turns(
      [
        you("u1", at),
        timing("completed", "2026-11-10T10:02:13Z"),
        did("s1", read("a.ts")),
        you("u2", "2026-11-10T10:01:25Z", true),
        did("s2", read("b.ts")),
        said("r1"),
      ],
      idle,
    ),
  );
  expect(segments.map((turn) => turn.label)).toEqual([
    "Worked for 1m 25s",
    "Continued for 48s",
  ]);
});

test("a stopped turn names how it ended, counts what did not finish, and keeps its marker below", () => {
  const [turn] = turnsOf(
    turns(
      [
        you("u1", at),
        timing("stopped", "2026-11-10T10:00:40Z"),
        did("s1", ran("npm run db:migrate", "running")),
        { id: "t1", at: "", kind: "marker", reason: "stopped", turn_id: "t1" },
      ],
      idle,
    ),
  );
  expect(turn?.label).toBe("Stopped after 40s · 1 not finished");
  expect(turn?.marker?.reason).toBe("stopped");
  // A step still running when its turn ended did not finish.
  expect(rowWords(turn!)).toEqual(["Run npm run db:migrate, Not finished"]);
});

test("an unconfirmed stop stays open, says so, and running rows read Not confirmed", () => {
  const [turn] = turnsOf(
    turns(
      [
        you("u1", at),
        timing("active"),
        did("s1", ran("npm run db:migrate", "running")),
      ],
      {
        activity: "working",
        problem: hostProblem({ kind: "stop_unconfirmed" }, "Codex"),
      },
      Date.parse("2026-11-10T10:00:40Z"),
    ),
  );
  expect(turn?.live).toBe(false);
  expect(turn?.unconfirmed).toBe(true);
  // Its own outcome is not counted again.
  expect(turn?.label).toBe("Stop not confirmed after 40s");
  expect(rowWords(turn!)).toEqual(["Run npm run db:migrate, Not confirmed"]);
});

test("a running turn shows its rows as they come, with nothing folded", () => {
  const [turn] = turnsOf(
    turns(
      [you("u1", at), timing("active"), did("s1", ran("npm test", "running"))],
      { activity: "working", problem: null },
    ),
  );
  expect(turn?.live).toBe(true);
  expect(rowWords(turn!)).toEqual(["Running npm test"]);
});

test("an answered approval folds into the step the host says it answered, never the next one; questions and expiries keep receipt rows", () => {
  const request = {
    at: "",
    kind: "request",
    turn_id: "t1",
    title: "Codex asked",
    options: [] as never[],
    free_text: false,
  } as const;
  const [turn] = turnsOf(
    turns(
      [
        you("u1", at),
        timing("completed", "2026-11-10T10:00:10Z"),
        {
          ...request,
          id: "q1",
          request: "approval",
          subject: "npm test",
          state: "answered",
          outcome: "You allowed this for this session",
          folded: true,
        },
        did("s0", {
          ...ran("npm test"),
          decision: "You allowed this for this session",
        }),
        did("s1", ran("npm run lint")),
        {
          ...request,
          id: "q2",
          request: "question",
          subject: "Fail open?",
          state: "answered",
          answer: "Fail open",
        },
        {
          ...request,
          id: "q3",
          request: "approval",
          subject: "rm -rf dist",
          state: "expired",
        },
      ],
      idle,
    ),
  );
  expect(turn?.rows).toMatchObject([
    { kind: "step", decision: "You allowed this for this session" },
    { kind: "step" },
    { kind: "receipt", kept: true },
    { kind: "receipt", kept: true },
  ]);
  // The step after the decided one is not the one it answered.
  expect(turn?.rows[1]).not.toHaveProperty("decision");
  expect(
    turn?.rows.map((row) => row.kind === "receipt" && receiptLine(row.item)),
  ).toEqual([false, false, "Answered · Fail open", "Expired · rm -rf dist"]);
});

test("older history with no timing reads without a duration", () => {
  const [turn] = turnsOf(
    turns([you("u1", at), did("s1", read("a.ts")), said("r1")], idle),
  );
  expect(turn?.label).toBe("Worked");
  expect(turn?.final?.id).toBe("r1");
});

test("the New marker goes above the first item after the last one seen, never your own message", () => {
  const items = [
    you("u1", at),
    said("r1"),
    you("u2", at),
    timing("active"),
    did("s1", read("a.ts")),
  ];
  expect(firstNew(items, "r1")).toBe("s1");
  expect(firstNew(items, "s1")).toBeUndefined();
  expect(firstNew(items, undefined)).toBeUndefined();
});

test("an unseen Chat opened for the first time marks its last ended turn New", () => {
  const items = [
    you("u1", at),
    timing("completed", "2026-11-10T10:00:30Z"),
    said("r1"),
  ];
  expect(unseenFrom(items)).toBe("r1");
  expect(unseenFrom([you("u1", at), timing("active")])).toBeUndefined();
});

test("a stop that was not confirmed is one notice, and Stop itself is the retry", () => {
  expect(noticeOf({ kind: "stop_unconfirmed" })).toEqual({
    tone: "attention",
    title: "Stop not confirmed",
    body: "Codex may still be running.",
    actions: [],
  });
});

test("LIVE-4: a ticketd call reads as a sentence in the step's tense, records by their titles", () => {
  const calls = [
    {
      verb: "set",
      words: [{ text: "T-MP4", code: true }, { text: "to In progress" }],
    },
    {
      verb: "post",
      words: [{ text: "an update on" }, { text: "T-MP4", code: true }],
    },
  ] as const;
  const ticketd = (state: Step["state"]) =>
    step({
      kind: "run",
      target: "ticketd change T-MP4; ticketd activity add T-MP4",
      command: "T=/x/ticketd; $T change T-MP4; $T activity add T-MP4",
      ticketd: calls.map((call) => ({ ...call, words: [...call.words] })),
      ...(state && { state }),
    });
  expect(stepWords(ticketd("done")).label).toBe(
    "Set T-MP4 to In progress, then posted an update on it",
  );
  expect(stepWords(ticketd("running")).label).toBe(
    "Setting T-MP4 to In progress, then posting an update on it",
  );
  // LIVE2-1: one sentence per call, a repeated verb said once, any other call as its words.
  const compound = step({
    kind: "run",
    target:
      "ticketd show T-MP4; ticketd show T-MP5; ticketd change T-MP4 --status Done; ticketd workspace",
    ticketd: [
      { verb: "read", words: [{ text: "T-MP4", code: true }] },
      { verb: "read", words: [{ text: "T-MP5", code: true }] },
      {
        verb: "set",
        words: [{ text: "T-MP4", code: true }, { text: "to Done" }],
      },
      { verb: "run", words: [{ text: "ticketd workspace", code: true }] },
    ],
  });
  expect(stepWords(compound).label).toBe(
    "Read T-MP4 and T-MP5, then set T-MP4 to Done, then ran ticketd workspace",
  );
  const project = step({
    kind: "run",
    target: "ticketd project show f33fa8f7-0c7f",
    ticketd: [
      {
        verb: "read",
        words: [
          { text: "Project" },
          { text: "f33fa8f7-0c7f", record: "project" },
        ],
      },
    ],
  });
  expect(stepWords(project, () => "Verify Project").label).toBe(
    "Read Project Verify Project",
  );
  // A record the view does not know reads by its short id.
  expect(stepWords(project).label).toBe("Read Project f33fa8f7");
  // Anything else shows the command as the host shortened it.
  expect(
    stepWords(
      step({
        kind: "run",
        target: "ticketd skills install",
        command: "/x/ticketd skills install",
      }),
    ).label,
  ).toBe("Ran ticketd skills install");
});

test("LIVE-8: Worked for leaves out the time spent waiting on you, and says the wait", () => {
  const asked = (id: string, from: string, to: string): TranscriptItem => ({
    id,
    at: from,
    resolved_at: to,
    kind: "request",
    turn_id: "t1",
    request: "approval",
    title: "Codex asked to run",
    options: [],
    free_text: false,
    state: "answered",
    folded: true,
  });
  const [turn] = turnsOf(
    turns(
      [
        you("u1", at),
        timing("completed", "2026-11-10T10:03:30Z"),
        did("s1", read("a.ts")),
        asked("q1", "2026-11-10T10:00:20Z", "2026-11-10T10:02:20Z"),
        // Asked at the same time: counted once.
        asked("q2", "2026-11-10T10:01:00Z", "2026-11-10T10:02:50Z"),
        said("r1"),
      ],
      idle,
    ),
  );
  expect(turn?.label).toBe("Worked for 1m · waited 2m 30s");
  // LIVE2-8: the live "Working for" leaves the same wait out while the turn runs.
  const items = [
    asked("q1", "2026-11-10T10:00:20Z", "2026-11-10T10:02:20Z"),
    asked("q2", "2026-11-10T10:01:00Z", "2026-11-10T10:02:50Z"),
  ];
  expect(
    workedFor(
      items,
      "2026-11-10T10:00:00Z",
      Date.parse("2026-11-10T10:03:30Z"),
    ),
  ).toBe(60_000);
  // A request still pending is time waiting, up to now.
  const pending = { ...items[0]!, state: "pending", resolved_at: undefined };
  expect(
    workedFor(
      [pending as TranscriptItem],
      "2026-11-10T10:00:00Z",
      Date.parse("2026-11-10T10:01:20Z"),
    ),
  ).toBe(20_000);
});

test("LIVE-9: the harness's warnings fold as one line per turn; a step waiting on approval has no row", () => {
  const warning = (id: string): TranscriptItem => ({
    id,
    at: "",
    kind: "marker",
    reason: "warning",
    message: `Codex could not start the MCP server ${id}`,
  });
  const [turn] = turnsOf(
    turns(
      [
        you("u1", at),
        timing("completed", "2026-11-10T10:00:30Z"),
        warning("w1"),
        did("s1", read("a.ts")),
        warning("w2"),
        did("s2", { ...ran("npm test", "running"), awaiting: true }),
        said("r1"),
      ],
      idle,
    ),
  );
  expect(turn?.rows.map((row) => row.kind)).toEqual(["warnings", "step"]);
  expect(turn?.rows[0]).toMatchObject({ items: [{ id: "w1" }, { id: "w2" }] });
  expect(turn?.rows[0]?.kept).toBeFalsy();
});

test("streaming into the latest turn leaves every earlier turn the same object", () => {
  const inTurn = (turnId: string, item: TranscriptItem): TranscriptItem => ({
    ...item,
    turn_id: turnId,
  });
  const items: TranscriptItem[] = [
    you("u1", at),
    inTurn("t1", did("s1", read("a.ts"))),
    inTurn("t1", said("r1", "Done.")),
    you("u2", at),
    inTurn("t2", did("s2", read("b.ts"))),
    {
      id: "r2",
      at: "",
      kind: "response",
      text: "Wor",
      state: "streaming",
      turn_id: "t2",
    },
  ];
  const working = { activity: "working", problem: null } as const;
  const before = turnsOf(turns(items, working));
  const streamed = applyChange(
    { chat: chatState({ id: "c1", title: "Limiter" }), items, cursor: 1 },
    { seq: 2, kind: "text", item_id: "r2", text: "king" },
  );
  if (streamed === "resync") throw new Error("expected the change to apply");
  const after = turnsOf(turns(streamed.items, working));
  expect(after).toHaveLength(2);
  expect(after[0]).toBe(before[0]);
  expect(after[1]).not.toBe(before[1]);
  expect(after[1]?.rows.at(-1)).toMatchObject({ item: { text: "Working" } });
});
