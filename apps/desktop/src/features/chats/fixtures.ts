import type { LinkedRecord, TranscriptItem } from "@/features/chats/client";
import {
  chatState,
  createMockChatClient,
  type MockChat,
} from "@/features/chats/mock-client";

/**
 * Development only: the design's scenes as in-memory Chats, opened with
 * `npm run dev` at `#chat-fixtures`. Nothing here talks to a harness, so it
 * shows layout and wording, never real delivery or permission behavior.
 */
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();
const at = minutesAgo(5);
const you = (id: string, text: string): TranscriptItem => ({
  id,
  at,
  kind: "user",
  text,
  delivery: "delivered",
});
const reply = (id: string, text: string): TranscriptItem => ({
  id,
  at,
  kind: "response",
  text,
  state: "complete",
});
const t12: LinkedRecord = {
  kind: "ticket",
  id: "t12",
  reference: "T-12",
  title: "Rate-limit failed login attempts",
  status: "In progress",
};
const spec: LinkedRecord = {
  kind: "document",
  id: "d1",
  title: "Login hardening spec",
};
const claude = {
  id: "claude-code",
  name: "Claude Code",
  permissions: "Uses your Claude Code settings. It asks before editing files.",
};

/** A turn that ran, was steered, and finished: it reads result-first. */
const inTurn = (item: TranscriptItem): TranscriptItem => ({
  ...item,
  turn_id: "ft",
});
const testOutput = Array.from(
  { length: 30 },
  (_, line) => `  ✓ limiter case ${line + 1}`,
).join("\n");
const finishedTurn: TranscriptItem[] = [
  inTurn(you("f1", "Sketch a limiter that won't lock out shared office IPs.")),
  {
    id: "turn:ft",
    at: minutesAgo(9),
    kind: "turn",
    turn_id: "ft",
    started_at: minutesAgo(9),
    ended_at: minutesAgo(9 - 133 / 60),
    outcome: "completed",
  },
  inTurn(
    reply(
      "f2",
      "I read the spec and T-12. I'll add a sliding-window limiter keyed by account and IP.",
    ),
  ),
  inTurn({
    id: "f3",
    at,
    kind: "steps",
    steps: ["login.ts", "session.ts", "limiter.ts"].map((file) => ({
      kind: "read",
      target: `src/auth/${file}`,
      targets: [{ text: `src/auth/${file}` }],
    })),
  }),
  inTurn({
    id: "f4",
    at,
    kind: "records",
    changes: [
      {
        kind: "status",
        reference: "T-12",
        title: t12.title,
        from: "Todo",
        to: "In progress",
      },
    ],
  }),
  inTurn({
    id: "f5",
    at,
    kind: "request",
    request: "approval",
    title: "Codex asked for approval",
    subject: "npm run test:all",
    options: [],
    free_text: false,
    state: "answered",
    outcome: "You allowed this for this session",
  }),
  inTurn({
    id: "f6",
    at,
    kind: "steps",
    steps: [
      {
        kind: "run",
        target: "npm run test:all",
        command: "npm run test:all",
        folder: "auth-service",
        state: "failed",
        exit_code: 1,
        output: `${testOutput}\n  ✕ resets the window\n\nTests  1 failed | 30 passed`,
      },
      {
        kind: "edit",
        target: "src/auth/limiter.ts",
        targets: [{ text: "src/auth/limiter.ts" }],
      },
      {
        kind: "run",
        target: "npm run test:all",
        command: "npm run test:all",
        output: "Tests  31 passed",
      },
    ],
  }),
  inTurn(
    reply(
      "f7",
      "The limiter is in. Failed logins are now limited per account and per IP in a sliding 15-minute window, and `npm run test:all` passes.",
    ),
  ),
];

const chats: MockChat[] = [
  {
    updated_at: minutesAgo(1),
    chat: chatState({
      id: "finished",
      title: "Sketch a limiter for shared IPs",
      links: [t12],
    }),
    items: finishedTurn,
  },
  {
    updated_at: minutesAgo(0),
    chat: chatState({
      id: "approval",
      title: "Alert on-call when logins spike",
      activity: "waiting",
      links: [{ ...t12, id: "t13", reference: "T-13", title: "Page on-call" }],
    }),
    items: [
      you("a1", "Page the on-call engineer when failed logins spike."),
      {
        id: "a2",
        at,
        kind: "request",
        request: "approval",
        title: "Codex wants to run a command",
        subject: "npm install @pagerduty/pdjs",
        options: [
          { id: "once", label: "Allow once" },
          { id: "session", label: "Allow for this session" },
          { id: "deny", label: "Deny" },
        ],
        free_text: false,
        state: "pending",
      },
    ],
  },
  {
    updated_at: minutesAgo(2),
    chat: chatState({
      id: "working",
      title: "Rate-limit failed logins",
      harness: claude,
      activity: "working",
      doing: { label: "Running npm test", since: minutesAgo(2) },
      folder: { shared_with: ["Alert on-call when logins spike"] },
      links: [t12, spec],
      queue: [{ id: "q1", text: "Then open a PR against main" }],
    }),
    items: [
      you("w1", "Implement T-12. Follow the login hardening spec."),
      reply(
        "w2",
        "I read the spec and T-12. I'll add a sliding-window limiter keyed by account and IP, then wire it into the login handler.",
      ),
      {
        id: "w3",
        at,
        kind: "records",
        changes: [
          {
            kind: "status",
            reference: "T-12",
            title: t12.title,
            from: "Todo",
            to: "In progress",
          },
        ],
      },
      {
        id: "w4",
        at,
        kind: "steps",
        steps: [
          {
            kind: "read",
            target: "src/auth/login.ts",
            targets: [
              { text: "src/auth/login.ts" },
              { text: "src/auth/session.ts" },
              { text: "src/auth/limiter.ts", lines: [1, 120] },
            ],
          },
          {
            kind: "edit",
            target: "src/auth/limiter.ts",
            targets: [{ text: "src/auth/limiter.ts" }],
          },
          {
            kind: "run",
            target: "npm run test:all",
            command: "npm run test:all",
            state: "failed",
            exit_code: 1,
            output: "FAIL  src/auth/limiter.test.ts\n  ✕ resets the window",
            truncated: { kept_bytes: 1_048_576, total_bytes: 3_565_158 },
          },
          {
            kind: "run",
            target: "npm run test:all",
            command: "npm run test:all",
            state: "running",
            started_at: minutesAgo(0.2),
          },
        ],
      },
    ],
  },
  {
    updated_at: minutesAgo(70),
    chat: chatState({
      id: "question",
      title: "Limiter behavior without Redis",
      harness: claude,
      activity: "waiting",
    }),
    items: [
      {
        id: "qn1",
        at,
        kind: "request",
        request: "question",
        title: "What should the limiter do when Redis is unreachable?",
        options: [
          {
            id: "open",
            label: "Fail open",
            description: "Let logins through and log a warning",
          },
          {
            id: "closed",
            label: "Fail closed",
            description: "Reject logins until Redis is back",
          },
        ],
        free_text: true,
        state: "pending",
      },
    ],
  },
  {
    updated_at: minutesAgo(90),
    chat: chatState({
      id: "stopped",
      title: "Migrate sessions table",
      activity: "interrupted",
      queue: [{ id: "q2", text: "Run the migration on staging" }],
      queue_paused: true,
    }),
    items: [
      you("s1", "Write the migration for the sessions table."),
      { id: "s2", at, kind: "marker", reason: "stopped" },
    ],
  },
  {
    updated_at: minutesAgo(120),
    chat: chatState({
      id: "sign-in",
      title: "Summarize open tickets",
      harness: claude,
      activity: "failed",
      problem: { kind: "not_signed_in", command: "claude" },
    }),
    items: [
      {
        id: "si1",
        at,
        kind: "user",
        text: "Summarize what is still open for the login work.",
        delivery: "not_sent",
      },
    ],
  },
  {
    updated_at: minutesAgo(180),
    chat: chatState({
      id: "limit",
      title: "Refactor the mailer",
      activity: "failed",
      problem: {
        kind: "usage_limit",
        past: true,
        resets_at: Math.floor(Date.now() / 1000) + 3 * 3600,
      },
      queue: [{ id: "q3", text: "Add tests for the retry path" }],
    }),
    items: [you("l1", "Refactor the mailer to use the queue.")],
  },
  {
    updated_at: minutesAgo(200),
    chat: chatState({
      id: "sandbox",
      title: "Run the benchmark",
      activity: "failed",
      problem: {
        kind: "sandbox_unavailable",
        help_url: "https://example.com/sandbox-help",
      },
    }),
    items: [you("sb1", "Run the login benchmark.")],
  },
  {
    updated_at: minutesAgo(240),
    chat: chatState({
      id: "uncertain",
      title: "Tidy the changelog",
      harness: claude,
      activity: "interrupted",
      problem: { kind: "uncertain_delivery", message_id: "u1" },
    }),
    items: [
      {
        id: "u1",
        at,
        kind: "user",
        text: "Also add the limiter to the changelog.",
        delivery: "uncertain",
      },
    ],
  },
  {
    // As seen on a real machine: a managed folder named by an id under the
    // verbatim path form, notices from ticketd, and replies one item per line.
    updated_at: minutesAgo(3),
    chat: chatState({
      id: "managed",
      title:
        "Reply with exactly the single word: pong, then list three numbers",
      activity: "interrupted",
      folder: {
        path: "\\\\?\\C:\\Users\\me\\ticketd\\workspace.sqlite3.chats\\f4f684bc-abfa-4335-a59d-4700c27c520e",
        name: "f4f684bc-abfa-4335-a59d-4700c27c520e",
        managed: true,
      },
    }),
    items: [
      {
        id: "m0",
        at,
        kind: "marker",
        reason: "note",
        message:
          "Codex could not start the MCP server grafana: The grafana MCP server requires OAuth reauthentication.",
      },
      you(
        "m1",
        "Write 1 to 3, one per line, with a short sentence after each.",
      ),
      reply("m2", "1 - One is the first.\n2 - Two is even.\n3 - Three is odd."),
      {
        id: "m3",
        at,
        kind: "request",
        request: "approval",
        title: "Codex asked for approval",
        subject: "Remove-Item hello.txt",
        reason: "Allow removing hello.txt from the current directory?",
        options: [],
        free_text: false,
        state: "answered",
        outcome: "You denied this",
      },
      { id: "m4", at, kind: "marker", reason: "stopped" },
    ],
  },
  {
    updated_at: minutesAgo(60 * 26),
    chat: chatState({
      id: "folder",
      title: "Reset email copy",
      harness: claude,
      activity: "failed",
      folder: {
        path: "~/ticketd/chats/reset-email",
        name: "reset-email",
        managed: true,
        missing: true,
      },
      problem: { kind: "folder_missing", path: "~/ticketd/chats/reset-email" },
    }),
    items: [
      you("f1", "Draft the password reset email."),
      reply("f2", "Here is a first draft of the reset email."),
      {
        id: "f3",
        at,
        kind: "records",
        changes: [
          { kind: "document", document_id: "d9", title: "Reset email copy" },
        ],
      },
    ],
  },
  {
    updated_at: minutesAgo(60 * 50),
    chat: chatState({
      id: "lost",
      title: "Plan the 2FA rollout",
      harness: claude,
      activity: "failed",
      problem: { kind: "history_lost" },
    }),
    items: [
      you("h1", "Plan the 2FA rollout in three phases."),
      reply("h2", "Phase 1 covers staff accounts. Phase 2 opts customers in."),
      {
        id: "h3",
        at,
        kind: "request",
        request: "approval",
        title: "Claude Code wanted to edit a file outside the folder",
        subject: "~/.config/pagerduty/services.json",
        options: [],
        free_text: false,
        state: "expired",
      },
    ],
  },
  {
    updated_at: minutesAgo(30),
    chat: chatState({
      id: "archived",
      title: "Nightly dependency audit",
      retention: "archived",
      activity: "working",
      doing: { label: "Reading package-lock.json", since: minutesAgo(1) },
    }),
    items: [you("ar1", "Audit the dependencies for known advisories.")],
  },
  {
    updated_at: minutesAgo(60 * 80),
    chat: chatState({
      id: "trashed",
      title: "Try a token bucket instead",
      harness: claude,
      retention: "trashed",
      activity: "interrupted",
    }),
    items: [
      you("tr1", "Would a token bucket be simpler than the sliding window?"),
      reply(
        "tr2",
        "A token bucket allows short bursts, which the spec rules out. I'd keep the sliding window.",
      ),
    ],
  },
];

export const fixtureChatClient = () =>
  createMockChatClient({
    enabled: true,
    chats,
    now: new Date().toISOString(),
    records: [
      t12,
      spec,
      {
        kind: "ticket",
        id: "t14",
        reference: "T-14",
        title: "Show the remaining wait time on the login form",
        status: "Todo",
      },
    ],
  });
