import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { z } from "zod";
import { ticketAgentsSchema } from "@/features/chats/ticket-agents";
import {
  ChatError,
  chatChangeSchema,
  chatOverviewSchema,
  chatSnapshotSchema,
  chatSummarySchema,
  createdChatSchema,
  folderFileSchema,
  harnessInfoSchema,
  harnessOptionsSchema,
  harnessSkillSchema,
  harnessInstallationSchema,
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
import { projectSchema } from "@/lib/api/client";
import { typedReference } from "@/features/tickets/ticket-references";
import {
  CaptureError,
  captureChatAttachment,
} from "@/features/chats/composer-attachments";

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
  saveFile(name: string): Promise<string | null>;
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
    saveFile: (name) =>
      save({ title: "Save Chat attachment", defaultPath: name }),
    stored: {
      get: () => loadPreferences().chat,
      set: (enabled) => setPreference("chat", enabled),
    },
  };
}

const failureSchema = z.object({
  code: z.enum(["stale", "gone", "failed", "project_archived", "contact_lost"]),
  message: z.string(),
});
const invalidAttachment = z.object({
  code: z.literal("invalid_attachment"),
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
  key: string | AbortSignal;
  /** Absent until the backend has named the feed. */
  subscription?: number;
  /** Changes that arrived before a listener was attached. */
  waiting: ChatChange[];
  listener?: (change: ChatChange) => void;
  /** The last sequence number handed on. */
  last: number;
  closed: boolean;
  removeAbortListener?: () => void;
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
  const listProjects = async () =>
    z.array(projectSchema).parse(await call("list_projects"));
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

  /** Feeds awaiting their view. Readers without a signal use the Chat ID. */
  const unclaimed = new Map<Feed["key"], Feed>();
  function close(feed: Feed) {
    if (feed.closed) return;
    if (unclaimed.get(feed.key) === feed) unclaimed.delete(feed.key);
    feed.closed = true;
    feed.waiting = [];
    feed.removeAbortListener?.();
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
  function receive(feed: Feed, message: unknown) {
    // An update's changes come as one array, so the view draws once for them.
    if (Array.isArray(message)) {
      for (const each of message) receive(feed, each);
      return;
    }
    if (feed.closed) return;
    const change = chatChangeSchema.safeParse(message);
    // An entry the view cannot read is a gap; never guess at what it said.
    if (!change.success) return resync(feed);
    if (feed.listener) {
      feed.last = change.data.seq;
      return feed.listener(change.data);
    }
    feed.waiting.push(change.data);
    if (feed.waiting.length > UNCLAIMED_LIMIT) close(feed);
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
    installedHarnesses: async () =>
      z
        .array(harnessInstallationSchema)
        .parse(await call("chat_installed_harnesses")),
    harnessCatalog: async () =>
      z.array(harnessInfoSchema).parse(await call("chat_harness_catalog")),
    harnessOptions: async (harnessId) =>
      harnessOptionsSchema.parse(
        await call("chat_harness_options", { harnessId }),
      ),
    harnessSkills: async (harnessId, folder) =>
      z
        .array(harnessSkillSchema)
        .parse(await call("chat_harness_skills", { harnessId, folder })),
    pickFolder: () => bridge.pickFolder(),
    listProjectFolders: async () =>
      (await listProjects())
        .filter((project) => !project.archived)
        .flatMap(({ id, name, paths }) => {
          const project = { id, title: name };
          return paths.filter(Boolean).map((path) => ({ project, path }));
        }),
    projectFolder: async (projectId) =>
      (await listProjects()).find(
        (project) => project.id === projectId && !project.archived,
      )?.path || null,
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
    async openChat(id, signal) {
      const key = signal ?? id;
      const feed: Feed = { key, waiting: [], last: 0, closed: false };
      const changes = bridge.channel((message) => receive(feed, message));
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
      if (feed.closed) {
        // Dropped while opening; the subscriber finds no feed and opens again.
        void bridge
          .invoke("chat_close", { subscription: opened.subscription })
          .catch(() => {});
      } else if (signal?.aborted) {
        close(feed);
      } else {
        const earlier = unclaimed.get(key);
        if (earlier) close(earlier);
        unclaimed.set(key, feed);
        if (signal) {
          const cancel = () => close(feed);
          signal.addEventListener("abort", cancel, { once: true });
          feed.removeAbortListener = () =>
            signal.removeEventListener("abort", cancel);
        }
      }
      return opened.snapshot;
    },
    subscribe(id, cursor, listener, signal) {
      const key = signal ?? id;
      const feed = unclaimed.get(key);
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
      unclaimed.delete(key);
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
    send: (id, text, links = [], attachments, queueEdit) =>
      run("chat_send", {
        chatId: id,
        text,
        queue: false,
        links,
        ...(attachments && { attachments }),
        ...(queueEdit && { queueEdit }),
      }),
    async captureAttachment(file) {
      const limit = z
        .number()
        .int()
        .positive()
        .parse(await bridge.invoke("attachment_upload_limit"));
      return captureChatAttachment(file, limit, async (attachment) => {
        let reply: unknown;
        try {
          reply = await bridge.invoke("chat_capture_attachment", {
            attachment,
          });
        } catch (reason) {
          const failure = invalidAttachment.safeParse(reason);
          if (failure.success) throw new CaptureError(failure.data.message);
          throw reason;
        }
        return z.string().parse(reply);
      });
    },
    async exportAttachment(id, file) {
      const destination = await bridge.saveFile(file.name);
      if (destination)
        await run("chat_export_attachment", {
          chatId: id,
          id: file.id,
          destination,
        });
    },
    queue: (id, text, links = [], attachments, queueEdit) =>
      run("chat_send", {
        chatId: id,
        text,
        queue: true,
        links,
        ...(attachments && { attachments }),
        ...(queueEdit && { queueEdit }),
      }),
    linkedTo: async (link) =>
      z.array(chatSummarySchema).parse(await call("chat_linked_to", { link })),
    ticketAgents: async (ticketId) =>
      ticketAgentsSchema.parse(await call("chat_ticket_agents", { ticketId })),
    folderFiles: async (folder, query) =>
      z
        .array(folderFileSchema)
        .parse(await call("chat_files", { path: folder, query })),
    removeQueued: (id, queuedId) =>
      run("chat_remove_queued", { chatId: id, queuedId }),
    editQueued: async (id, queuedId) =>
      z
        .object({
          text: z.string(),
          attachments: z.array(
            z.object({ name: z.string(), dataUrl: z.string() }),
          ),
        })
        .parse(
          await call("chat_remove_queued", {
            chatId: id,
            queuedId,
            edit: true,
          }),
        ),
    checkQueueEdits: async (id, saves, removals) =>
      z
        .object({ saved: z.array(z.string()), removed: z.array(z.string()) })
        .parse(
          await call("chat_check_queue_edits", { chatId: id, saves, removals }),
        ),
    confirmQueueEdit: async (id, queuedId, transferId) =>
      z.boolean().parse(
        await call("chat_confirm_queue_edit", {
          chatId: id,
          queuedId,
          transferId,
        }),
      ),
    resumeQueue: (id) => run("chat_resume_queue", { chatId: id }),
    sendQueuedNow: (id, queuedId) =>
      run("chat_send_queued_now", { chatId: id, queuedId }),
    stop: (id) => run("chat_stop", { chatId: id }),
    stopSubAgent: (id, subAgent) =>
      run("chat_stop_sub_agent", { chatId: id, subAgent }),
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
    stepOutput: async (id, toolId) =>
      z
        .string()
        .nullable()
        .parse(await call("chat_step_output", { chatId: id, toolId })),
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
