import type {
  ChatState,
  SubAgent,
  TranscriptItem,
} from "@/features/chats/client";
import { type MockChat } from "@/features/chats/mock-client";
import {
  codexChat,
  DEMO,
  subAgentFixtures,
} from "@/features/chats/sub-agent-fixtures";

/**
 * The Chat parts around sub-agents (strip, Stop, approvals, started-by lines,
 * the restart notice) in every state the boards show, built as the host will
 * send them (see the contract, T-UB270). Each starts from a fixture of
 * `sub-agent-fixtures.ts` and changes only what the part reads.
 */

const MIN = 60_000;
const SEC = 1000;
const ago = (now: number, ms: number) => new Date(now - ms).toISOString();

type Item = TranscriptItem;

/** The same Chat with other state and extra items; sub-agent records can be amended by id. */
function vary(
  base: MockChat,
  change: {
    chat?: Partial<ChatState>;
    items?: Item[];
    /** Items placed right after the first one (the main agent's own work, before its sub-agent rows). */
    early?: Item[];
    agents?: Record<string, Partial<SubAgent>>;
    /** Rewrites an existing item (a turn that started without the person's message). */
    map?: (item: Item) => Item;
  },
): MockChat {
  const agents = change.agents ?? {};
  return {
    ...base,
    chat: {
      ...base.chat,
      ...change.chat,
      sub_agents: base.chat.sub_agents.map((agent) => ({
        ...agent,
        ...agents[agent.id],
      })),
    },
    items: [
      ...(base.items ?? [])
        .map(change.map ?? ((item) => item))
        .flatMap((item, index) =>
          index === 1 && change.early ? [...change.early, item] : [item],
        ),
      ...(change.items ?? []),
    ],
  };
}

/** The Codex main agent's own work in its first turn, so the turn folds under a work line. */
const codexWork = (now: number): Item => ({
  id: "p-s1",
  at: ago(now, 4 * MIN),
  turn_id: "t1",
  kind: "steps",
  steps: [
    {
      kind: "read",
      target: "src/pay/client.ts",
      targets: [{ text: "src/pay/client.ts" }, { text: "src/pay/refunds.ts" }],
    },
  ],
});

/** A running plan: the plan pill shares the strip's line. */
const plan = (now: number): Item => ({
  id: "h-plan",
  at: ago(now, 3 * MIN),
  turn_id: "t1",
  kind: "plan",
  state: "running",
  steps: [
    { text: "Read the limiter", status: "completed" },
    { text: "Start the reviewers", status: "completed" },
    {
      text: "Collect their findings",
      status: "in_progress",
      active_label: "Waiting for the reviewers",
    },
    { text: "Write the summary", status: "pending" },
  ],
});

export function subAgentPartFixtures(now = Date.now()) {
  const fx = subAgentFixtures(now);
  const quiet = { activity: "working", turn_running: false } as const;
  const agentOf = (key: keyof typeof DEMO) => DEMO[key].id;
  return {
    /** The reply is in, two sub-agents run, no turn: the strip is the live signal. */
    reply: vary(fx.replied, { chat: quiet }),
    /** One sub-agent runs: the pill names it. */
    one: vary(fx.replied, {
      chat: quiet,
      agents: {
        [agentOf("tests")]: {
          status: "completed",
          ended_at: ago(now, 10 * SEC),
        },
      },
      map: (item) =>
        item.kind === "sub_agent" && item.sub_agent === agentOf("tests")
          ? { ...item, status: "completed", ended_at: ago(now, 10 * SEC) }
          : item,
    }),
    /** A running turn with a plan and two sub-agents. */
    plan: vary(fx.running, { items: [plan(now)] }),
    /** Two sub-agents run while the main agent's turn goes on. */
    inTurn: fx.running,
    /** A sub-agent asks to run a command after the reply. */
    approval: vary(fx.replied, {
      chat: { activity: "waiting", turn_running: false, unseen: true },
      items: [
        {
          id: "req-tests",
          at: ago(now, 5 * SEC),
          turn_id: "sa-tests:run-1",
          kind: "request",
          owner: agentOf("tests"),
          request: "approval",
          title: "wants to run",
          subject: "npm test -- rate-limit",
          options: [
            { id: "allow", label: "Allow once" },
            { id: "allow_session", label: "Allow for this session" },
            { id: "deny", label: "Deny" },
          ],
          free_text: false,
          state: "pending",
        },
      ],
    }),
    /** Everything finished, and the main agent was started by Claude Code. */
    done: (() => {
      const base = fx.finished;
      return vary(base, {
        chat: { unseen: true },
        items: [
          {
            id: "turn:t2",
            at: ago(now, 30 * SEC),
            kind: "turn",
            turn_id: "t2",
            started_at: ago(now, 30 * SEC),
            ended_at: ago(now, 5 * SEC),
            outcome: "completed",
            origin: { by: "harness", sub_agent: agentOf("tests") },
          },
          {
            id: "h-s2",
            at: ago(now, 28 * SEC),
            turn_id: "t2",
            kind: "steps",
            steps: [
              {
                kind: "run",
                target: "ticketd show T-KQ29",
                command: "ticketd show T-KQ29",
                exit_code: 0,
                ticketd: [
                  { verb: "read", words: [{ text: "T-KQ29", code: true }] },
                ],
              },
            ],
          },
          {
            id: "h-r2",
            at: ago(now, 6 * SEC),
            kind: "response",
            turn_id: "t2",
            text: "All three reviews are in.\n\n- **Bypass:** a request with no `x-api-key` header skipped the limiter. It now counts against the caller's IP (`src/api/rate-limit.ts`).\n- **Tests:** 14 cases passed; the tests reviewer added one for a missing key.\n- **Docs:** two typos fixed in `docs/api.md`.\n\nI moved T-KQ29 to In review.",
            state: "complete",
          },
          {
            id: "h-f2",
            at: ago(now, 6 * SEC),
            turn_id: "t2",
            kind: "files",
            state: "ended",
            files: [
              {
                path: "src/api/rate-limit.ts",
                open_path: "/fixture/work/src/api/rate-limit.ts",
                kind: "modified",
                added_lines: 6,
                removed_lines: 1,
                confirmed: true,
              },
            ],
          },
          {
            id: "h-rec2",
            at: ago(now, 6 * SEC),
            turn_id: "t2",
            kind: "records",
            changes: [
              {
                kind: "status",
                reference: "T-KQ29",
                title: "Rate limit the public API",
                from: "In progress",
                to: "In review",
              },
            ],
          },
        ],
      });
    })(),
    /** Codex: ticketd woke the main agent after a sub-agent finished. */
    wake: (() => {
      const base = codexChat(now);
      return vary(base, {
        chat: quiet,
        early: [codexWork(now)],
        agents: {
          "sa-refunds": { status: "completed", ended_at: ago(now, 20 * SEC) },
          "sa-pay-tests": {
            status: "completed",
            ended_at: ago(now, 20 * SEC),
          },
        },
        map: (item) =>
          item.kind === "sub_agent" &&
          (item.sub_agent === "sa-refunds" || item.sub_agent === "sa-pay-tests")
            ? { ...item, status: "completed", ended_at: ago(now, 20 * SEC) }
            : item,
        items: [
          {
            id: "turn:t2",
            at: ago(now, 15 * SEC),
            kind: "turn",
            turn_id: "t2",
            started_at: ago(now, 15 * SEC),
            outcome: "active",
            origin: { by: "ticketd", sub_agent: "sa-refunds" },
          },
        ],
      });
    })(),
    /** Codex: three sub-agents, one nested, no turn. */
    codexNested: vary(codexChat(now), {
      chat: quiet,
      early: [codexWork(now)],
    }),
    /** After Stop all with no turn running: every row says Stopped, and the Chat rests. */
    stoppedAll: vary(fx.stopped, {
      chat: { activity: "idle", unseen: false },
      items: [
        {
          id: "stop-all",
          at: ago(now, 40 * SEC),
          kind: "marker",
          reason: "sub_agents_stopped",
          count: 2,
        },
      ],
    }),
    /** ticketd quit while two sub-agents ran: the tray says so. */
    restart: vary(fx.lost, {
      chat: {
        restart_notice: {
          sub_agents: [agentOf("bypass"), agentOf("tests")],
          resume: true,
        },
      },
    }),
    /** The next message carried the note, and the sub-agents were resumed. */
    restartSent: vary(fx.resumed, {
      chat: { restart_notice: null },
      map: (item) =>
        item.kind === "user" && item.id === "h-u2"
          ? {
              ...item,
              note: {
                kind: "lost_sub_agents",
                sub_agents: [agentOf("bypass"), agentOf("tests")],
                text: "From ticketd: these sub-agents were running when ticketd quit and are not running now: Find limiter bypasses, Check limiter test coverage. You can resume them.",
              },
            }
          : item,
    }),
  };
}
