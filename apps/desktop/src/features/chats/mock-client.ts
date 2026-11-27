import {
  ChatError,
  chatChangeSchema,
  chatSnapshotSchema,
  chatStateSchema,
  chatSummarySchema,
  harnessOptionsSchema,
  type ChatChange,
  type ChatClient,
  type ChatOverview,
  type ChatState,
  type ChatStatus,
  type ChatSummary,
  type FolderFile,
  type HarnessInfo,
  type HarnessOptions,
  type HarnessStatus,
  type SettingOption,
  type Stopping,
  type LinkRef,
  type QueueEditSave,
  type LinkedRecord,
  type Suggestion,
  type OpenRequest,
  type Problem,
  type ProblemKind,
  type ProjectFolder,
  type ProjectRef,
  type TranscriptItem,
} from "@/features/chats/client";
import { canSteer, changeLine } from "@/features/chats/model";
import {
  ticketAgentsSchema,
  type TicketAgent,
  type TicketAgentInput,
} from "@/features/chats/ticket-agents";
import { plainText } from "@/features/documents/graph-text";
import {
  captureChatAttachment,
  type ChatAttachmentInput,
} from "@/features/chats/composer-attachments";

/** Words for a condition that holds now and is not a failure; as the host says them. */
const CONDITION_WORDS: Partial<Record<string, string>> = {
  not_installed: "Not sent",
  incompatible: "Not sent",
  unavailable: "Not sent",
  probe_failed: "Not sent",
  not_signed_in: "Not sent",
  folder_missing: "Folder missing",
  history_lost: "Session unavailable",
  session_in_use: "Session in use elsewhere",
};

/** As the host's `ChatProblemKind::blocks_send`. */
const BLOCKS_SEND = new Set<ProblemKind>([
  "not_installed",
  "incompatible",
  "unavailable",
  "not_signed_in",
  "usage_limit",
  "sandbox_unavailable",
  "uncertain_delivery",
  "session_in_use",
]);
/** As the host's `ChatProblemKind::removes_composer`. */
const NO_COMPOSER = new Set<ProblemKind>(["folder_missing", "history_lost"]);

/** A problem as a test spells it; the fake host fills in what the real one decides. */
export type ProblemInput = Omit<Problem, "title" | "blocks_send"> &
  Partial<Pick<Problem, "title" | "blocks_send">>;

/** As the host's `ChatProblemKind::title`. */
function problemTitle(kind: ProblemKind, harness: string, past: boolean) {
  switch (kind) {
    case "not_signed_in":
      return past
        ? `${harness} wasn't signed in`
        : `${harness} isn't signed in`;
    case "not_subscription":
      return `${harness} isn't using a subscription`;
    case "sign_in_unknown":
      return `ticketd can't check ${harness}'s sign-in`;
    case "not_installed":
      return `${harness} isn't installed`;
    case "incompatible":
      return `This ${harness} version can't be used`;
    case "unavailable":
      return `${harness} isn't available`;
    case "probe_failed":
      return `ticketd couldn't check ${harness}`;
    case "usage_limit":
      return `${harness} reached your usage limit`;
    case "sandbox_unavailable":
      return `${harness} can't run commands here`;
    case "uncertain_delivery":
      return `Did ${harness} get your message?`;
    case "folder_missing":
      return "This Chat's folder is missing";
    case "history_lost":
      return `${harness} no longer has this conversation`;
    case "session_in_use":
      return past
        ? `This ${harness} session was open somewhere else`
        : `This ${harness} session is open somewhere else`;
    case "stop_unconfirmed":
      return "Stop not confirmed";
    case "failed":
      return `${harness} stopped with an error`;
  }
}

/** A problem as the host sends it, worded for `harness`. */
export function hostProblem(problem: ProblemInput, harness: string): Problem {
  return {
    title: problemTitle(problem.kind, harness, Boolean(problem.past)),
    blocks_send: !problem.past && BLOCKS_SEND.has(problem.kind),
    ...problem,
  };
}

/** A harness status as a test spells it; the fake host fills in the rest. */
export type HarnessInput = Omit<HarnessStatus, "usable" | "word" | "problem"> &
  Partial<Pick<HarnessStatus, "usable" | "word">> & {
    problem?: Partial<ProblemInput> | null;
  };

const HARNESS_WORDS: Record<
  HarnessStatus["status"],
  HarnessStatus["word"] | null
> = {
  ready: null,
  not_signed_in: { word: "Not signed in", dot: true },
  incompatible: { word: "Can't be used", dot: true },
  unavailable: { word: "Can't be used", dot: true },
  unknown: { word: "Couldn't check", dot: true },
  not_subscription: { word: "Not on a subscription", dot: true },
  not_installed: { word: "Not installed", dot: false },
  sign_in_unknown: { word: "Sign-in not checked", dot: false },
};

/** As the host's `HarnessState`: usable, its word, and New Chat's notice. */
export function harnessStatus(input: HarnessInput): HarnessStatus {
  const { problem, ...rest } = input;
  const kind: ProblemKind | null =
    input.status === "ready"
      ? null
      : input.status === "unknown"
        ? "probe_failed"
        : input.status;
  return {
    usable: ["ready", "not_subscription", "sign_in_unknown"].includes(
      input.status,
    ),
    word: HARNESS_WORDS[input.status],
    problem:
      kind &&
      hostProblem(
        {
          kind,
          message: input.message,
          command: input.command,
          help_url: input.help_url,
          path: input.path,
          ...problem,
        },
        input.name,
      ),
    ...rest,
  };
}

/** What the host derives from a Chat's state: whether there is a composer. */
function settled(chat: ChatState): ChatState {
  const problem = chat.problem;
  return {
    ...chat,
    has_composer:
      chat.retention !== "trashed" &&
      !(problem && !problem.past && NO_COMPOSER.has(problem.kind)),
  };
}

/** The first sentence of the latest turn's records row: its first net change. */
function firstChange(items: TranscriptItem[]) {
  const records = items.filter(
    (item): item is Extract<TranscriptItem, { kind: "records" }> =>
      item.kind === "records",
  );
  const latest = records.at(-1);
  const turn = latest?.turn_id
    ? records.filter((item) => item.turn_id === latest.turn_id)
    : latest
      ? [latest]
      : [];
  // The host's net list: fixtures say it on the turn's last records item, and an
  // item without one says its changes as they are.
  const last = turn.at(-1);
  return (last?.net ?? turn.flatMap((item) => item.changes)).at(0);
}

/**
 * The host's ranked status (spec 21.3), simplified for fixtures: the mock has no
 * turns, so a Failed or finished Chat is unseen until it is opened.
 */
function mockStatus(chat: ChatState, items: TranscriptItem[]): ChatStatus {
  const unseen = chat.unseen;
  const make = (
    rank: ChatStatus["rank"],
    word: string,
    detail?: string | null,
  ): ChatStatus => ({
    rank,
    unseen,
    word,
    label: word,
    detail: detail ?? null,
  });
  const pending = items.find(
    (item): item is Extract<TranscriptItem, { kind: "request" }> =>
      item.kind === "request" && item.state === "pending",
  );
  // A sub-agent's approval says which one asks.
  const asker = pending?.owner
    ? chat.sub_agents.find((agent) => agent.id === pending.owner)
    : undefined;
  if (pending?.request === "approval")
    return make("approval", "Approval needed", asker?.title ?? pending.subject);
  if (pending) return make("question", "Question", pending.subject);
  const problem = chat.problem;
  if (problem?.kind === "uncertain_delivery") {
    const message = items.find((item) => item.id === problem.message_id);
    return make(
      "question",
      "Not confirmed",
      message?.kind === "user" ? message.text : null,
    );
  }
  if (problem?.kind === "stop_unconfirmed")
    return make("working", "Stop not confirmed");
  if (chat.activity === "working" || chat.activity === "waiting") {
    const n = chat.sub_agents.filter((one) => one.status === "running").length;
    return make(
      "working",
      "Working",
      chat.opening
        ? "Starting"
        : n > 0
          ? `${n} ${n === 1 ? "sub-agent" : "sub-agents"}`
          : null,
    );
  }
  const marker = items.at(-1)?.kind === "marker" ? items.at(-1) : undefined;
  const reason = marker?.kind === "marker" ? marker.reason : undefined;
  if (reason === "stopped") return make("idle", "You stopped it");
  if (reason === "quit") return make("idle", "Stopped", "ticketd quit");
  if (reason === "sub_agents_stopped") {
    const n = marker?.kind === "marker" ? (marker.count ?? 1) : 1;
    return make(
      "idle",
      `You stopped ${n} ${n === 1 ? "sub-agent" : "sub-agents"}`,
    );
  }
  // A failure observed now waits for the person while it holds.
  if (problem?.kind === "failed" && !problem.past)
    return make(
      "failed",
      "Failed",
      problem.message ?? `${chat.harness.name} stopped with an error`,
    );
  if (chat.activity === "failed")
    return make(
      unseen ? "failed" : "idle",
      "Failed",
      `${chat.harness.name} ${problem?.kind === "usage_limit" ? "reached your usage limit" : "stopped with an error"}`,
    );
  if (chat.activity === "interrupted")
    return make(
      unseen ? "failed" : "idle",
      "Interrupted",
      `${chat.harness.name} stopped mid-turn`,
    );
  const condition = problem && !problem.past && CONDITION_WORDS[problem.kind];
  if (condition) return make("idle", condition);
  // Sub-agents that lost contact when ticketd quit, until the next message tells the agent.
  const lost = chat.restart_notice?.sub_agents.length ?? 0;
  if (lost > 0)
    return make(
      "idle",
      `${lost} ${lost === 1 ? "sub-agent" : "sub-agents"} lost contact`,
    );
  // The list row says what the main agent did, not a sub-agent.
  const main = items.filter((item) => !item.owner);
  const change = firstChange(main);
  const response = main
    .filter(
      (item): item is Extract<TranscriptItem, { kind: "response" }> =>
        item.kind === "response",
    )
    .at(-1);
  const line =
    (change && changeLine(change)) ||
    (response && plainText(response.text)) ||
    null;
  if (unseen && response) return make("done", "Done", line);
  return line ? { ...make("idle", line), label: "Done" } : make("idle", "Idle");
}

/** A Chat state with quiet defaults, so a test or fixture spells out only what matters. */
export function chatState(
  over: Partial<
    Omit<ChatState, "steering" | "folder" | "harness" | "problem">
  > & {
    id: string;
    title: string;
    harness?: Partial<ChatState["harness"]>;
    folder?: Partial<ChatState["folder"]>;
    steering?: Partial<ChatState["steering"]>;
    problem?: ProblemInput | null;
  },
): ChatState {
  const harness = { id: "codex", name: "Codex", ...over.harness };
  return settled(
    chatStateSchema.parse({
      retention: "active",
      activity: "idle",
      links: [],
      queue: [],
      queue_paused: false,
      // A failure in a fixture has not been seen yet.
      unseen: over.activity === "failed",
      muted: false,
      has_composer: true,
      ...over,
      problem: over.problem && hostProblem(over.problem, harness.name),
      harness,
      folder: {
        path: "~/code/web-app",
        name: "web-app",
        managed: false,
        missing: false,
        shared_with: [],
        ...over.folder,
      },
      steering: { available: true, ...over.steering },
    }),
  );
}

export type MockChat = {
  chat: ChatState;
  items?: TranscriptItem[];
  updated_at?: string;
  /** Attachment inputs by seeded queued message ID. */
  queuedFiles?: Record<string, ChatAttachmentInput[]>;
};

type Change =
  | { kind: "item"; item: TranscriptItem }
  | { kind: "text"; item_id: string; text: string }
  | { kind: "chat"; chat: ChatState };

type ChangeListener = (change: ChatChange) => void;

type Stored = {
  chat: ChatState;
  items: TranscriptItem[];
  updated_at: string;
  seq: number;
  log: ChatChange[];
  listeners: Map<ChangeListener, symbol>;
  queuedFiles: Map<string, ChatAttachmentInput[]>;
  pending?: Change[];
};

/** The harness side of the mock: what a test or fixture makes "happen". */
export type MockChatClient = ChatClient & {
  /** Adds a transcript item, or replaces the one with the same id. */
  push(id: string, item: TranscriptItem): void;
  streamText(id: string, itemId: string, text: string): void;
  patch(
    id: string,
    change: Partial<Omit<ChatState, "problem">> & {
      problem?: ProblemInput | null;
    },
  ): void;
  /** Loses the next `count` changes on the way to subscribers. */
  dropChanges(id: string, count: number): void;
  setHarnesses(harnesses: HarnessInput[]): void;
  /** What each harness reports it offers; a harness without an entry reports none. */
  options: Map<string, HarnessOptions>;
  /** What each createChat was asked with, in order. */
  created: Parameters<ChatClient["createChat"]>[0][];
  requestQuit(): void;
  /** Automation runs going, which the Chat list does not show; set to fake them. */
  runsGoing: number;
  /** As if the person clicked the Chat's system notification. */
  requestOpen(request: OpenRequest): void;
  /** Sets the agents at work on a ticket, as the host would after a change; an empty list is none. */
  setTicketAgents(ticketId: string, agents: TicketAgentInput[]): void;
  /** What Notify me about Chats was last set to. */
  notify: boolean;
  /** Whether Quit was confirmed. */
  quit: boolean;
  /** Titles saved through Save as Document, in order. */
  savedDocuments: string[];
  /** Items passed to readThrough, in order. */
  readThroughs: string[];
  /** The Project each folder belongs to, as the host would find it. */
  folderProjects: Map<string, ProjectRef>;
  /** Each Project's folder, by Project id. */
  projectFolders: Map<string, string>;
  /** The registered checkouts offered by the folder menu. */
  projectCheckouts: ProjectFolder[];
  /** Paths opened through a changed-files row or a step's file name, in order. */
  openedFiles: string[];
  /** What the next folder dialog returns. */
  nextFolder: string | null;
};

const option = (
  id: string,
  label: string,
  extra: Partial<SettingOption> = {},
) =>
  ({ id, label, is_default: false, allowed: true, ...extra }) as SettingOption;
const levels = (...ids: string[]) =>
  ids.map((id) =>
    option(
      id,
      id === "xhigh" ? "Extra high" : id[0]!.toUpperCase() + id.slice(1),
    ),
  );

/** What the two harnesses list, as their real model lists are shaped. */
export const HARNESS_OPTIONS: HarnessOptions[] = [
  {
    harness_id: "claude-code",
    models: [
      {
        ...option("default", "Default (recommended)", {
          description: "Opus 5.5 for complex, multi-step work",
          is_default: true,
        }),
        runs_as: "Opus 5.5",
        efforts: levels("low", "medium", "high", "max"),
      },
      {
        ...option("sonnet", "Sonnet 5", {
          description: "Fast and capable for everyday coding",
        }),
        efforts: levels("low", "medium", "high"),
      },
      {
        ...option("haiku", "Haiku 4.5", {
          description: "Fastest, for quick answers",
        }),
        efforts: [],
      },
    ],
    permission: {
      options: [
        option("default", "Ask before edits", {
          description:
            "Reads freely; asks before it edits a file or runs a command.",
          is_default: true,
          permission: "ask",
        }),
        option("acceptEdits", "Accept edits", {
          description:
            "Edits files in this folder without asking; asks before commands.",
          permission: "accept_edits",
        }),
        option("plan", "Plan only", {
          description: "Reads and plans; changes nothing.",
          permission: "read_only",
        }),
        option("bypassPermissions", "Full access", {
          description:
            "Edits and runs commands without asking, anywhere your account can reach.",
          permission: "full_access",
        }),
      ],
      changeable: true,
      applies_from: "next_request",
    },
  },
  {
    harness_id: "codex",
    models: [
      {
        ...option("gpt-5.5-codex", "GPT-5.5 Codex", {
          description: "Optimized for coding agents",
          is_default: true,
        }),
        efforts: levels("low", "medium", "high", "xhigh").map((level) => ({
          ...level,
          is_default: level.id === "medium",
        })),
      },
      {
        ...option("gpt-5.5", "GPT-5.5", {
          description: "Broad world knowledge",
        }),
        efforts: levels("minimal", "low", "medium", "high"),
      },
    ],
    permission: {
      options: [
        option("own", "Codex settings", {
          description:
            "Follows your Codex settings for what it asks and what it can touch.",
          is_default: true,
        }),
        option("full-access", "Full access", {
          description:
            "Edits and runs commands without asking or a sandbox, anywhere your account can reach.",
          permission: "full_access",
        }),
      ],
      changeable: true,
      applies_from: "next_turn",
    },
  },
];

const READY: HarnessInput[] = [
  { id: "claude-code", name: "Claude Code", status: "ready" },
  { id: "codex", name: "Codex", status: "ready" },
];

/**
 * A deterministic in-memory ChatClient. Every value it hands out passes the
 * same schemas the host's data will, so fixtures cannot drift from the contract.
 */
export function createMockChatClient(
  seed: {
    enabled?: boolean;
    chats?: MockChat[];
    harnesses?: HarnessInput[];
    catalog?: HarnessInfo[];
    /** What each harness lists before a session; HARNESS_OPTIONS when left out. */
    options?: HarnessOptions[];
    records?: LinkedRecord[];
    /** What New Chat suggests; linked tickets are left out as the host does. */
    suggestions?: Suggestion[];
    /** Step files that are no longer in their Chat's folder. */
    goneFiles?: string[];
    /** What every Chat's folder holds, for the `@` menu. */
    files?: FolderFile[];
    now?: string;
    /** How many log entries are kept per Chat for a reconnecting subscriber. */
    logLimit?: number;
    /** Whole step outputs by tool id, for steps that carry only their end. */
    outputs?: Record<string, string>;
    /** The agents at work on each ticket, by ticket id. */
    ticketAgents?: Record<string, TicketAgentInput[]>;
  } = {},
): MockChatClient {
  const now = seed.now ?? "2026-11-10T10:00:00Z";
  const logLimit = seed.logLimit ?? 1000;
  let enabled = seed.enabled ?? false;
  let harnesses = (seed.harnesses ?? READY).map(harnessStatus);
  let created = 0;
  const requests = new Map<
    string,
    { id: string; key: string; files: ChatAttachmentInput[] }
  >();
  const dropping = new Map<string, number>();
  const overviewListeners = new Set<(overview: ChatOverview) => void>();
  const openListeners = new Set<(request: OpenRequest) => void>();
  const quitListeners = new Set<(stopping: Stopping) => void>();
  const chats = new Map<string, Stored>();
  const ticketAgents = new Map<string, TicketAgent[]>(
    Object.entries(seed.ticketAgents ?? {}).map(([ticket, agents]) => [
      ticket,
      ticketAgentsSchema.parse(agents),
    ]),
  );
  /** Chats the person marked unread: as the host, they keep their seen words. */
  const marked = new Set<string>();
  const store = (entry: MockChat) =>
    chats.set(entry.chat.id, {
      chat: entry.chat,
      items: entry.items ?? [],
      updated_at: entry.updated_at ?? now,
      seq: 0,
      log: [],
      listeners: new Map(),
      queuedFiles: new Map(
        Object.entries(entry.queuedFiles ?? {}).map(([id, files]) => [
          id,
          files.map((file) => ({ ...file })),
        ]),
      ),
    });
  seed.chats?.forEach(store);

  const get = (id: string) => {
    const found = chats.get(id);
    if (!found) throw new ChatError("failed", `No Chat ${id}.`);
    return found;
  };
  const live = (chat: ChatState) =>
    chat.activity === "working" || chat.activity === "waiting";
  const overview = (): ChatOverview => {
    const all = [...chats.values()].filter(
      (entry) => entry.chat.retention !== "trashed",
    );
    const rows = all.map(summary);
    return {
      needs_you: rows.filter((row) => row.needs_you).length,
      unread: rows.filter(
        (row) =>
          row.status.unseen &&
          (row.status.rank === "done" || row.status.rank === "idle"),
      ).length,
      app_icon: rows.filter((row) => row.needs_you && !row.muted).length,
      working: all.filter((entry) => live(entry.chat)).length,
    };
  };
  const summary = (entry: Stored): ChatSummary => {
    const { chat, items } = entry;
    const last = <K extends TranscriptItem["kind"]>(kind: K) =>
      items
        .filter(
          (item): item is Extract<TranscriptItem, { kind: K }> =>
            item.kind === kind,
        )
        .at(-1);
    const marker = items.at(-1)?.kind === "marker" ? last("marker") : undefined;
    const ticket = chat.links.find((link) => link.kind === "ticket");
    const status = marked.has(chat.id)
      ? { ...mockStatus({ ...chat, unseen: false }, items), unseen: true }
      : mockStatus(chat, items);
    return chatSummarySchema.parse({
      id: chat.id,
      title: chat.title,
      harness_id: chat.harness.id,
      harness_name: chat.harness.name,
      project:
        chat.folder.project ??
        chat.links
          .filter((link) => link.kind === "project")
          .map(({ id, title }) => ({ id, title }))[0] ??
        null,
      tickets: chat.links.flatMap((link) =>
        link.kind === "ticket"
          ? [{ reference: link.reference, status: link.status }]
          : [],
      ),
      // As the host: a managed folder's name is an id, so the row leaves it out.
      folder_name:
        chat.folder.missing || chat.folder.managed ? null : chat.folder.name,
      first_ticket: ticket?.kind === "ticket" ? ticket.reference : null,
      retention: chat.retention,
      activity: chat.activity,
      needs_you: ["approval", "question", "failed"].includes(status.rank),
      status,
      muted: chat.muted,
      problem: chat.problem?.kind ?? null,
      interruption:
        marker?.reason === "stopped"
          ? "stopped"
          : marker?.reason === "quit"
            ? "quit"
            : marker?.reason === "stop_unconfirmed"
              ? "unconfirmed"
              : null,
      first_change: firstChange(items.filter((item) => !item.owner)) ?? null,
      preview: last("response")?.text.slice(0, 120) ?? null,
      updated_at: entry.updated_at,
    });
  };
  const notifications: (() => void)[] = [];
  const notify = <T>(listener: (value: T) => void, value: T) => {
    try {
      listener(value);
    } catch (error) {
      // A subscriber failure cannot reject a command that already committed.
      queueMicrotask(() => {
        throw error;
      });
    }
  };
  const enqueueNotification = (deliver: () => void) => {
    notifications.push(deliver);
    // A command from a subscriber can commit now, but its events follow this batch.
    if (notifications.length > 1) return;
    for (const next of notifications) next();
    notifications.length = 0;
  };
  const publish = (entry: Stored, changes: ChatChange[]) => {
    if (!changes.length) return;
    const listeners = [...entry.listeners];
    const overviewRecipients = [...overviewListeners];
    const counts = overviewRecipients.length ? overview() : undefined;
    const visible = changes.filter((change) => {
      entry.seq = change.seq;
      entry.log.push(change);
      if (entry.log.length > logLimit) entry.log.shift();
      const drop = dropping.get(entry.chat.id) ?? 0;
      if (!drop) return true;
      dropping.set(entry.chat.id, drop - 1);
      return false;
    });
    enqueueNotification(() => {
      for (const change of visible)
        for (const [listener, registration] of listeners)
          if (entry.listeners.get(listener) === registration)
            notify(listener, change);
      if (counts)
        for (const listener of overviewRecipients)
          if (overviewListeners.has(listener)) notify(listener, counts);
    });
  };
  const parseChanges = (entry: Stored, changes: Change[]) =>
    changes.map((change, index) =>
      chatChangeSchema.parse({ ...change, seq: entry.seq + index + 1 }),
    );
  const emit = (entry: Stored, change: Change) => {
    if (entry.pending) {
      if (change.kind !== "chat") entry.pending.push(change);
    } else {
      publish(entry, parseChanges(entry, [change]));
    }
  };
  const commit = (entry: Stored, apply: () => void, onCommit?: () => void) => {
    const { chat, items, queuedFiles } = entry;
    entry.items = [...items];
    entry.queuedFiles = new Map(queuedFiles);
    const pending: Change[] = [];
    entry.pending = pending;
    let changes: ChatChange[];
    try {
      apply();
      if (entry.chat !== chat) pending.push({ kind: "chat", chat: entry.chat });
      changes = parseChanges(entry, pending);
    } catch (error) {
      Object.assign(entry, { chat, items, queuedFiles });
      throw error;
    } finally {
      delete entry.pending;
    }
    onCommit?.();
    publish(entry, changes);
  };
  const push = (id: string, item: TranscriptItem) => {
    const entry = get(id);
    const index = entry.items.findIndex((known) => known.id === item.id);
    if (index < 0) entry.items.push(item);
    else entry.items[index] = item;
    emit(entry, { kind: "item", item });
  };
  const patch = (
    id: string,
    asked: Partial<Omit<ChatState, "problem">> & {
      problem?: ProblemInput | null;
    },
  ) => {
    const entry = get(id);
    const { problem, ...rest } = asked;
    let change: Partial<ChatState> = rest;
    if (problem !== undefined)
      change = {
        ...change,
        problem: problem && hostProblem(problem, entry.chat.harness.name),
      };
    // A turn that ends while nobody follows the Chat is unseen.
    const ended =
      live(entry.chat) &&
      change.activity &&
      !live({ ...entry.chat, ...change });
    if (ended && entry.listeners.size === 0)
      change = { unseen: true, ...change };
    entry.chat = settled(chatStateSchema.parse({ ...entry.chat, ...change }));
    emit(entry, { kind: "chat", chat: entry.chat });
  };
  let ids = 0;
  const nextId = (prefix: string) => `${prefix}-${(ids += 1)}`;
  const expirePending = (id: string) => {
    for (const item of [...get(id).items])
      if (item.kind === "request" && item.state === "pending")
        push(id, { ...item, state: "expired" });
  };
  const halt = (id: string, reason: "stopped" | "quit") => {
    expirePending(id);
    push(id, { id: nextId("marker"), at: now, kind: "marker", reason });
    // A turn ticketd or the person stopped is Idle; it does not turn unread.
    patch(id, {
      activity: "interrupted",
      doing: null,
      queue_paused: true,
      unseen: get(id).chat.unseen,
    });
  };
  /**
   * The person stopped these running sub-agents: each record, its rows and its
   * active run turns say so, as the host will write them.
   */
  const stopAgents = (id: string, ids: readonly string[]) => {
    const entry = get(id);
    const at = new Date().toISOString();
    const stopped = { status: "stopped", stopped_by: "person" } as const;
    for (const item of [...entry.items]) {
      if (item.kind === "sub_agent" && ids.includes(item.sub_agent)) {
        if (item.status === "running")
          push(id, { ...item, ...stopped, ended_at: at });
      } else if (
        item.kind === "turn" &&
        item.owner &&
        ids.includes(item.owner) &&
        item.outcome === "active"
      )
        push(id, { ...item, outcome: "stopped", ended_at: at });
    }
    patch(id, {
      sub_agents: entry.chat.sub_agents.map((agent) =>
        ids.includes(agent.id) && agent.status === "running"
          ? { ...agent, ...stopped, ended_at: at }
          : agent,
      ),
    });
  };
  const runningAgents = (id: string) =>
    get(id)
      .chat.sub_agents.filter((agent) => agent.status === "running")
      .map((agent) => agent.id);
  /** With nothing left running, the Chat is at rest. */
  const restIfQuiet = (id: string) => {
    const { chat } = get(id);
    if (chat.turn_running === false && runningAgents(id).length === 0)
      patch(id, { activity: "idle", turn_running: null, doing: null });
  };
  const startTurn = (
    id: string,
    text: string,
    files?: ChatAttachmentInput[],
  ) => {
    push(id, {
      id: nextId("user"),
      at: now,
      kind: "user",
      text,
      delivery: "delivered",
      ...(files?.length && { attachments: attachmentLabels(files) }),
    });
    patch(id, {
      activity: "working",
      problem: null,
      turn_running: null,
      doing: { label: "Working", since: now },
    });
  };
  const mediaTypeOf = ({ dataUrl }: ChatAttachmentInput) =>
    dataUrl.slice(5, dataUrl.indexOf(";"));
  const copyAttachments = (files?: ChatAttachmentInput[]) =>
    files?.map(({ name, dataUrl }) => ({ name, dataUrl })) ?? [];
  const matchesAttachments = (
    saved: ChatAttachmentInput[],
    files: ChatAttachmentInput[],
  ) =>
    saved.length === files.length &&
    saved.every(
      ({ name, dataUrl }, index) =>
        name === files[index]?.name && dataUrl === files[index]?.dataUrl,
    );
  const attachmentLabels = (files: ChatAttachmentInput[]) =>
    files.map((file) => ({
      id: nextId("attachment"),
      name: file.name,
      media_type: mediaTypeOf(file),
    }));
  const filesForQueued = (
    entry: Stored,
    queued: ChatState["queue"][number],
  ) => {
    const metadata = queued.attachments ?? [];
    const files = entry.queuedFiles.get(queued.id) ?? [];
    if (
      metadata.length !== files.length ||
      files.some(
        (file, index) =>
          metadata[index]?.name !== file.name ||
          metadata[index]?.media_type !== mediaTypeOf(file),
      )
    )
      throw new ChatError(
        "failed",
        `Missing matching attachment snapshots for queued message ${queued.id}.`,
      );
    return files;
  };
  const queueEdits = new Map<string, { id: string; queuedId: string }>();
  const savedQueueEdits = new Map<
    string,
    {
      id: string;
      key: string;
      files: ChatAttachmentInput[];
      result: Promise<void>;
      saved: boolean;
    }
  >();
  const queue = (id: string, text: string, files?: ChatAttachmentInput[]) => {
    const { chat, queuedFiles } = get(id);
    let queuedId = nextId("queued");
    while (chat.queue.some((row) => row.id === queuedId))
      queuedId = nextId("queued");
    if (files?.length)
      queuedFiles.set(
        queuedId,
        files.map((file) => ({ ...file })),
      );
    patch(id, {
      queue: [
        ...chat.queue,
        {
          id: queuedId,
          text,
          ...(files?.length && { attachments: attachmentLabels(files) }),
        },
      ],
    });
  };
  const linkAll = (id: string, links: LinkRef[]) => {
    const current = get(id).chat.links;
    const resolved = [...current];
    for (const link of links) {
      const record = (seed.records ?? []).find(
        (item) => item.kind === link.kind && item.id === link.id,
      );
      if (!record) throw new ChatError("failed", "The record was not found.");
      if (
        !resolved.some(
          (item) => item.kind === record.kind && item.id === record.id,
        )
      )
        resolved.push(record);
    }
    if (resolved.length !== current.length) patch(id, { links: resolved });
  };
  const removeQueued = (id: string, queuedId: string) => {
    const { chat, queuedFiles } = get(id);
    if (!chat.queue.some((item) => item.id === queuedId)) return;
    queuedFiles.delete(queuedId);
    patch(id, {
      queue: chat.queue.filter((item) => item.id !== queuedId),
    });
  };
  const send = (id: string, text: string, files?: ChatAttachmentInput[]) => {
    const { chat } = get(id);
    if (chat.retention === "trashed")
      throw new ChatError("failed", "This Chat is in Trash.");
    if (!live(chat)) startTurn(id, text, files);
    else if (
      canSteer(
        chat,
        files?.some((file) => file.dataUrl.startsWith("data:image/")),
      )
    )
      push(id, {
        id: nextId("user"),
        at: now,
        kind: "user",
        steer: true,
        text,
        delivery: "delivered",
        ...(files?.length && { attachments: attachmentLabels(files) }),
      });
    else queue(id, text, files);
  };

  const saveDraft = async (
    action: typeof send,
    id: string,
    text: string,
    links: LinkRef[],
    files?: ChatAttachmentInput[],
    edit?: QueueEditSave,
  ) => {
    const apply = (
      linked: LinkRef[],
      attachments: ChatAttachmentInput[] | undefined,
      replaces: string[],
      onCommit?: () => void,
    ) => {
      const entry = get(id);
      const { chat } = entry;
      if (chat.retention === "trashed")
        throw new ChatError("failed", "This Chat is in Trash.");
      if (
        !replaces.every((queuedId) =>
          chat.queue.some((row) => row.id === queuedId && row.editing),
        )
      )
        throw new ChatError(
          "stale",
          "The original queued message is no longer held for editing.",
        );
      commit(
        entry,
        () => {
          linkAll(id, linked);
          action(id, text, attachments);
          for (const queuedId of replaces) removeQueued(id, queuedId);
        },
        onCommit,
      );
    };
    if (!edit) return apply(links, files, []);

    const { commandId, messageIds } = edit;
    if (!messageIds.length)
      throw new ChatError("failed", "Choose a queued message to edit.");
    const replaces = [...messageIds];
    const linked = links.map(({ kind, id }) => ({ kind, id }));
    const linkKeys = [
      ...new Set(linked.map(({ kind, id }) => `${kind}:${id}`)),
    ];
    const key = JSON.stringify([id, text, linkKeys, replaces]);
    const attachments = copyAttachments(files);
    const previous = savedQueueEdits.get(commandId);
    if (previous) {
      if (
        previous.key !== key ||
        !matchesAttachments(previous.files, attachments)
      )
        throw new ChatError(
          "failed",
          `Request ID was already used for different content: ${commandId}`,
        );
      return previous.result;
    }

    // Register the exact request before any listeners can retry the save.
    const result = Promise.resolve()
      .then(() => {
        apply(linked, attachments, replaces, () => {
          receipt.saved = true;
        });
      })
      .finally(() => {
        if (!receipt.saved) savedQueueEdits.delete(commandId);
      });
    const receipt = { id, key, files: attachments, result, saved: false };
    savedQueueEdits.set(commandId, receipt);
    return result;
  };

  const client: MockChatClient = {
    quit: false,
    notify: true,
    runsGoing: 0,
    savedDocuments: [],
    openedFiles: [],
    options: new Map(
      (seed.options ?? HARNESS_OPTIONS).map((entry) => [
        entry.harness_id,
        entry,
      ]),
    ),
    created: [],
    readThroughs: [],
    folderProjects: new Map(),
    projectFolders: new Map(),
    projectCheckouts: [],
    nextFolder: null,
    push,
    patch,
    streamText(id, itemId, text) {
      const entry = get(id);
      entry.items = entry.items.map((item) =>
        item.id === itemId && item.kind === "response"
          ? { ...item, text: item.text + text }
          : item,
      );
      emit(entry, { kind: "text", item_id: itemId, text });
    },
    dropChanges: (id, count) => void dropping.set(id, count),
    setHarnesses: (next) => void (harnesses = next.map(harnessStatus)),
    requestOpen(request) {
      for (const listener of [...openListeners]) listener(request);
    },
    setTicketAgents(ticketId, agents) {
      ticketAgents.set(ticketId, ticketAgentsSchema.parse(agents));
      const counts = overview();
      enqueueNotification(() => {
        for (const listener of [...overviewListeners])
          if (overviewListeners.has(listener)) notify(listener, counts);
      });
    },
    requestQuit() {
      const stopping = { chats: overview().working, runs: client.runsGoing };
      for (const listener of [...quitListeners]) listener(stopping);
    },

    getEnabled: async () => enabled,
    async setEnabled(value) {
      if (!value)
        for (const entry of chats.values())
          if (live(entry.chat)) halt(entry.chat.id, "stopped");
      enabled = value;
    },
    overview: async () => overview(),
    stopping: async () =>
      enabled
        ? { chats: overview().working, runs: client.runsGoing }
        : { chats: 0, runs: 0 },
    subscribeOverview(listener) {
      overviewListeners.add(listener);
      return () => overviewListeners.delete(listener);
    },
    listChats: async (scope) =>
      [...chats.values()]
        .filter((entry) => entry.chat.retention === scope)
        .map(summary)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    harnesses: async () => harnesses,
    harnessCatalog: async () =>
      seed.catalog ??
      harnesses.map(({ id, name, mark_id }) => ({
        id,
        name,
        mark_id: mark_id ?? id,
        editing_agent_aliases:
          id === "claude-code" ? ["claude", id, "claude code"] : [id],
        unattended: {
          commands: id === "codex" ? "off_or_any" : "allowlist_or_any",
          reads: id === "codex" ? "requires_commands" : "independent",
          edits_in_step_folder_only: id === "codex",
          tool_note:
            id === "codex"
              ? "With Run commands on, Codex can read any file you can. Your global AGENTS.md, personal skills and “always allow” rules still apply."
              : "Claude Code may still run shell commands that only read in the step’s folder, such as listing it or printing a file there, with “Read files” and “Run commands” off. ticketd cannot switch that off.",
          native_turn_limit: id !== "codex",
        },
        permissions: (
          HARNESS_OPTIONS.find((entry) => entry.harness_id === id)?.permission
            ?.options ?? []
        ).map((choice) => ({
          id: choice.id,
          label: choice.label,
          description: choice.description ?? null,
          semantics: choice.permission ?? "own_settings",
          availability: "adapter",
          is_default: choice.is_default,
        })),
      })),
    async harnessOptions(harnessId) {
      return harnessOptionsSchema.parse(
        client.options.get(harnessId) ?? {
          harness_id: harnessId,
          models: [],
          unavailable: "It did not list its models.",
        },
      );
    },
    harnessSkills: async () => [],
    pickFolder: async () => client.nextFolder,
    listProjectFolders: async () => client.projectCheckouts,
    folderProject: async (path) => client.folderProjects.get(path) ?? null,
    projectFolder: async (id) => client.projectFolders.get(id) ?? null,
    folderUse: async (path) =>
      [...chats.values()].filter((entry) => entry.chat.folder.path === path)
        .length,
    async createChat(input) {
      const key = JSON.stringify([
        input.harness_id,
        input.folder,
        input.links.map(({ kind, id }) => [kind, id]),
        input.message,
        input.model,
        input.effort,
        input.permission,
      ]);
      const files = copyAttachments(input.attachments);
      const existing = requests.get(input.command_id);
      if (existing) {
        if (existing.key !== key || !matchesAttachments(existing.files, files))
          throw new ChatError(
            "failed",
            `Request ID was already used for different content: ${input.command_id}`,
          );
        return { chat_id: existing.id };
      }
      const harness = harnesses.find((item) => item.id === input.harness_id);
      if (!harness?.usable)
        throw new ChatError("failed", "The harness is not ready.");
      if (
        input.attachments?.length &&
        !["codex", "claude-code", "antigravity"].includes(harness.id)
      )
        throw new ChatError(
          "failed",
          "This harness can't take Chat attachments.",
        );
      let id: string;
      do id = `chat-${(created += 1)}`;
      while (chats.has(id));
      const path = input.folder ?? `~/ticketd/chats/${id}`;
      store({
        chat: chatState({
          id,
          title:
            input.message.trim().slice(0, 60) ||
            input.attachments?.[0]?.name ||
            "Untitled Chat",
          harness: { id: harness.id, name: harness.name },
          folder: {
            path,
            name: path.split("/").at(-1) ?? path,
            managed: input.folder === null,
          },
          links: (seed.records ?? []).filter((record) =>
            input.links.some(
              (link) => link.kind === record.kind && link.id === record.id,
            ),
          ),
        }),
      });
      try {
        commit(
          get(id),
          () => startTurn(id, input.message, files),
          () => {
            requests.set(input.command_id, { id, key, files });
            client.created.push(input);
          },
        );
      } catch (error) {
        chats.delete(id);
        throw error;
      }
      return { chat_id: id };
    },
    async openChat(id) {
      const entry = get(id);
      // Opening a Chat any way marks it seen.
      marked.delete(id);
      if (entry.chat.unseen) patch(id, { unseen: false });
      return chatSnapshotSchema.parse(
        structuredClone({
          chat: entry.chat,
          items: entry.items,
          cursor: entry.seq,
        }),
      );
    },
    subscribe(id, cursor, listener) {
      const entry = get(id);
      const kept = entry.log.filter((change) => change.seq > cursor);
      // The log no longer reaches back to the cursor: only a snapshot is truthful.
      const replay: ChatChange[] =
        kept.length < entry.seq - cursor
          ? [{ seq: entry.seq, kind: "resync" }]
          : kept;
      const registration = Symbol();
      const current = () => entry.listeners.get(listener) === registration;
      entry.listeners.set(listener, registration);
      const deliver = () => {
        for (const change of replay) {
          if (!current()) break;
          notify(listener, change);
        }
      };
      // Replay before any live changes that its listeners create.
      if (notifications.length) deliver();
      else enqueueNotification(deliver);
      return () => {
        if (current()) entry.listeners.delete(listener);
      };
    },
    send: (id, text, links = [], files, edit) =>
      saveDraft(send, id, text, links, files, edit),
    captureAttachment: (file) => captureChatAttachment(file, 100 * 1024 * 1024),
    async exportAttachment() {},
    queue: (id, text, links = [], files, edit) =>
      saveDraft(queue, id, text, links, files, edit),
    ticketAgents: async (ticketId) => ticketAgents.get(ticketId) ?? [],
    linkedTo: async (link) =>
      [...chats.values()]
        .filter(
          (entry) =>
            entry.chat.retention !== "trashed" &&
            entry.chat.links.some(
              (item) => item.kind === link.kind && item.id === link.id,
            ),
        )
        .map(summary)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    folderFiles: async (_folder, query) =>
      (seed.files ?? []).filter((file) =>
        file.path.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    async removeQueued(id, queuedId) {
      removeQueued(id, queuedId);
    },
    async editQueued(id, queuedId) {
      const entry = get(id);
      const queued = entry.chat.queue.find((item) => item.id === queuedId);
      if (!queued)
        throw new ChatError("stale", "This message is no longer queued.");
      const attachments = filesForQueued(entry, queued).map((file) => ({
        ...file,
      }));
      return { text: queued.text, attachments };
    },
    async checkQueueEdits(id, saves, removals) {
      return {
        saved: saves.filter((commandId) => {
          const receipt = savedQueueEdits.get(commandId);
          return receipt?.id === id && receipt.saved;
        }),
        removed: removals.filter(
          (queuedId) =>
            !get(id).chat.queue.some(
              (item) => item.id === queuedId && item.editing,
            ),
        ),
      };
    },
    async confirmQueueEdit(id, queuedId, transferId) {
      const previous = queueEdits.get(transferId);
      if (previous) return previous.id === id && previous.queuedId === queuedId;
      if (!get(id).chat.queue.some((item) => item.id === queuedId))
        return false;
      queueEdits.set(transferId, { id, queuedId });
      patch(id, {
        queue: get(id).chat.queue.map((item) =>
          item.id === queuedId ? { ...item, editing: true } : item,
        ),
      });
      return true;
    },
    async resumeQueue(id) {
      const entry = get(id);
      const { chat } = entry;
      if (chat.retention === "trashed")
        throw new ChatError("failed", "This Chat is in Trash.");
      const next = live(chat)
        ? undefined
        : chat.queue.find((item) => !item.editing);
      const files = next && filesForQueued(entry, next);
      commit(entry, () => {
        patch(id, { queue_paused: false });
        if (next) {
          startTurn(id, next.text, files);
          removeQueued(id, next.id);
        }
      });
    },
    async sendQueuedNow(id, queuedId) {
      const entry = get(id);
      const { chat } = entry;
      const queued = chat.queue.find(
        (item) => item.id === queuedId && !item.editing,
      );
      if (!queued)
        throw new ChatError("stale", "This message is no longer queued.");
      if (
        live(chat) &&
        !canSteer(
          chat,
          queued.attachments?.some((file) =>
            file.media_type.startsWith("image/"),
          ),
        )
      )
        throw new ChatError(
          "failed",
          "the Chat is working; try again when it has finished",
        );
      const files = filesForQueued(entry, queued);
      commit(entry, () => {
        send(id, queued.text, files);
        removeQueued(id, queuedId);
      });
    },
    async stop(id) {
      const entry = get(id);
      if (!live(entry.chat)) return;
      commit(entry, () => {
        const agents = runningAgents(id);
        if (entry.chat.turn_running === false) {
          // Only sub-agents run: Stop all ends them and says so below the reply.
          stopAgents(id, agents);
          push(id, {
            id: nextId("marker"),
            at: now,
            kind: "marker",
            reason: "sub_agents_stopped",
            count: Math.max(1, agents.length),
          });
          restIfQuiet(id);
        } else {
          stopAgents(id, agents);
          halt(id, "stopped");
        }
      });
    },
    async stopSubAgent(id, subAgent) {
      const entry = get(id);
      const record = entry.chat.sub_agents.find((one) => one.id === subAgent);
      if (record?.status !== "running")
        throw new ChatError("stale", "That sub-agent is no longer running.");
      commit(entry, () => {
        stopAgents(id, [subAgent]);
        restIfQuiet(id);
      });
    },
    async answer(id, requestId, answer) {
      const request = get(id).items.find((item) => item.id === requestId);
      if (request?.kind !== "request" || request.state !== "pending")
        throw new ChatError(
          "stale",
          "This request is no longer waiting for an answer.",
        );
      const option =
        "option_id" in answer
          ? request.options.find((item) => item.id === answer.option_id)
          : undefined;
      push(id, {
        ...request,
        state: "answered",
        outcome: option ? `You chose "${option.label}"` : "You answered",
        // As the host: an approval's decision is told on its step.
        folded: request.request === "approval",
        ...(request.request === "question" && {
          answer: option?.label ?? ("text" in answer ? answer.text : ""),
        }),
        resolved_at: now,
      });
      patch(id, { activity: "working" });
    },
    async resolveUncertain(id, messageId, decision) {
      const message = get(id).items.find((item) => item.id === messageId);
      if (message?.kind !== "user" || message.delivery !== "uncertain")
        throw new ChatError("stale", "That message is no longer in doubt.");
      if (decision === "discard") {
        // Set aside: it stays in the transcript, still not confirmed.
        push(id, { ...message, delivery: "set_aside" });
        patch(id, { activity: "idle", problem: null });
      } else {
        push(id, { ...message, delivery: "delivered" });
        patch(id, {
          activity: "working",
          problem: null,
          doing: { label: "Working", since: now },
        });
      }
    },
    async checkAgain(id) {
      const { chat } = get(id);
      const harness = harnesses.find((item) => item.id === chat.harness.id);
      if (harness?.usable) patch(id, { activity: "idle", problem: null });
    },
    async setFolder(id, path) {
      const { chat } = get(id);
      patch(id, {
        folder: {
          ...chat.folder,
          path,
          name: path.split("/").at(-1) ?? path,
          managed: false,
          missing: false,
        },
        problem:
          chat.problem?.kind === "folder_missing"
            ? null
            : (chat.problem ?? null),
        activity: "idle",
      });
    },
    archive: async (id) => patch(id, { retention: "archived" }),
    unarchive: async (id) => patch(id, { retention: "active" }),
    async trash(id) {
      const entry = get(id);
      commit(entry, () => {
        if (live(entry.chat)) halt(id, "stopped");
        patch(id, { retention: "trashed" });
      });
    },
    // Restoring changes where the Chat is listed and nothing else.
    restore: async (id) => patch(id, { retention: "active" }),
    async searchRecords(query) {
      const needle = query.trim().toLowerCase();
      // As the desktop client does: an exact reference leads, then names.
      const exact = (record: LinkedRecord) =>
        record.kind === "ticket" && record.reference.toLowerCase() === needle;
      const records = seed.records ?? [];
      return [
        ...records.filter(exact),
        ...records.filter(
          (record) =>
            !exact(record) && record.title.toLowerCase().includes(needle),
        ),
      ];
    },
    async addLink(id, link) {
      const record = (seed.records ?? []).find(
        (item) => item.kind === link.kind && item.id === link.id,
      );
      const { links } = get(id).chat;
      if (record && !links.some((item) => item.id === record.id))
        patch(id, { links: [...links, record] });
    },
    async removeLink(id, link) {
      patch(id, {
        links: get(id).chat.links.filter(
          (item) => !(item.kind === link.kind && item.id === link.id),
        ),
      });
    },
    async resume(id, history) {
      const messages = get(id).items.filter(
        (item) => item.kind === "user" || item.kind === "response",
      );
      push(id, {
        id: nextId("session"),
        at: now,
        kind: "session",
        history: history.kind,
        count:
          history.kind === "none"
            ? 0
            : history.kind === "picked"
              ? history.ids.length
              : history.kind === "last_messages"
                ? Math.min(history.count, messages.length)
                : history.kind === "all"
                  ? messages.length
                  : 1,
      });
      patch(id, { activity: "idle", problem: null });
    },
    async changeSetting(id, setting, value) {
      const current = get(id).chat.settings?.[setting];
      if (
        !current?.options.some(
          (option) => option.id === value && option.allowed,
        )
      )
        return { value, state: "refused", reason: "not one of its choices" };
      const change = {
        value,
        state: live(get(id).chat) ? "held" : "applied",
      } as const;
      patch(id, {
        settings: {
          ...get(id).chat.settings,
          [setting]: {
            ...current,
            ...(change.state === "applied" && { current: value }),
            change,
          },
        },
      });
      return change;
    },
    async stepOutput(id, toolId) {
      get(id);
      return seed.outputs?.[toolId] ?? null;
    },
    async openFolder(id) {
      client.openedFiles.push(get(id).chat.folder.path);
    },
    async openFile(id, path) {
      // As the host: only inside the Chat's folder, relative or absolute.
      const folder = get(id).chat.folder.path.replace(/\/+$/, "");
      const inside = path.startsWith("/")
        ? path.startsWith(`${folder}/`)
        : !path.split("/").includes("..");
      if (!inside)
        throw new ChatError(
          "failed",
          "That file is outside the Chat's folder.",
        );
      if (seed.goneFiles?.includes(path))
        throw new ChatError(
          "gone",
          `${path.split("/").at(-1)} is no longer in this folder.`,
        );
      client.openedFiles.push(path);
    },
    async saveAsDocument(id, responseId, title) {
      const response = get(id).items.find((item) => item.id === responseId);
      if (response?.kind !== "response" && response?.kind !== "plan")
        throw new ChatError("failed", "That response no longer exists.");
      client.savedDocuments.push(title);
      return `document-${client.savedDocuments.length}`;
    },
    async suggestions(_folder, linked) {
      return (seed.suggestions ?? []).filter(
        (suggestion) =>
          suggestion.kind === "triage" ||
          !linked.includes(suggestion.ticket.id),
      );
    },
    markRead: async (id) => {
      marked.delete(id);
      patch(id, { unseen: false });
    },
    markUnread: async (id) => {
      marked.add(id);
      patch(id, { unseen: true });
    },
    // As the host: kept with the Chat for the next open, and announced to no view.
    async readThrough(id, itemId) {
      client.readThroughs.push(itemId);
      const entry = get(id);
      entry.chat = { ...entry.chat, read_through: itemId };
    },
    setMuted: async (id, muted) => patch(id, { muted }),
    async setNotify(enabled) {
      client.notify = enabled;
    },
    onOpenRequested(listener) {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    onQuitRequested(listener) {
      quitListeners.add(listener);
      return () => quitListeners.delete(listener);
    },
    async answerQuit(quit) {
      if (!quit) return;
      for (const entry of chats.values())
        if (live(entry.chat)) halt(entry.chat.id, "quit");
      client.quit = true;
    },
  };
  return client;
}
