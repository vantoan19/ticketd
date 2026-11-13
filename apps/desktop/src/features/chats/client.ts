import { createContext, useContext } from "react";
import { z } from "zod";

/**
 * What the desktop host tells the Chat screens, and what they may ask of it.
 * Nothing here is a harness wire format: the host translates provider traffic
 * into these shapes, and every value crossing the bridge is parsed by a schema
 * below before a component reads it.
 */

export const retentionSchema = z.enum(["active", "archived", "trashed"]);
export type Retention = z.infer<typeof retentionSchema>;

/** Observed activity (spec 21.3). Saved history never implies `working`. */
export const activitySchema = z.enum([
  "idle",
  "working",
  "waiting",
  "interrupted",
  "failed",
]);
export type Activity = z.infer<typeof activitySchema>;

export const problemKindSchema = z.enum([
  "not_installed",
  "incompatible",
  /** ticketd's own part for this harness is missing from the installation. */
  "unavailable",
  "probe_failed",
  "not_signed_in",
  /** Signed in with an API key or cloud provider: usable, billed there. */
  "not_subscription",
  /** ticketd cannot tell whether the harness is signed in. */
  "sign_in_unknown",
  "usage_limit",
  "sandbox_unavailable",
  "uncertain_delivery",
  "folder_missing",
  "history_lost",
  "session_in_use",
  "stop_unconfirmed",
  "failed",
]);
export type ProblemKind = z.infer<typeof problemKindSchema>;

/** Why a Chat cannot continue as it is, with what the person needs to recover. */
export const problemSchema = z.object({
  kind: problemKindSchema,
  /** The host's plain explanation, for kinds whose wording depends on what was observed. */
  message: z.string().nullish(),
  /** A terminal command to copy, such as the harness's own sign-in. */
  command: z.string().nullish(),
  help_url: z.string().nullish(),
  /** When the provider said a usage limit resets, in seconds since the Unix epoch. Absent when it did not say. */
  resets_at: z.number().nullish(),
  path: z.string().nullish(),
  /** The submission whose delivery is uncertain. */
  message_id: z.string().nullish(),
  /** Why the last turn stopped, not a condition observed now: told, and it does not block Send. */
  past: z.boolean().nullish(),
});
export type Problem = z.infer<typeof problemSchema>;

export const linkedRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ticket"),
    id: z.string(),
    reference: z.string(),
    title: z.string(),
    status: z.string(),
  }),
  z.object({ kind: z.literal("document"), id: z.string(), title: z.string() }),
  z.object({ kind: z.literal("project"), id: z.string(), title: z.string() }),
]);
export type LinkedRecord = z.infer<typeof linkedRecordSchema>;

export const recordChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status"),
    reference: z.string(),
    title: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  z.object({
    kind: z.literal("update"),
    reference: z.string(),
    excerpt: z.string(),
  }),
  z.object({
    kind: z.literal("document"),
    document_id: z.string(),
    title: z.string(),
  }),
]);
export type RecordChange = z.infer<typeof recordChangeSchema>;

export const interruptionSchema = z.enum(["stopped", "quit", "unconfirmed"]);

/** Highest first: a Chat shows only its top status (spec 21.3). */
export const rankSchema = z.enum([
  "approval",
  "question",
  "working",
  "failed",
  "done",
  "idle",
]);
export type Rank = z.infer<typeof rankSchema>;

/** A Chat's ranked status and its row's second line, worded by the host. */
export const chatStatusSchema = z.object({
  rank: rankSchema,
  /** The last turn ended after the person last saw the Chat, or they marked it unread. */
  unseen: z.boolean(),
  /** "Approval needed", "Working"; for Idle, the plain last line. */
  word: z.string(),
  detail: z.string().nullish(),
});
export type ChatStatus = z.infer<typeof chatStatusSchema>;

export const chatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  harness_name: z.string(),
  /** Absent while the folder is missing. */
  folder_name: z.string().nullish(),
  first_ticket: z.string().nullish(),
  retention: retentionSchema,
  activity: activitySchema,
  /** A live approval or question, or a delivery the person must decide about. */
  needs_you: z.boolean(),
  problem: problemKindSchema.nullish(),
  /** `problem` is why the last turn stopped, not a condition observed now. */
  problem_past: z.boolean().nullish(),
  interruption: interruptionSchema.nullish(),
  last_change: recordChangeSchema.nullish(),
  /** The start of the last response. */
  preview: z.string().nullish(),
  updated_at: z.string(),
  status: chatStatusSchema,
  muted: z.boolean(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const chatOverviewSchema = z.object({
  /** Waiting for the person, muted Chats included: the sidebar count. */
  needs_you: z.number().int().nonnegative(),
  /** An unseen outcome that does not wait for the person: the blue dot. */
  unread: z.number().int().nonnegative(),
  /** Waiting Chats that are not muted: the app-icon count. */
  app_icon: z.number().int().nonnegative(),
  working: z.number().int().nonnegative(),
});
export type ChatOverview = z.infer<typeof chatOverviewSchema>;

export const harnessStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum([
    "ready",
    "not_installed",
    "incompatible",
    /** ticketd's own part for this harness is missing; reinstalling restores it. */
    "unavailable",
    "not_signed_in",
    /** Usable, but not on the harness subscription; `message` says how it bills. */
    "not_subscription",
    /** Usable as far as ticketd can tell; sign-in could not be checked. */
    "sign_in_unknown",
    "unknown",
  ]),
  /** What was found or why the probe is uncertain: executable, version, requirement. */
  message: z.string().nullish(),
  command: z.string().nullish(),
  help_url: z.string().nullish(),
  /** The executable the message is about, to show as a path. */
  path: z.string().nullish(),
});
export type HarnessStatus = z.infer<typeof harnessStatusSchema>;

const stepTargetSchema = z.object({
  /** A path relative to the Chat's folder, a pattern, a query or a page. */
  text: z.string(),
  /** The lines read, first and last. */
  lines: z.tuple([z.number(), z.number()]).nullish(),
  /** Where a search looked. */
  scope: z.string().nullish(),
});
export type StepTarget = z.infer<typeof stepTargetSchema>;

/** The host classifies every step; the view only words it (`stepWords`). */
const stepSchema = z.object({
  kind: z.enum([
    "read",
    "search",
    "edit",
    "create",
    "delete",
    "run",
    "web",
    "other",
  ]),
  /** `list`: Listed; `fetch`: Fetched a page; `script`: Ran a `python3` script. */
  variant: z.enum(["list", "fetch", "script"]).nullish(),
  /** Readable text for a step without targets: the command, tool or note. */
  target: z.string(),
  targets: z.array(stepTargetSchema).optional(),
  /** The command without its shell wrappers. */
  command: z.string().nullish(),
  exit_code: z.number().int().nullish(),
  /** Where the command ran, when that is not the Chat's folder. */
  folder: z.string().nullish(),
  timed_out: z.boolean().optional(),
  duration_ms: z.number().nullish(),
  /** A search that finished and found nothing. */
  no_matches: z.boolean().optional(),
  /**
   * Whether the step has finished. Absent from older records: read as `done`.
   * `not_finished`: the turn ended first; `unknown`: contact was lost.
   */
  state: z
    .enum(["running", "done", "failed", "declined", "not_finished", "unknown"])
    .optional(),
  /** A note about the output, already readable. */
  result: z.string().nullish(),
  output: z.string().nullish(),
  /** Set when ticketd kept less output than the harness produced. */
  truncated: z
    .object({ kept_bytes: z.number(), total_bytes: z.number() })
    .nullish(),
  /** When the host recorded the call, for a running step's clock. */
  started_at: z.string().nullish(),
});
export type Step = z.infer<typeof stepSchema>;

const requestOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullish(),
});

/** `turn_id`: the turn that owns the item, when one does. */
const item = { id: z.string(), at: z.string(), turn_id: z.string().nullish() };
export const transcriptItemSchema = z.discriminatedUnion("kind", [
  z.object({
    ...item,
    kind: z.literal("user"),
    text: z.string(),
    /** `sending` is saved locally only; it is not evidence the harness has it. */
    /** `set_aside`: delivery stayed unknown and the person chose not to resend. */
    delivery: z.enum([
      "sending",
      "delivered",
      "not_sent",
      "uncertain",
      "set_aside",
    ]),
    /** Sent to steer a turn in progress: what follows is a new segment of it. */
    steer: z.boolean().optional(),
  }),
  z.object({
    ...item,
    kind: z.literal("response"),
    text: z.string(),
    /** `partial`: a crash lost the rest; never shown as a complete response. */
    state: z.enum(["streaming", "complete", "partial"]),
  }),
  z.object({ ...item, kind: z.literal("steps"), steps: z.array(stepSchema) }),
  z.object({
    ...item,
    kind: z.literal("records"),
    changes: z.array(recordChangeSchema),
  }),
  /** When a turn started and ended, and how. It has no row of its own. */
  z.object({
    ...item,
    kind: z.literal("turn"),
    turn_id: z.string(),
    started_at: z.string(),
    ended_at: z.string().nullish(),
    /** `stopped` by the person, `quit` with ticketd, `lost`: contact was lost. */
    outcome: z.enum([
      "active",
      "completed",
      "stopped",
      "quit",
      "failed",
      "lost",
    ]),
  }),
  z.object({
    ...item,
    kind: z.literal("request"),
    request: z.enum(["approval", "question"]),
    /** Worded by the host for the current state ("wants to" / "wanted to"). */
    title: z.string(),
    subject: z.string().nullish(),
    /** For an approval: why the harness asks, apart from what would run. */
    reason: z.string().nullish(),
    options: z.array(requestOptionSchema),
    free_text: z.boolean().default(false),
    state: z.enum(["pending", "answered", "expired"]),
    /** For an answered request: "You allowed this once". */
    outcome: z.string().nullish(),
    /** For an answered question, the answer as given. */
    answer: z.string().nullish(),
    resolved_at: z.string().nullish(),
  }),
  z.object({
    ...item,
    kind: z.literal("marker"),
    reason: z.enum(["stopped", "quit", "stop_unconfirmed", "failed", "note"]),
    /** Required reading for `failed` and `note`; optional detail otherwise. */
    message: z.string().nullish(),
  }),
  z.object({
    ...item,
    kind: z.literal("session"),
    history: z.enum(["last_response", "last_messages", "all", "picked"]),
    count: z.number().int().nonnegative(),
  }),
]);
export type TranscriptItem = z.infer<typeof transcriptItemSchema>;

export const chatStateSchema = z.object({
  id: z.string(),
  title: z.string(),
  harness: z.object({
    id: z.string(),
    name: z.string(),
    /** One sentence on the harness's own effective permission setting. */
    permissions: z.string().nullish(),
  }),
  folder: z.object({
    path: z.string(),
    name: z.string(),
    managed: z.boolean(),
    missing: z.boolean(),
    /** Titles of other Chats running in the same folder. */
    shared_with: z.array(z.string()),
  }),
  retention: retentionSchema,
  activity: activitySchema,
  problem: problemSchema.nullish(),
  /** What the harness is doing now, for the working line. */
  doing: z.object({ label: z.string(), since: z.string() }).nullish(),
  /** Working, but the harness session is still opening: resuming the Chat's native session, or starting one. */
  opening: z.enum(["resume", "start"]).nullish(),
  /** The view reattached to live work and is still receiving what it missed. */
  catching_up: z.boolean().default(false),
  /** Whether Send can reach the turn in progress; otherwise input is queued. */
  steering: z.object({
    available: z.boolean(),
    /** What steering does to running work, as the harness defines it. */
    effect: z.string().nullish(),
  }),
  /** Stop was asked for and the turn has not ended; Stop waits. Not set once unconfirmed. */
  stopping: z.boolean().default(false),
  links: z.array(linkedRecordSchema),
  queue: z.array(z.object({ id: z.string(), text: z.string() })),
  queue_paused: z.boolean(),
  unseen: z.boolean(),
  muted: z.boolean(),
});
export type ChatState = z.infer<typeof chatStateSchema>;

export const chatSnapshotSchema = z.object({
  chat: chatStateSchema,
  items: z.array(transcriptItemSchema),
  /** Sequence number of the last change the snapshot includes. */
  cursor: z.number().int().nonnegative(),
});
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>;

/**
 * One entry of a Chat's ordered change log. `seq` rises by one per change; a
 * subscriber that sees a gap, or a `resync`, reopens the Chat for a snapshot.
 */
export const chatChangeSchema = z.discriminatedUnion("kind", [
  /** Adds the item, or replaces the one with the same id. */
  z.object({
    seq: z.number(),
    kind: z.literal("item"),
    item: transcriptItemSchema,
  }),
  /** Streamed text appended to a response. */
  z.object({
    seq: z.number(),
    kind: z.literal("text"),
    item_id: z.string(),
    text: z.string(),
  }),
  z.object({ seq: z.number(), kind: z.literal("chat"), chat: chatStateSchema }),
  /** The cursor is older than the kept log, or the subscriber fell behind. */
  z.object({ seq: z.number(), kind: z.literal("resync") }),
]);
export type ChatChange = z.infer<typeof chatChangeSchema>;

export type LinkRef = { kind: LinkedRecord["kind"]; id: string };

/** A click on a Chat's system notification: open it under its own list. */
export const openRequestSchema = z.object({
  chat_id: z.string(),
  retention: retentionSchema,
});
export type OpenRequest = z.infer<typeof openRequestSchema>;

/**
 * A created Chat. `send_error` says why its first message was not saved: the
 * Chat exists, so the interface opens it with the unsent text in its composer.
 */
export const createdChatSchema = z.object({
  chat_id: z.string(),
  send_error: z.string().nullish(),
});
export type CreatedChat = z.infer<typeof createdChatSchema>;
export type RequestAnswer = { option_id: string } | { text: string };
export type HistorySelection =
  | { kind: "last_response" }
  | { kind: "last_messages"; count: number }
  | { kind: "all" }
  | { kind: "picked"; ids: string[] };
export type Unsubscribe = () => void;

/**
 * A command the host refused. `stale` means the request, turn or runtime it
 * named is no longer current; the view shows the current state instead.
 */
export class ChatError extends Error {
  constructor(
    readonly code: "stale" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface ChatClient {
  /** The Experimental switch. Off by default. */
  getEnabled(): Promise<boolean>;
  /** Turning off stops working Chats first; the caller has already confirmed. */
  setEnabled(enabled: boolean): Promise<void>;
  overview(): Promise<ChatOverview>;
  /** Fires when any Chat's summary changes; never tied to the workspace poll. */
  subscribeOverview(listener: (overview: ChatOverview) => void): Unsubscribe;
  listChats(scope: Retention): Promise<ChatSummary[]>;
  /** Probes installation and sign-in again on every call. */
  harnesses(): Promise<HarnessStatus[]>;
  /** The native folder dialog; null when dismissed. */
  pickFolder(): Promise<string | null>;
  /** How many Chats already run in the folder. */
  folderUse(path: string): Promise<number>;
  /**
   * `folder: null` asks for a managed folder. `command_id` is a UUID made once
   * per request and repeated only when the very same request is sent again,
   * which then finds the same Chat; a changed request needs a new one.
   */
  createChat(input: {
    command_id: string;
    harness_id: string;
    folder: string | null;
    links: LinkRef[];
    message: string;
  }): Promise<CreatedChat>;
  openChat(id: string): Promise<ChatSnapshot>;
  /** Changes after `cursor`, in order. */
  subscribe(
    id: string,
    cursor: number,
    listener: (change: ChatChange) => void,
  ): Unsubscribe;
  /** Starts a turn, or steers the one in progress; the host queues it when steering is known not to have been accepted. */
  send(id: string, text: string): Promise<void>;
  queue(id: string, text: string): Promise<void>;
  removeQueued(id: string, queuedId: string): Promise<void>;
  resumeQueue(id: string): Promise<void>;
  /** Sends one queued message now, alone: it steers the turn or starts one; a paused queue stays paused. */
  sendQueuedNow(id: string, queuedId: string): Promise<void>;
  stop(id: string): Promise<void>;
  /** Rejects with a `stale` ChatError unless the request is the live one. */
  answer(id: string, requestId: string, answer: RequestAnswer): Promise<void>;
  /** The person's decision about a submission that may or may not have arrived. */
  resolveUncertain(
    id: string,
    messageId: string,
    decision: "resend" | "discard",
  ): Promise<void>;
  /** Re-probes whatever blocked the Chat. */
  checkAgain(id: string): Promise<void>;
  setFolder(id: string, path: string): Promise<void>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  trash(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  /** Title search over tickets, Documents and Projects. */
  searchRecords(query: string): Promise<LinkedRecord[]>;
  addLink(id: string, link: LinkRef): Promise<void>;
  removeLink(id: string, link: LinkRef): Promise<void>;
  /** Continues the same Chat in a fresh harness session started with the chosen history. */
  resume(id: string, history: HistorySelection): Promise<void>;
  /** Ordinary core Document creation; resolves to the Document's id. */
  saveAsDocument(
    id: string,
    responseId: string,
    title: string,
  ): Promise<string>;
  /** Mark as read clears an unseen outcome, never a live request. */
  markRead(id: string): Promise<void>;
  /** The last turn reads as unseen until the Chat is next opened. */
  markUnread(id: string): Promise<void>;
  setMuted(id: string, muted: boolean): Promise<void>;
  /** Settings > Chat > Notify me about Chats, as the person last chose it. */
  setNotify(enabled: boolean): Promise<void>;
  /** The person clicked a Chat's system notification. */
  onOpenRequested(listener: (request: OpenRequest) => void): Unsubscribe;
  /** Quit was asked for while Chats work; `working` is how many. */
  onQuitRequested(listener: (working: number) => void): Unsubscribe;
  answerQuit(quit: boolean): Promise<void>;
}

/**
 * Stands in until the host commands are wired: Chat reads as off and cannot
 * be turned on, so no Chat screen renders.
 */
export const unavailableChatClient: ChatClient = new Proxy({} as ChatClient, {
  get: (_, method: string) => {
    if (method === "getEnabled") return async () => false;
    if (
      method === "subscribeOverview" ||
      method === "onQuitRequested" ||
      method === "onOpenRequested"
    )
      return () => () => {};
    return async () => {
      throw new ChatError("failed", "Chat is not available in this build.");
    };
  },
});

export const ChatClientContext = createContext<ChatClient>(
  unavailableChatClient,
);
export const useChatClient = () => useContext(ChatClientContext);
