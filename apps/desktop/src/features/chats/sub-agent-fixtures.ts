import {
  type ChatState,
  type SubAgent,
  type SubAgentStatus,
  type TranscriptItem,
} from "@/features/chats/client";
import { chatState, type MockChat } from "@/features/chats/mock-client";

/**
 * Chats with sub-agents in every state the interface shows, built as the host
 * will send them (see the sub-agents view-model contract). They seed the mock
 * client in tests and in the design harness, with the design's demo texts.
 */

const HARNESSES = {
  "claude-code": { id: "claude-code", name: "Claude Code" },
  codex: { id: "codex", name: "Codex" },
  antigravity: { id: "antigravity", name: "Antigravity" },
} as const;
export type FixtureHarness = keyof typeof HARNESSES;

/** What each harness lets the view show of its sub-agents. */
const CAPABILITIES: Record<FixtureHarness, SubAgent["capabilities"]> = {
  "claude-code": {
    brief: true,
    text: true,
    end: true,
    stop: true,
    resume: true,
  },
  codex: { brief: false, text: true, end: true, stop: true, resume: false },
  antigravity: {
    brief: true,
    text: false,
    end: false,
    stop: false,
    resume: false,
  },
};

/** A moment `ms` before `now`, as the host writes times. */
const ago = (now: number, ms: number) => new Date(now - ms).toISOString();
const MIN = 60_000;
const SEC = 1000;

export type Run = {
  /** `completed`, `failed`, `stopped`, `lost` or `running` (the run goes on). */
  status: SubAgentStatus;
  /** When the run started, in ms before now. */
  startedAgo: number;
  /** When it ended, in ms before now; absent while it runs. */
  endedAgo?: number;
  stoppedBy?: "person" | "main_agent";
  /** The run's own items, without owner or turn: the builder sets both. */
  work?: ((turn: string) => TranscriptItem)[];
};

type Item = TranscriptItem;

/** One sub-agent of a fixture Chat. */
export type AgentSpec = {
  record: Omit<SubAgent, "status" | "started_at" | "runs" | "capabilities"> & {
    capabilities?: Partial<SubAgent["capabilities"]>;
  };
  /** One entry per run, oldest first. */
  runs: Run[];
  /** The turn the main agent (or the parent) started it in. */
  inTurn: string | null;
  /** The runs after the first start in these turns, when they did not start in `inTurn`. */
  resumedIn?: (string | null)[];
};

export const DEMO = {
  bypass: {
    id: "sa-bypass",
    native_id: "toolu_01bypass",
    title: "Find limiter bypasses",
    type: "Explore",
    model: "Claude Haiku 5.5",
    brief: {
      source: "main_agent" as const,
      text: "Find every way a request could get past the rate limiter in src/api: a missing or spoofed API key, header case, retries, and routes mounted before the limiter. Report each one with its file and line.",
    },
  },
  tests: {
    id: "sa-tests",
    native_id: "toolu_02tests",
    title: "Check limiter test coverage",
    type: "general-purpose",
    model: "Claude Sonnet 5.5",
    brief: {
      source: "main_agent" as const,
      text: "Check that the tests in src/api/rate-limit.test.ts cover the limiter's edge cases: a missing key, header case, refills and separate keys. Add the cases that are missing, run them, and post the result on T-KQ29.",
    },
  },
  docs: {
    id: "sa-docs",
    native_id: "toolu_03docs",
    title: "Proofread the API docs",
    type: "general-purpose",
    model: "Claude Haiku 5.5",
    brief: {
      source: "main_agent" as const,
      text: "Proofread the rate limit section of docs/api.md against src/api/rate-limit.ts. Fix typos and anything that no longer matches the code.",
    },
  },
};

const steps = (
  id: string,
  list: Extract<Item, { kind: "steps" }>["steps"],
  at: string,
) => (turn: string) =>
  ({ id, at, turn_id: turn, kind: "steps", steps: list }) as Item;
const text = (id: string, body: string, at: string) => (turn: string) =>
  ({
    id,
    at,
    turn_id: turn,
    kind: "response",
    text: body,
    state: "complete",
  }) as Item;

/** What the bypass sub-agent did: a search, some reads, a note, then more. */
export const bypassWork = (now: number, running: boolean) => [
  steps(
    "sa-bypass-s1",
    [
      {
        kind: "search",
        target: "x-api-key",
        targets: [{ text: "x-api-key", scope: "src" }],
      },
      {
        kind: "read",
        target: "src/api/rate-limit.ts",
        targets: [
          { text: "src/api/rate-limit.ts" },
          { text: "src/api/server.ts" },
          { text: "src/api/routes.ts" },
        ],
      },
    ],
    ago(now, 2 * MIN),
  ),
  text(
    "sa-bypass-t1",
    "The key lookup returns early when the header is missing, so `rateLimit()` never counts that request. Checking whether any route is mounted before the limiter.",
    ago(now, 70 * SEC),
  ),
  steps(
    "sa-bypass-s2",
    running
      ? [
          {
            kind: "search",
            target: "app.use(",
            targets: [{ text: "app.use(", scope: "src/api" }],
          },
          {
            kind: "read",
            target: "src/api/health.ts",
            targets: [{ text: "src/api/health.ts" }],
            state: "running",
            started_at: ago(now, 9 * SEC),
          },
        ]
      : [
          {
            kind: "search",
            target: "app.use(",
            targets: [{ text: "app.use(", scope: "src/api" }],
          },
          {
            kind: "read",
            target: "src/api/health.ts",
            targets: [{ text: "src/api/health.ts" }],
          },
        ],
    ago(now, 30 * SEC),
  ),
];
export const BYPASS_RESULT =
  "Found one way around the limiter:\n\n- **No API key:** a request without an `x-api-key` header skips `rateLimit()`, because the key lookup returns early (`src/api/rate-limit.ts:31`).\n\nHeader case is handled, retries are counted, and the health routes are mounted before the limiter on purpose.";

const testsWork = (now: number) => [
  steps(
    "sa-tests-s1",
    [
      {
        kind: "read",
        target: "src/api/rate-limit.test.ts",
        targets: [
          { text: "src/api/rate-limit.test.ts" },
          { text: "src/api/rate-limit.ts" },
        ],
      },
    ],
    ago(now, 3 * MIN),
  ),
  text(
    "sa-tests-t1",
    "Missing keys, header case and refills are covered. A request with no key isn't tested; adding one.",
    ago(now, 2 * MIN),
  ),
  steps(
    "sa-tests-s2",
    [
      {
        kind: "edit",
        target: "src/api/rate-limit.test.ts",
        targets: [{ text: "src/api/rate-limit.test.ts" }],
        added_lines: 12,
        removed_lines: 0,
      },
    ],
    ago(now, 2 * MIN),
  ),
];

/** The items of one run: its turn (timing), then its work, all owned by the sub-agent. */
function runItems(agent: string, number: number, run: Run, now: number) {
  const turn = `${agent}:run-${number}`;
  const started = ago(now, run.startedAgo);
  const ended = run.endedAgo === undefined ? undefined : ago(now, run.endedAgo);
  const outcome =
    run.status === "running"
      ? "active"
      : run.status === "completed"
        ? "completed"
        : run.status;
  return [
    {
      id: `turn:${turn}`,
      at: started,
      kind: "turn",
      owner: agent,
      turn_id: turn,
      started_at: started,
      ...(ended && { ended_at: ended }),
      outcome,
    } as Item,
    ...(run.work ?? []).map((make) => ({ ...make(turn), owner: agent }) as Item),
  ];
}

/**
 * A Chat with its sub-agents: the main agent's turn(s) carry one row per run,
 * and each sub-agent's own items are owned by it. `main` is the main agent's
 * own items (messages, turns, replies) and goes in first.
 */
export function chatWith(options: {
  id: string;
  title: string;
  harness: FixtureHarness;
  now?: number;
  agents: AgentSpec[];
  /** The main agent's items; `{rows}` is where the sub-agents' rows go. */
  main: (rows: Record<string, Item[]>) => Item[];
  chat?: Partial<Pick<ChatState, "activity" | "unseen" | "links">>;
  updated?: number;
}): MockChat {
  const now = options.now ?? Date.now();
  const capabilitiesOf = CAPABILITIES[options.harness];
  const records: SubAgent[] = [];
  const own: Item[] = [];
  const rows: Record<string, Item[]> = {};
  for (const spec of options.agents) {
    const last = spec.runs.at(-1);
    if (!last) continue;
    records.push({
      ...spec.record,
      status: last.status,
      stopped_by: last.stoppedBy ?? null,
      started_at: ago(now, last.startedAgo),
      ended_at: last.endedAgo === undefined ? null : ago(now, last.endedAgo),
      runs: spec.runs.length,
      capabilities: { ...capabilitiesOf, ...spec.record.capabilities },
    });
    spec.runs.forEach((run, index) => {
      own.push(...runItems(spec.record.id, index + 1, run, now));
      const turn = index === 0 ? spec.inTurn : (spec.resumedIn?.[index - 1] ?? null);
      const row = {
        id: `${spec.record.id}:row-${index + 1}`,
        at: ago(now, run.startedAgo),
        kind: "sub_agent",
        ...(turn && { turn_id: turn }),
        ...(spec.record.parent && { owner: spec.record.parent }),
        sub_agent: spec.record.id,
        run: index + 1,
        status: run.status,
        ...(run.stoppedBy && { stopped_by: run.stoppedBy }),
        started_at: ago(now, run.startedAgo),
        ...(run.endedAgo !== undefined && { ended_at: ago(now, run.endedAgo) }),
      } as Item;
      (rows[turn ?? ""] ??= []).push(row);
    });
  }
  const items = [...options.main(rows), ...own];
  return {
    chat: chatState({
      id: options.id,
      title: options.title,
      harness: HARNESSES[options.harness],
      activity: "idle",
      ...options.chat,
      sub_agents: records,
    }),
    items,
    updated_at: ago(now, options.updated ?? 10 * SEC),
  };
}

const you = (id: string, body: string, turn: string, at: string): Item => ({
  id,
  at,
  turn_id: turn,
  kind: "user",
  text: body,
  delivery: "delivered",
});
const reply = (id: string, body: string, turn: string, at: string): Item => ({
  id,
  at,
  turn_id: turn,
  kind: "response",
  text: body,
  state: "complete",
});
const mainTurn = (
  id: string,
  started: string,
  ended: string | null,
  outcome: "active" | "completed" = "completed",
): Item => ({
  id: `turn:${id}`,
  at: started,
  kind: "turn",
  turn_id: id,
  started_at: started,
  ...(ended && { ended_at: ended }),
  outcome,
});

const ASK =
  "Before I merge, review the rate limiter on this branch. In parallel: look for ways around it, check that the tests cover the edge cases, and proofread the API docs.";

/** The hero Chat: the main agent started three sub-agents, each in the state given. */
export function heroChat(
  states: {
    bypass: Run[];
    tests: Run[];
    docs: Run[];
  },
  options: { now?: number; replied?: boolean; resumedIn?: string } = {},
): MockChat {
  const now = options.now ?? Date.now();
  const agent = (
    key: "bypass" | "tests" | "docs",
    work: ((turn: string) => TranscriptItem)[],
  ): AgentSpec => ({
    record: DEMO[key],
    inTurn: "t1",
    ...(options.resumedIn && { resumedIn: [options.resumedIn] }),
    runs: states[key].map((run, index) =>
      index === 0 ? { ...run, work: run.work ?? work } : run,
    ),
  });
  return chatWith({
    id: "c-limiter",
    title: "Review the rate limiter",
    harness: "claude-code",
    now,
    agents: [
      agent("bypass", bypassWork(now, states.bypass[0]?.status === "running")),
      agent("tests", testsWork(now)),
      agent("docs", [
        steps(
          "sa-docs-s1",
          [
            {
              kind: "read",
              target: "docs/api.md",
              targets: [{ text: "docs/api.md" }],
            },
          ],
          ago(now, 9 * MIN),
        ),
      ]),
    ],
    chat: {
      activity:
        options.replied === false || options.resumedIn ? "working" : "idle",
    },
    main: (rows) => [
      you("h-u1", ASK, "t1", ago(now, 4 * MIN)),
      mainTurn(
        "t1",
        ago(now, 4 * MIN),
        options.replied === false ? null : ago(now, 150 * SEC),
        options.replied === false ? "active" : "completed",
      ),
      ...(rows["t1"] ?? []),
      ...(options.replied === false
        ? []
        : [
            reply(
              "h-r1",
              "I started three reviewers. They run in the background, and I'll put their findings together when they finish.",
              "t1",
              ago(now, 150 * SEC),
            ),
          ]),
      ...(options.resumedIn
        ? [
            you("h-u2", "Pick the two reviews back up.", options.resumedIn, ago(now, 40 * SEC)),
            mainTurn(options.resumedIn, ago(now, 40 * SEC), null, "active"),
            ...(rows[options.resumedIn] ?? []),
          ]
        : []),
    ],
  });
}

const done = (startedAgo: number, endedAgo: number): Run => ({
  status: "completed",
  startedAgo,
  endedAgo,
});
const running = (startedAgo: number): Run => ({
  status: "running",
  startedAgo,
});

/** Every state a row and a view show, as named Chats the mock client can open. */
export function subAgentFixtures(now = Date.now()) {
  const docs = done(9 * MIN, 9 * MIN - 64 * SEC);
  const withReply = (run: Run, result: string, id: string): Run => ({
    ...run,
    work: [...(run.work ?? []), text(id, result, ago(now, run.endedAgo ?? 0))],
  });
  return {
    /** Two running, one finished: the Main board. */
    running: heroChat(
      {
        bypass: [running(130 * SEC)],
        tests: [running(130 * SEC)],
        docs: [docs],
      },
      { now, replied: false },
    ),
    /** The three finished, with results. */
    finished: heroChat(
      {
        bypass: [
          withReply(
            done(4 * MIN, 4 * MIN - 160 * SEC),
            BYPASS_RESULT,
            "sa-bypass-r",
          ),
        ],
        tests: [done(4 * MIN, 0)],
        docs: [docs],
      },
      { now },
    ),
    /** One stopped by the person, one by the main agent. */
    stopped: heroChat(
      {
        bypass: [
          {
            status: "stopped",
            stoppedBy: "person",
            startedAgo: 3 * MIN,
            endedAgo: 60 * SEC,
          },
        ],
        tests: [
          {
            status: "stopped",
            stoppedBy: "main_agent",
            startedAgo: 3 * MIN,
            endedAgo: 50 * SEC,
          },
        ],
        docs: [docs],
      },
      { now },
    ),
    /** ticketd quit while they ran. */
    lost: heroChat(
      {
        bypass: [
          { status: "lost", startedAgo: 16 * MIN, endedAgo: 15 * MIN },
        ],
        tests: [{ status: "lost", startedAgo: 16 * MIN, endedAgo: 15 * MIN }],
        docs: [docs],
      },
      { now },
    ),
    /** One sub-agent, two runs: lost, then resumed by the main agent. */
    resumed: heroChat(
      {
        bypass: [
          { status: "lost", startedAgo: 16 * MIN, endedAgo: 15 * MIN },
          running(35 * SEC),
        ],
        tests: [
          { status: "lost", startedAgo: 20 * MIN, endedAgo: 17 * MIN },
          {
            ...running(40 * SEC),
            work: [
              steps(
                "sa-tests-s4",
                [
                  {
                    kind: "run",
                    target: "npm test -- rate-limit",
                    command: "npm test -- rate-limit",
                    state: "running",
                    started_at: ago(now, 8 * SEC),
                  },
                ],
                ago(now, 30 * SEC),
              ),
            ],
          },
        ],
        docs: [docs],
      },
      { now, resumedIn: "t2" },
    ),
  };
}

/** A sub-agent that failed, in the webhook Chat. */
export function failedChat(now = Date.now()): MockChat {
  return chatWith({
    id: "c-webhook",
    title: "Harden the webhook handler",
    harness: "claude-code",
    now,
    agents: [
      {
        inTurn: "t1",
        record: {
          id: "sa-retry",
          title: "Review the retry backoff",
          type: "general-purpose",
          model: "Claude Sonnet 5.5",
          brief: {
            source: "main_agent",
            text: "Review the retry backoff in src/webhooks/retry.ts: delays, the cap, jitter, and what happens after the last attempt. Run the retry tests.",
          },
        },
        runs: [
          {
            status: "failed",
            startedAgo: 29 * MIN,
            endedAgo: 28 * MIN,
            work: [
              steps(
                "sa-retry-s1",
                [
                  {
                    kind: "read",
                    target: "src/webhooks/retry.ts",
                    targets: [
                      { text: "src/webhooks/retry.ts" },
                      { text: "src/webhooks/queue.ts" },
                    ],
                  },
                  {
                    kind: "run",
                    target: "npm test -- retry",
                    command: "npm test -- retry",
                    state: "failed",
                    exit_code: 1,
                    output:
                      "  ✕ backs off after a 503\n\nTests  1 failed | 6 passed",
                  },
                ],
                ago(now, 29 * MIN),
              ),
              () => ({
                id: "sa-retry-m",
                at: ago(now, 28 * MIN),
                turn_id: "sa-retry:run-1",
                kind: "marker",
                reason: "failed",
                message:
                  "Claude Code ended it with an error: the model's response hit its output limit.",
              }),
            ],
          },
        ],
      },
    ],
    main: (rows) => [
      you("w-u1", "Review the retry backoff in the webhook handler.", "t1", ago(now, 30 * MIN)),
      mainTurn("t1", ago(now, 30 * MIN), ago(now, 24 * MIN)),
      ...(rows["t1"] ?? []),
      reply("w-r1", "The retry review failed; the rest looks fine.", "t1", ago(now, 24 * MIN)),
    ],
  });
}

/** Codex: a nested sub-agent whose prompt Codex does not report. */
export function codexChat(now = Date.now()): MockChat {
  return chatWith({
    id: "c-payment",
    title: "Upgrade the payment client",
    harness: "codex",
    now,
    chat: { activity: "working" },
    agents: [
      {
        inTurn: "t1",
        record: {
          id: "sa-refunds",
          title: "Update the refund calls",
          model: "GPT-6.2",
          brief: { source: "main_agent" },
        },
        runs: [running(3 * MIN + 2 * SEC)],
      },
      {
        inTurn: "t1",
        record: {
          id: "sa-pay-tests",
          parent: "sa-refunds",
          title: "Run the payment tests",
          model: "GPT-6.2",
          brief: { source: "sub_agent" },
        },
        runs: [
          {
            ...running(62 * SEC),
            work: [
              steps(
                "sa-pay-tests-s1",
                [
                  {
                    kind: "run",
                    target: "npm test -- src/pay",
                    command: "npm test -- src/pay",
                    exit_code: 0,
                    duration_ms: 12000,
                    output: "Tests  22 passed",
                  },
                  {
                    kind: "run",
                    target: "npm run typecheck",
                    command: "npm run typecheck",
                    state: "running",
                    started_at: ago(now, 14 * SEC),
                  },
                ],
                ago(now, MIN),
              ),
            ],
          },
        ],
      },
      {
        inTurn: "t1",
        record: {
          id: "sa-webhooks",
          title: "Update the webhook handler",
          model: "GPT-6.2",
          brief: { source: "main_agent" },
        },
        runs: [running(3 * MIN + 2 * SEC)],
      },
    ],
    main: (rows) => [
      you("p-u1", "Upgrade the payment client to v5. Split the refund calls and the webhook handler between two agents.", "t1", ago(now, 4 * MIN)),
      mainTurn("t1", ago(now, 4 * MIN), ago(now, 3 * MIN)),
      ...(rows["t1"] ?? []),
      reply("p-r1", "Two agents are on it: one for the refund calls, one for the webhook handler.", "t1", ago(now, 3 * MIN)),
    ],
  });
}

/** Antigravity: a sub-agent that ends with the turn, with steps only. */
export function antigravityChat(now = Date.now()): MockChat {
  return chatWith({
    id: "c-auth",
    title: "Review the auth module",
    harness: "antigravity",
    now,
    agents: [
      {
        inTurn: "t1",
        record: {
          id: "sa-routes",
          title: "Scan the session routes",
          model: "Gemini 3 Pro",
          brief: {
            source: "main_agent",
            text: "Scan the session routes in src/auth for session fixation: is the session id regenerated after sign-in and after a privilege change?",
          },
        },
        runs: [
          {
            status: "completed",
            startedAgo: 9 * MIN,
            endedAgo: 7 * MIN,
            work: [
              steps(
                "sa-routes-s1",
                [
                  {
                    kind: "read",
                    target: "src/auth/routes.ts",
                    targets: [
                      { text: "src/auth/routes.ts" },
                      { text: "src/auth/session.ts" },
                      { text: "src/auth/cookies.ts" },
                    ],
                  },
                  {
                    kind: "search",
                    target: "session.regenerate",
                    targets: [{ text: "session.regenerate", scope: "src/auth" }],
                  },
                ],
                ago(now, 8 * MIN),
              ),
            ],
          },
        ],
      },
    ],
    main: (rows) => [
      you("g-u1", "Review the auth module for session fixation. Use a sub-agent for the session routes.", "t1", ago(now, 9 * MIN)),
      mainTurn("t1", ago(now, 9 * MIN), ago(now, 7 * MIN)),
      ...(rows["t1"] ?? []),
      reply("g-r1", "No session fixation: the session id is regenerated after sign-in in both routes.", "t1", ago(now, 7 * MIN)),
    ],
  });
}

/** Many sub-agent titles for a long title row. */
export const LONG_TITLE =
  "Map every caller of verifySignature() in the payments, refunds and webhooks packages";
export { testsWork };
