import {
  ChatError,
  chatChangeSchema,
  chatSnapshotSchema,
  chatStateSchema,
  chatSummarySchema,
  type ChatChange,
  type ChatClient,
  type ChatOverview,
  type ChatState,
  type ChatStatus,
  type ChatSummary,
  type FolderFile,
  type HarnessStatus,
  type LinkRef,
  type LinkedRecord,
  type Suggestion,
  type OpenRequest,
  type TranscriptItem,
} from "@/features/chats/client";
import { changeLine, harnessUsable } from "@/features/chats/model";
import { plainText } from "@/features/documents/graph-text";

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
  ): ChatStatus => ({ rank, unseen, word, detail: detail ?? null });
  const pending = items.find(
    (item): item is Extract<TranscriptItem, { kind: "request" }> =>
      item.kind === "request" && item.state === "pending",
  );
  if (pending?.request === "approval")
    return make("approval", "Approval needed", pending.subject);
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
  if (chat.activity === "working" || chat.activity === "waiting")
    return make("working", "Working", chat.opening ? "Starting" : null);
  const marker = items.at(-1)?.kind === "marker" ? items.at(-1) : undefined;
  const reason = marker?.kind === "marker" ? marker.reason : undefined;
  if (reason === "stopped") return make("idle", "You stopped it");
  if (reason === "quit") return make("idle", "Stopped when ticketd quit");
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
  const change = items
    .filter(
      (item): item is Extract<TranscriptItem, { kind: "records" }> =>
        item.kind === "records",
    )
    .at(-1)
    ?.changes.at(-1);
  const response = items
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
  return make("idle", line ?? "Idle");
}

/** A Chat state with quiet defaults, so a test or fixture spells out only what matters. */
export function chatState(
  over: Partial<Omit<ChatState, "steering" | "folder" | "harness">> & {
    id: string;
    title: string;
    harness?: Partial<ChatState["harness"]>;
    folder?: Partial<ChatState["folder"]>;
    steering?: Partial<ChatState["steering"]>;
  },
): ChatState {
  return chatStateSchema.parse({
    retention: "active",
    activity: "idle",
    links: [],
    queue: [],
    queue_paused: false,
    // A failure in a fixture has not been seen yet.
    unseen: over.activity === "failed",
    muted: false,
    ...over,
    harness: { id: "codex", name: "Codex", ...over.harness },
    folder: {
      path: "~/code/web-app",
      name: "web-app",
      managed: false,
      missing: false,
      shared_with: [],
      ...over.folder,
    },
    steering: { available: true, ...over.steering },
  });
}

export type MockChat = {
  chat: ChatState;
  items?: TranscriptItem[];
  updated_at?: string;
};

type Stored = {
  chat: ChatState;
  items: TranscriptItem[];
  updated_at: string;
  seq: number;
  log: ChatChange[];
  listeners: Set<(change: ChatChange) => void>;
};

/** The harness side of the mock: what a test or fixture makes "happen". */
export type MockChatClient = ChatClient & {
  /** Adds a transcript item, or replaces the one with the same id. */
  push(id: string, item: TranscriptItem): void;
  streamText(id: string, itemId: string, text: string): void;
  patch(id: string, change: Partial<ChatState>): void;
  /** Loses the next `count` changes on the way to subscribers. */
  dropChanges(id: string, count: number): void;
  setHarnesses(harnesses: HarnessStatus[]): void;
  requestQuit(): void;
  /** As if the person clicked the Chat's system notification. */
  requestOpen(request: OpenRequest): void;
  /** What Notify me about Chats was last set to. */
  notify: boolean;
  /** Whether Quit was confirmed. */
  quit: boolean;
  /** Titles saved through Save as Document, in order. */
  savedDocuments: string[];
  /** Paths opened through a changed-files row or a step's file name, in order. */
  openedFiles: string[];
  /** What the next folder dialog returns. */
  nextFolder: string | null;
};

const READY: HarnessStatus[] = [
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
    harnesses?: HarnessStatus[];
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
  } = {},
): MockChatClient {
  const now = seed.now ?? "2026-11-10T10:00:00Z";
  const logLimit = seed.logLimit ?? 1000;
  let enabled = seed.enabled ?? false;
  let harnesses = seed.harnesses ?? READY;
  let created = 0;
  const requests = new Map<string, string>();
  const dropping = new Map<string, number>();
  const overviewListeners = new Set<(overview: ChatOverview) => void>();
  const openListeners = new Set<(request: OpenRequest) => void>();
  const quitListeners = new Set<(working: number) => void>();
  const chats = new Map<string, Stored>();
  const store = (entry: MockChat) =>
    chats.set(entry.chat.id, {
      chat: entry.chat,
      items: entry.items ?? [],
      updated_at: entry.updated_at ?? now,
      seq: 0,
      log: [],
      listeners: new Set(),
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
    const status = mockStatus(chat, items);
    return chatSummarySchema.parse({
      id: chat.id,
      title: chat.title,
      harness_name: chat.harness.name,
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
      last_change: last("records")?.changes.at(-1) ?? null,
      preview: last("response")?.text.slice(0, 120) ?? null,
      updated_at: entry.updated_at,
    });
  };
  const emit = (
    entry: Stored,
    change:
      | { kind: "item"; item: TranscriptItem }
      | { kind: "text"; item_id: string; text: string }
      | { kind: "chat"; chat: ChatState },
  ) => {
    entry.seq += 1;
    const parsed = chatChangeSchema.parse({ ...change, seq: entry.seq });
    entry.log.push(parsed);
    if (entry.log.length > logLimit) entry.log.shift();
    const drop = dropping.get(entry.chat.id) ?? 0;
    if (drop > 0) dropping.set(entry.chat.id, drop - 1);
    else for (const listener of [...entry.listeners]) listener(parsed);
    const counts = overview();
    for (const listener of [...overviewListeners]) listener(counts);
  };
  const push = (id: string, item: TranscriptItem) => {
    const entry = get(id);
    const index = entry.items.findIndex((known) => known.id === item.id);
    if (index < 0) entry.items.push(item);
    else entry.items[index] = item;
    emit(entry, { kind: "item", item });
  };
  const patch = (id: string, change: Partial<ChatState>) => {
    const entry = get(id);
    // A turn that ends while nobody follows the Chat is unseen.
    const ended =
      live(entry.chat) &&
      change.activity &&
      !live({ ...entry.chat, ...change });
    if (ended && entry.listeners.size === 0)
      change = { unseen: true, ...change };
    entry.chat = chatStateSchema.parse({ ...entry.chat, ...change });
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
  const startTurn = (id: string, text: string) => {
    push(id, {
      id: nextId("user"),
      at: now,
      kind: "user",
      text,
      delivery: "delivered",
    });
    patch(id, {
      activity: "working",
      problem: null,
      doing: { label: "Working", since: now },
    });
  };
  const queue = async (id: string, text: string) =>
    patch(id, {
      queue: [...get(id).chat.queue, { id: nextId("queued"), text }],
    });
  const linkAll = (id: string, links: LinkRef[]) => {
    for (const link of links) {
      const record = (seed.records ?? []).find(
        (item) => item.kind === link.kind && item.id === link.id,
      );
      if (!record) throw new ChatError("failed", "The record was not found.");
      const current = get(id).chat.links;
      if (!current.some((item) => item.id === record.id))
        patch(id, { links: [...current, record] });
    }
  };
  const send = async (id: string, text: string) => {
    const { chat } = get(id);
    if (chat.retention === "trashed")
      throw new ChatError("failed", "This Chat is in Trash.");
    if (!live(chat)) startTurn(id, text);
    else if (chat.steering.available)
      push(id, {
        id: nextId("user"),
        at: now,
        kind: "user",
        steer: true,
        text,
        delivery: "delivered",
      });
    else await queue(id, text);
  };

  const client: MockChatClient = {
    quit: false,
    notify: true,
    savedDocuments: [],
    openedFiles: [],
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
    setHarnesses: (next) => void (harnesses = next),
    requestOpen(request) {
      for (const listener of [...openListeners]) listener(request);
    },
    requestQuit() {
      for (const listener of [...quitListeners]) listener(overview().working);
    },

    getEnabled: async () => enabled,
    async setEnabled(value) {
      if (!value)
        for (const entry of chats.values())
          if (live(entry.chat)) halt(entry.chat.id, "stopped");
      enabled = value;
    },
    overview: async () => overview(),
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
    pickFolder: async () => client.nextFolder,
    folderUse: async (path) =>
      [...chats.values()].filter((entry) => entry.chat.folder.path === path)
        .length,
    async createChat(input) {
      const harness = harnesses.find((item) => item.id === input.harness_id);
      if (!harness || !harnessUsable(harness.status))
        throw new ChatError("failed", "The harness is not ready.");
      // A repeated request finds the Chat the first try created.
      const existing = requests.get(input.command_id);
      if (existing) return { chat_id: existing };
      const id = `chat-${(created += 1)}`;
      requests.set(input.command_id, id);
      const path = input.folder ?? `~/ticketd/chats/${id}`;
      store({
        chat: chatState({
          id,
          title: input.message.slice(0, 60),
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
      startTurn(id, input.message);
      return { chat_id: id };
    },
    async openChat(id) {
      const entry = get(id);
      // Opening a Chat any way marks it seen.
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
      if (kept.length < entry.seq - cursor)
        listener({ seq: entry.seq, kind: "resync" });
      else kept.forEach(listener);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    async send(id, text, links = []) {
      linkAll(id, links);
      await send(id, text);
    },
    async queue(id, text, links = []) {
      linkAll(id, links);
      await queue(id, text);
    },
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
      patch(id, {
        queue: get(id).chat.queue.filter((item) => item.id !== queuedId),
      });
    },
    async resumeQueue(id) {
      const { chat } = get(id);
      const [first, ...rest] = chat.queue;
      patch(id, {
        queue_paused: false,
        queue: first && !live(chat) ? rest : chat.queue,
      });
      if (first && !live(chat)) startTurn(id, first.text);
    },
    async sendQueuedNow(id, queuedId) {
      const { chat } = get(id);
      const queued = chat.queue.find((item) => item.id === queuedId);
      if (!queued)
        throw new ChatError("stale", "This message is no longer queued.");
      if (live(chat) && !chat.steering.available)
        throw new ChatError(
          "failed",
          "the Chat is working; try again when it has finished",
        );
      patch(id, { queue: chat.queue.filter((item) => item.id !== queuedId) });
      await send(id, queued.text);
    },
    async stop(id) {
      if (live(get(id).chat)) halt(id, "stopped");
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
      if (harness && harnessUsable(harness.status))
        patch(id, { activity: "idle", problem: null });
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
        problem: chat.problem?.kind === "folder_missing" ? null : chat.problem,
        activity: "idle",
      });
    },
    archive: async (id) => patch(id, { retention: "archived" }),
    unarchive: async (id) => patch(id, { retention: "active" }),
    async trash(id) {
      if (live(get(id).chat)) halt(id, "stopped");
      patch(id, { retention: "trashed" });
    },
    // Restoring changes where the Chat is listed and nothing else.
    restore: async (id) => patch(id, { retention: "active" }),
    async searchRecords(query) {
      const needle = query.trim().toLowerCase();
      return (seed.records ?? []).filter((record) =>
        record.title.toLowerCase().includes(needle),
      );
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
          history.kind === "picked"
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
    markRead: async (id) => patch(id, { unseen: false }),
    markUnread: async (id) => patch(id, { unseen: true }),
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
