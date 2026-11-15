import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { z } from "zod";
import {
  ChatError,
  chatChangeSchema,
  chatOverviewSchema,
  chatSnapshotSchema,
  chatSummarySchema,
  createdChatSchema,
  folderFileSchema,
  harnessOptionsSchema,
  harnessStatusSchema,
  linkedRecordSchema,
  settingChangeSchema,
  openRequestSchema,
  suggestionSchema,
  type ChatChange,
  type ChatClient,
  type LinkedRecord,
  projectRefSchema,
} from "@/features/chats/client";
import { loadPreferences, setPreference } from "@/lib/preferences";
import { typedReference } from "@/features/tickets/ticket-references";

/** The fields of `show_ticket`'s reply a linked ticket needs. */
const exactTicketSchema = z.object({
  id: z.string(),
  reference: z.string(),
  title: z.string(),
  status: z.string(),
  trashed: z.boolean(),
});

/**
 * An exactly typed reference is what was asked for, so its ticket leads the
 * results, once. A ticket in the trash is not offered.
 */
function referenceFirst(
  found: LinkedRecord[],
  exact: z.infer<typeof exactTicketSchema> | null,
): LinkedRecord[] {
  if (!exact || exact.trashed) return found;
  const { id, reference, title, status } = exact;
  return [
    { kind: "ticket", id, reference, title, status },
    ...found.filter(
      (record) => !(record.kind === "ticket" && record.id === id),
    ),
  ];
}

/**
 * What the client needs from the desktop shell. Tests supply their own, so the
 * client's validation and feed handling run without a window.
 */
export type HostBridge = {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Resolves to a function that stops listening. */
  listen(
    event: string,
    handler: (payload: unknown) => void,
  ): Promise<() => void>;
  /** A value to pass as a command argument; the backend sends messages to it. */
  channel(onMessage: (message: unknown) => void): unknown;
  pickFolder(): Promise<string | null>;
  /** The person's Experimental choice, kept on this computer. */
  stored: { get(): boolean; set(enabled: boolean): boolean };
};

export function tauriBridge(): HostBridge {
  return {
    invoke,
    listen: (event, handler) =>
      listen<unknown>(event, (message) => handler(message.payload)),
    channel(onMessage) {
      const channel = new Channel<unknown>();
      channel.onmessage = onMessage;
      return channel;
    },
    async pickFolder() {
      const picked = await open({ directory: true, multiple: false });
      return typeof picked === "string" ? picked : null;
    },
    stored: {
      get: () => loadPreferences().chat,
      set: (enabled) => setPreference("chat", enabled),
    },
  };
}

const failureSchema = z.object({
  code: z.enum(["stale", "gone", "failed"]),
  message: z.string(),
});
const stoppingSchema = z.object({
  chats: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
});
const openedSchema = z.object({
  subscription: z.number().int(),
  snapshot: chatSnapshotSchema,
});

/** A view that never claims its feed is dropped once this many changes wait. */
const UNCLAIMED_LIMIT = 1000;

type Feed = {
  /** Absent until the backend has named the feed. */
  subscription?: number;
  /** Changes that arrived before a listener was attached. */
  waiting: ChatChange[];
  listener?: (change: ChatChange) => void;
  /** The last sequence number handed on. */
  last: number;
  closed: boolean;
};

/** The Chat screens' client over the desktop backend, which owns all execution. */
export function createHostChatClient(
  bridge: HostBridge = tauriBridge(),
): ChatClient {
  async function call(command: string, args?: Record<string, unknown>) {
    try {
      return await bridge.invoke(command, args);
    } catch (reason) {
      const failure = failureSchema.safeParse(reason);
      throw failure.success
        ? new ChatError(failure.data.code, failure.data.message)
        : new ChatError(
            "failed",
            // Internal: the page describes it; the text is for Details.
            reason instanceof Error ? reason.message : "The Chat host failed.",
          );
    }
  }
  const run = async (command: string, args?: Record<string, unknown>) => {
    await call(command, args);
  };
  function subscribeTo<T>(
    event: string,
    schema: z.ZodType<T>,
    listener: (value: T) => void,
  ) {
    let stopped = false;
    const stop = bridge.listen(event, (payload) => {
      const parsed = schema.safeParse(payload);
      if (!stopped && parsed.success) listener(parsed.data);
    });
    return () => {
      stopped = true;
      void stop.then(
        (unlisten) => unlisten(),
        () => {},
      );
    };
  }

  /** Feeds opened and not yet subscribed to, by Chat. */
  const unclaimed = new Map<string, Feed>();
  function close(feed: Feed) {
    if (feed.closed) return;
    feed.closed = true;
    feed.waiting = [];
    if (feed.subscription !== undefined)
      void bridge
        .invoke("chat_close", { subscription: feed.subscription })
        .catch(() => {});
  }
  /** Ends the feed with the one entry that makes the view read a new snapshot. */
  function resync(feed: Feed) {
    const listener = feed.listener;
    close(feed);
    listener?.({ seq: feed.last + 1, kind: "resync" });
  }
  function receive(id: string, feed: Feed, message: unknown) {
    if (feed.closed) return;
    const change = chatChangeSchema.safeParse(message);
    // An entry the view cannot read is a gap; never guess at what it said.
    if (!change.success) return resync(feed);
    if (feed.listener) {
      feed.last = change.data.seq;
      return feed.listener(change.data);
    }
    feed.waiting.push(change.data);
    if (feed.waiting.length > UNCLAIMED_LIMIT) {
      if (unclaimed.get(id) === feed) unclaimed.delete(id);
      close(feed);
    }
  }

  return {
    // The backend starts with Chat off and is told the stored choice here.
    async getEnabled() {
      if (!bridge.stored.get()) return false;
      await run("chat_set_enabled", { enabled: true });
      return true;
    },
    async setEnabled(enabled) {
      if (!bridge.stored.set(enabled))
        throw new ChatError("failed", "The choice could not be saved.");
      try {
        await run("chat_set_enabled", { enabled });
      } catch (reason) {
        // Chat that could not start is not left switched on.
        if (enabled) bridge.stored.set(false);
        throw reason;
      }
    },
    overview: async () => chatOverviewSchema.parse(await call("chat_overview")),
    subscribeOverview: (listener) =>
      subscribeTo("chat-overview", chatOverviewSchema, listener),
    listChats: async (scope) =>
      z.array(chatSummarySchema).parse(await call("chat_list", { scope })),
    harnesses: async () =>
      z.array(harnessStatusSchema).parse(await call("chat_harnesses")),
    harnessOptions: async (harnessId) =>
      harnessOptionsSchema.parse(
        await call("chat_harness_options", { harnessId }),
      ),
    pickFolder: () => bridge.pickFolder(),
    projectFolder: async (projectId) =>
      z
        .array(z.object({ id: z.string(), path: z.string() }))
        .parse(await call("list_projects"))
        .find((project) => project.id === projectId)?.path || null,
    folderProject: async (path) =>
      projectRefSchema
        .nullable()
        .parse(await call("chat_folder_project", { path })),
    folderUse: async (path) =>
      z
        .number()
        .int()
        .nonnegative()
        .parse(await call("chat_folder_use", { path })),
    createChat: async (input) =>
      createdChatSchema.parse(await call("chat_create", { input })),
    async openChat(id) {
      const feed: Feed = { waiting: [], last: 0, closed: false };
      const changes = bridge.channel((message) => receive(id, feed, message));
      let opened;
      try {
        opened = openedSchema.parse(
          await call("chat_open", { chatId: id, changes }),
        );
      } catch (reason) {
        feed.closed = true;
        throw reason;
      }
      feed.subscription = opened.subscription;
      feed.last = opened.snapshot.cursor;
      // An earlier open of this Chat that nobody subscribed to is abandoned.
      const earlier = unclaimed.get(id);
      if (earlier) close(earlier);
      if (feed.closed)
        // Dropped while opening; the subscriber finds no feed and opens again.
        void bridge
          .invoke("chat_close", { subscription: opened.subscription })
          .catch(() => {});
      else unclaimed.set(id, feed);
      return opened.snapshot;
    },
    subscribe(id, cursor, listener) {
      const feed = unclaimed.get(id);
      if (!feed || feed.closed || feed.last !== cursor) {
        // No feed follows that snapshot: the view opens the Chat again.
        let current = true;
        queueMicrotask(() => {
          if (current) listener({ seq: cursor + 1, kind: "resync" });
        });
        return () => {
          current = false;
        };
      }
      unclaimed.delete(id);
      feed.listener = listener;
      for (const change of feed.waiting.splice(0)) {
        if (feed.closed) break;
        feed.last = change.seq;
        listener(change);
      }
      return () => {
        delete feed.listener;
        close(feed);
      };
    },
    send: (id, text, links = []) =>
      run("chat_send", { chatId: id, text, queue: false, links }),
    queue: (id, text, links = []) =>
      run("chat_send", { chatId: id, text, queue: true, links }),
    linkedTo: async (link) =>
      z.array(chatSummarySchema).parse(await call("chat_linked_to", { link })),
    folderFiles: async (folder, query) =>
      z
        .array(folderFileSchema)
        .parse(await call("chat_files", { path: folder, query })),
    removeQueued: (id, queuedId) =>
      run("chat_remove_queued", { chatId: id, queuedId }),
    resumeQueue: (id) => run("chat_resume_queue", { chatId: id }),
    sendQueuedNow: (id, queuedId) =>
      run("chat_send_queued_now", { chatId: id, queuedId }),
    stop: (id) => run("chat_stop", { chatId: id }),
    answer: (id, requestId, answer) =>
      run("chat_answer", { chatId: id, requestId, answer }),
    resolveUncertain: (id, messageId, decision) =>
      run("chat_resolve_uncertain", { chatId: id, messageId, decision }),
    checkAgain: (id) => run("chat_check_again", { chatId: id }),
    setFolder: (id, path) => run("chat_set_folder", { chatId: id, path }),
    archive: (id) =>
      run("chat_set_retention", { chatId: id, retention: "archive" }),
    unarchive: (id) =>
      run("chat_set_retention", { chatId: id, retention: "unarchive" }),
    trash: (id) =>
      run("chat_set_retention", { chatId: id, retention: "trash" }),
    restore: (id) =>
      run("chat_set_retention", { chatId: id, retention: "restore" }),
    searchRecords: async (query) => {
      const text = query.trim();
      const [found, exact] = await Promise.all([
        call("chat_search_records", { query }).then((reply) =>
          z.array(linkedRecordSchema).parse(reply),
        ),
        // The host's search matches names, not references (CH-47); a typed
        // reference such as T-FV1 is looked up as well, as ticket pickers do.
        typedReference.test(text)
          ? call("show_ticket", { reference: text.toUpperCase() }).then(
              (reply) => exactTicketSchema.parse(reply),
              () => null,
            )
          : null,
      ]);
      return referenceFirst(found, exact);
    },
    addLink: (id, link) =>
      run("chat_set_link", { chatId: id, link, present: true }),
    removeLink: (id, link) =>
      run("chat_set_link", { chatId: id, link, present: false }),
    resume: (id, history) => run("chat_resume", { chatId: id, history }),
    changeSetting: async (id, setting, value) =>
      settingChangeSchema.parse(
        await call("chat_change_setting", { chatId: id, setting, value }),
      ),
    openFile: (id, path) => run("chat_open_file", { chatId: id, path }),
    openFolder: (id) => run("chat_open_folder", { chatId: id }),
    saveAsDocument: async (id, responseId, title) =>
      z.string().parse(
        await call("chat_save_as_document", {
          chatId: id,
          responseId,
          title,
        }),
      ),
    suggestions: async (folder, linked) =>
      z
        .array(suggestionSchema)
        .parse(await call("chat_suggestions", { folder, linked })),
    markRead: (id) => run("chat_mark_read", { chatId: id }),
    markUnread: (id) => run("chat_mark_unread", { chatId: id }),
    readThrough: (id, itemId) =>
      run("chat_read_through", { chatId: id, itemId }),
    setMuted: (id, muted) => run("chat_set_muted", { chatId: id, muted }),
    setNotify: (enabled) => run("chat_set_notify", { enabled }),
    onOpenRequested: (listener) =>
      subscribeTo("chat-open-requested", openRequestSchema, listener),
    stopping: async () => stoppingSchema.parse(await call("chat_stopping")),
    onQuitRequested: (listener) =>
      subscribeTo("chat-quit-requested", stoppingSchema, listener),
    answerQuit: (quit) => run("chat_answer_quit", { quit }),
  };
}
