import { createContext, useContext } from "react";
import { z } from "zod";
import { attachmentSchema } from "@/lib/api/attachments";
import type { TicketAgent } from "@/features/chats/ticket-agents";
import type { ChatAttachmentInput } from "@/features/chats/composer-attachments";

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
  /** The notice's title, worded by the host in the harness's name. */
  title: z.string(),
  /** Observed now, it keeps the Chat from taking a new message (the host decides). */
  blocks_send: z.boolean(),
  /** The host's plain explanation, for kinds whose wording depends on what was observed. */
  message: z.string().nullish(),
  /** Recovery offered when the harness's native history is unavailable. */
  history_recovery: z.enum(["start_fresh", "select_history"]).nullish(),
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
  z.object({
    kind: z.literal("project"),
    id: z.string(),
    title: z.string(),
    archived: z.boolean().optional(),
  }),
]);
export type LinkedRecord = z.infer<typeof linkedRecordSchema>;

export function isArchivedProjectRecord(record: LinkedRecord): boolean {
  return record.kind === "project" && record.archived === true;
}

/** A record that is no longer there to open: named, not linked. */
export const goneSchema = z.enum(["trashed", "deleted"]);
export type Gone = z.infer<typeof goneSchema>;

export const recordChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status"),
    reference: z.string(),
    title: z.string(),
    from: z.string(),
    to: z.string(),
    gone: goneSchema.nullish(),
  }),
  z.object({
    kind: z.literal("update"),
    reference: z.string(),
    excerpt: z.string(),
    gone: goneSchema.nullish(),
  }),
  z.object({
    kind: z.literal("document"),
    document_id: z.string(),
    title: z.string(),
    gone: goneSchema.nullish(),
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
  /** The word naming the rank, for one-line summaries: Idle after a reply says "Done". */
  label: z.string().nullish(),
  detail: z.string().nullish(),
});
export type ChatStatus = z.infer<typeof chatStatusSchema>;

/** A Project as a Chat names it: the folder's Project, else a linked one. */
export const projectRefSchema = z.object({ id: z.string(), title: z.string() });
export type ProjectRef = z.infer<typeof projectRefSchema>;
export type ProjectFolder = { project: ProjectRef; path: string };

export const chatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Absent from older hosts; the mark then reads as an unknown harness. */
  harness_id: z.string().nullish(),
  harness_name: z.string(),
  /** Absent while the folder is missing. */
  folder_name: z.string().nullish(),
  first_ticket: z.string().nullish(),
  project: projectRefSchema.nullish(),
  /** The linked tickets, in link order: the row's context item. */
  tickets: z
    .array(z.object({ reference: z.string(), status: z.string() }))
    .default([]),
  retention: retentionSchema,
  activity: activitySchema,
  /** A live approval or question, or a delivery the person must decide about. */
  needs_you: z.boolean(),
  problem: problemKindSchema.nullish(),
  /** `problem` is why the last turn stopped, not a condition observed now. */
  problem_past: z.boolean().nullish(),
  interruption: interruptionSchema.nullish(),
  /** The first record the agent changed in its latest turn. */
  first_change: recordChangeSchema.nullish(),
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
  mark_id: z.string().optional(),
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
  /** Chats can be started on it (the host decides). */
  usable: z.boolean(),
  /** The word shown beside its name when it isn't ready; `dot` when it needs the person. */
  word: z.object({ word: z.string(), dot: z.boolean() }).nullish(),
  /** What New Chat's notice tells when it isn't ready. */
  problem: problemSchema.nullish(),
  /** What was found or why the probe is uncertain: executable, version, requirement. */
  message: z.string().nullish(),
  command: z.string().nullish(),
  help_url: z.string().nullish(),
  /** The executable that was found, to show as a path. */
  path: z.string().nullish(),
  /** The version number it reported ("2.1.322"). */
  version: z.string().nullish(),
});
export type HarnessStatus = z.infer<typeof harnessStatusSchema>;

export const harnessInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  mark_id: z.string(),
  editing_agent_aliases: z.array(z.string()),
  unattended: z
    .object({
      commands: z.enum(["allowlist_or_any", "off_or_any"]),
      reads: z.enum(["independent", "requires_commands"]),
      edits_in_step_folder_only: z.boolean(),
      tool_note: z.string().nullable(),
      native_turn_limit: z.boolean(),
    })
    .nullable(),
  permissions: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string().nullable(),
      semantics: z.enum([
        "own_settings",
        "ask",
        "accept_edits",
        "read_only",
        "full_access",
      ]),
      availability: z.enum(["adapter", "native"]),
      is_default: z.boolean(),
    }),
  ),
});
export type HarnessInfo = z.infer<typeof harnessInfoSchema>;

const stepTargetSchema = z.object({
  /** A path relative to the Chat's folder, a pattern, a query or a page. */
  text: z.string(),
  /** The lines read, first and last. */
  lines: z.tuple([z.number(), z.number()]).nullish(),
  /** Where a search looked. */
  scope: z.string().nullish(),
});
export type StepTarget = z.infer<typeof stepTargetSchema>;

/** One word of a ticketd call's sentence; a `record` word is an id shown by its title. */
const ticketdWordSchema = z.object({
  text: z.string(),
  code: z.boolean().optional(),
  record: z.enum(["project", "document", "plan"]).nullish(),
});

/** A ticketd CLI call as a sentence: the verb, put in the step's tense, then its words. */
export const ticketdCallSchema = z.object({
  verb: z.enum([
    "read",
    "list",
    "search",
    "create",
    "change",
    "set",
    "post",
    "add",
    "move",
    "restore",
    "tag",
    "untag",
    "run",
  ]),
  words: z.array(ticketdWordSchema),
});
export type TicketdCall = z.infer<typeof ticketdCallSchema>;

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
  /** `list`: Listed; `fetch`: Fetched a page; `script`: Ran a `python3` script; `plan`: Wrote its plan. */
  variant: z.enum(["list", "fetch", "script", "plan"]).nullish(),
  /** Readable text for a step without targets: the command, tool or note. */
  target: z.string(),
  targets: z.array(stepTargetSchema).optional(),
  /** Omitted file paths, with a count when the stored evidence includes it. */
  omitted_files: z
    .object({ count: z.number().int().positive().nullable() })
    .optional(),
  /** The command without its shell wrappers. */
  command: z.string().nullish(),
  /** The harness's own one-line account of the command. Absent from older hosts and records. */
  description: z.string().nullish(),
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
  /** The output's last lines, all a view carries until the row opens. */
  output: z.string().nullish(),
  /** Set when `output` is only the last lines: where to read all of it. */
  full_output: z
    .object({ tool_id: z.string(), bytes: z.number().int().nonnegative() })
    .nullish(),
  /** Set when ticketd kept less output than the harness produced. */
  truncated: z
    .object({ kept_bytes: z.number(), total_bytes: z.number() })
    .nullish(),
  /** When the host recorded the call, for a running step's clock. */
  started_at: z.string().nullish(),
  /** Lines the step added and removed, when the harness said: its diffstat. */
  added_lines: z.number().int().nonnegative().nullish(),
  removed_lines: z.number().int().nonnegative().nullish(),
  /** The decision on the approval the harness asked for this step ("You declined this"). */
  decision: z.string().nullish(),
  /** A command that only calls ticketd, told as sentences; `command` is what runs. */
  ticketd: z.array(ticketdCallSchema).nullish(),
  /** Its approval waits in the dock, which is its only row until decided. */
  awaiting: z.boolean().optional(),
});
export type Step = z.infer<typeof stepSchema>;

const requestOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullish(),
  warning: z.string().nullish(),
});

/**
 * `turn_id`: the turn that owns the item, when one does (a sub-agent's run is a
 * turn of its own, so its items carry the run's id). `owner`: the id of the
 * sub-agent (`SubAgent.id`) whose work the item is; absent or null means the
 * Chat's main agent. The main transcript shows only the main agent's items.
 */
const item = {
  id: z.string(),
  at: z.string(),
  turn_id: z.string().nullish(),
  owner: z.string().nullish(),
};

/** How a sub-agent, or one run of it, stands. */
export const subAgentStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "stopped",
  /** ticketd quit while it ran: nothing says whether it still does. */
  "lost",
]);
export type SubAgentStatus = z.infer<typeof subAgentStatusSchema>;

/** Who ended a stopped sub-agent. */
export const subAgentStopperSchema = z.enum([
  "person",
  "ticketd",
  "main_agent",
]);

/** What the Chat's harness lets ticketd show of its sub-agents. Defaults are a full-featured harness. */
export const subAgentCapabilitiesSchema = z.object({
  /** The harness reports the prompt the sub-agent was given (Codex does not). */
  brief: z.boolean().default(true),
  /** It reports the sub-agent's own messages and reasoning (Antigravity does not). */
  text: z.boolean().default(true),
  /** It reports when the sub-agent finishes (Antigravity does not: it ends with the turn). */
  end: z.boolean().default(true),
  /** One sub-agent can be stopped alone (Stop one). */
  stop: z.boolean().default(false),
  /** A lost sub-agent can be resumed by the main agent (Claude Code). */
  resume: z.boolean().default(false),
});
export type SubAgentCapabilities = z.infer<typeof subAgentCapabilitiesSchema>;

/**
 * One sub-agent of a Chat: started by the Chat's harness, not by the person. It
 * keeps one record across its runs (a resume adds a run); `status`, `started_at`
 * and `ended_at` are those of its latest run.
 */
export const subAgentSchema = z.object({
  /** Stable within the Chat; what `owner` and `parent` name. */
  id: z.string(),
  /** The harness's own id for it. */
  native_id: z.string().nullish(),
  /** The sub-agent that started this one; null or absent when the main agent did. */
  parent: z.string().nullish(),
  /** What the sub-agent is called: the harness's own description of the work. */
  title: z.string(),
  /** The kind the harness gave it ("Explore"). */
  type: z.string().nullish(),
  /** The model it ran, as readable words ("Claude Haiku 5.5"). */
  model: z.string().nullish(),
  status: subAgentStatusSchema,
  /** Who stopped it, when `status` is `stopped`. */
  stopped_by: subAgentStopperSchema.nullish(),
  /**
   * Why ticketd stopped it (`stopped_by` is `ticketd`): the host's StopReason
   * key, such as `turned_off`, `restore`, `time_limit`, `run_ended`, `trashed`,
   * `explicit_resume` or `storage_failed`. Absent: no reason is said.
   */
  stop_reason: z.string().nullish(),
  started_at: z.string(),
  ended_at: z.string().nullish(),
  /** How many runs it has had: 2 or more once it was resumed. */
  runs: z.number().int().positive().default(1),
  /** What it was asked. `text` is absent when the harness does not report it. */
  brief: z
    .object({
      text: z.string().nullish(),
      /** Who asked: the main agent, or the sub-agent named by `parent`. */
      source: z.enum(["main_agent", "sub_agent"]),
    })
    .nullish(),
  capabilities: subAgentCapabilitiesSchema.default({
    brief: true,
    text: true,
    end: true,
    stop: false,
    resume: false,
  }),
});
export type SubAgent = z.infer<typeof subAgentSchema>;

const planStepSchema = z.object({
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  /** What the harness shows while the step runs ("Running tests"). */
  active_label: z.string().nullish(),
});
export type PlanStep = z.infer<typeof planStepSchema>;

const changedFileSchema = z.object({
  /** Relative to the Chat's folder, or with `~` for the home folder. */
  path: z.string(),
  /** The absolute path the host opens. */
  open_path: z.string(),
  kind: z.enum(["added", "modified", "deleted", "renamed"]),
  /** A renamed file's earlier path. */
  from: z.string().nullish(),
  /** Absent when the harness reported no line counts. */
  added_lines: z.number().int().nullish(),
  removed_lines: z.number().int().nullish(),
  /** The harness reported the change as made. */
  confirmed: z.boolean(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;
const chatAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  media_type: z.string(),
});
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;
/**
 * A turn the person did not start (T-UB270): the harness resumed the main agent
 * after a sub-agent finished ("Started by Claude Code: sub-agent finished"), or
 * ticketd woke it ("Started by ticketd: sub-agent finished").
 */
export const turnOriginSchema = z.object({
  by: z.enum(["harness", "ticketd"]),
  /** The `SubAgent.id` whose finishing started the turn; the line's title opens it. */
  sub_agent: z.string().nullish(),
});
export type TurnOrigin = z.infer<typeof turnOriginSchema>;

/**
 * What ticketd added to a message the person sent. `lost_sub_agents`: the sub-agents
 * that lost contact when ticketd quit, and the exact `text` it told the harness.
 */
export const messageNoteSchema = z.object({
  kind: z.literal("lost_sub_agents"),
  /** `SubAgent.id`s the note names, in the order it names them. */
  sub_agents: z.array(z.string()),
  text: z.string(),
});
export type MessageNote = z.infer<typeof messageNoteSchema>;

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
    /** Images sent with the message, kept as Attachments. */
    images: z.array(attachmentSchema).optional(),
    attachments: z.array(chatAttachmentSchema).optional(),
    /** What ticketd added to this message, shown under it ("With a note on 2 lost sub-agents"). */
    note: messageNoteSchema.nullish(),
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
    /** For each change, whether its record is now trashed or deleted. */
    gone: z.array(goneSchema.nullable()).nullish(),
    /**
     * The turn's changes up to this call, netted by the host (a ticket's status
     * moves become one move): what the receipt row says. `changes` stay raw, for
     * the fold's step rows. Absent from older hosts: the row says `changes`.
     */
    net: z.array(recordChangeSchema).nullish(),
    /** For each net change, as `gone` is for `changes`. */
    net_gone: z.array(goneSchema.nullable()).nullish(),
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
    /**
     * Who started the turn when the person did not. Absent: the person did, with
     * the message that opens the turn.
     */
    origin: turnOriginSchema.nullish(),
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
    /** An answered approval: the host tells its decision on the step it was asked for, so it has no row. */
    folded: z.boolean().nullish(),
    /** Exactly what would run, when the subject shortens it or says it as sentences. */
    command: z.string().nullish(),
    /** A command that only calls ticketd, said after the title ("wants to"). */
    ticketd: z.array(ticketdCallSchema).nullish(),
  }),
  z.object({
    ...item,
    kind: z.literal("marker"),
    /** `warning`: said by the harness; it folds with its turn. `note`: ticketd's own. */
    reason: z.enum([
      "stopped",
      // ticketd stopped the turn: it quit, Chat was turned off, a backup was
      // restored, the run was taken over, reached its time limit, or its step
      // ended; or the Chat was trashed, resumed, or its storage failed.
      "quit",
      "turned_off",
      "restore",
      "taken_over",
      "time_limit",
      "run_ended",
      "trashed",
      "explicit_resume",
      "storage_failed",
      "stop_unconfirmed",
      "failed",
      "note",
      "warning",
      /** The person stopped every running sub-agent while no turn ran. */
      "sub_agents_stopped",
    ]),
    /** Required reading for `failed` and `note`; optional detail otherwise. */
    message: z.string().nullish(),
    /** With `sub_agents_stopped`: how many sub-agents it stopped ("You stopped 2 sub-agents."). */
    count: z.number().int().positive().nullish(),
  }),
  z.object({
    ...item,
    kind: z.literal("session"),
    history: z.enum([
      "none",
      "last_response",
      "last_messages",
      "all",
      "picked",
    ]),
    count: z.number().int().nonnegative(),
  }),
  /** One reasoning item. Times are milliseconds since the Unix epoch, as reported. */
  z.object({
    ...item,
    kind: z.literal("reasoning"),
    turn_id: z.string(),
    /** `not_finished`: the turn ended first; `unknown`: contact was lost. */
    state: z.enum(["running", "done", "not_finished", "unknown"]),
    started_at: z.number().nullish(),
    ended_at: z.number().nullish(),
    /** Only what the harness showed; absent when it showed nothing or redacted it. */
    text: z.string().nullish(),
    /** A heading the harness itself marked. */
    heading: z.string().nullish(),
  }),
  /**
   * One run of a sub-agent, as the row in its parent's transcript says it. The
   * row's `owner` is the parent sub-agent (absent: the main agent), so the main
   * transcript shows only direct sub-agents. A resumed sub-agent has one row
   * for each run, in the turn that started it.
   */
  z.object({
    ...item,
    kind: z.literal("sub_agent"),
    /** `SubAgent.id`; the record is in `ChatState.sub_agents`. */
    sub_agent: z.string(),
    /** Which run of the sub-agent this row is: 1, or 2 after a resume. */
    run: z.number().int().positive().default(1),
    /** Where this run stands. */
    status: subAgentStatusSchema,
    stopped_by: subAgentStopperSchema.nullish(),
    stop_reason: z.string().nullish(),
    started_at: z.string(),
    ended_at: z.string().nullish(),
  }),
  /** A turn's plan as the harness last reported it. */
  z.object({
    ...item,
    kind: z.literal("plan"),
    turn_id: z.string(),
    /** `unconfirmed`: Stop was asked for and did not confirm. */
    state: z.enum(["running", "ended", "unconfirmed"]),
    steps: z.array(planStepSchema),
    explanation: z.string().nullish(),
  }),
  /** The files a turn changed. */
  z.object({
    ...item,
    kind: z.literal("files"),
    turn_id: z.string(),
    state: z.enum(["running", "ended"]),
    files: z.array(changedFileSchema),
  }),
]);
export type TranscriptItem = z.infer<typeof transcriptItemSchema>;
/** The transcript item of one kind: `ItemOf<"step">`. */
export type ItemOf<K extends TranscriptItem["kind"]> = Extract<
  TranscriptItem,
  { kind: K }
>;

const contextSchema = z.object({
  /** Tokens in use. */
  used: z.number(),
  /** The window's size in tokens. */
  window: z.number(),
  /** What the harness says fills the window. */
  categories: z.array(z.object({ name: z.string(), tokens: z.number() })),
  /** Where the harness compacts on its own, in tokens. */
  compacts_at: z.number().nullish(),
  /** When it was reported, in milliseconds since the Unix epoch. */
  at: z.number(),
  compacted_at: z.number().nullish(),
});
export type ContextUsage = z.infer<typeof contextSchema>;

export const settingChangeSchema = z.object({
  value: z.string(),
  /** `held`: waits for the turn to end; then `sent`, then the outcome. */
  state: z.enum([
    "held",
    "sent",
    "applied",
    "refused",
    "unconfirmed",
    "unsupported",
  ]),
  reason: z.string().nullish(),
});
export type SettingChange = z.infer<typeof settingChangeSchema>;

/** One harness setting, as the harness reported it and ticketd lets it be chosen. */
const settingSchema = z.object({
  current: z.string().nullish(),
  options: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string().nullish(),
      is_default: z.boolean(),
      permission: z
        .enum(["read_only", "ask", "accept_edits", "full_access"])
        .nullish(),
      allowed: z.boolean(),
    }),
  ),
  changeable: z.boolean(),
  /** Why it cannot be changed, when it cannot. */
  reason: z.string().nullish(),
  applies_from: z.enum(["next_turn", "next_request"]),
  /** The model the harness says answered, when not the chosen one. */
  answered_by: z.string().nullish(),
  change: settingChangeSchema.nullish(),
});
export type HarnessSetting = z.infer<typeof settingSchema>;

const settingOptionSchema = settingSchema.shape.options.element;
export type SettingOption = z.infer<typeof settingOptionSchema>;

/** What one harness offers before any session, as the installed harness reported it. */
export const harnessOptionsSchema = z.object({
  harness_id: z.string(),
  models: z.array(
    settingOptionSchema.extend({
      /** Lowest first; `is_default` marks the model's own default, when said. */
      efforts: z.array(settingOptionSchema),
      /** The model an alias row runs, by name ("Default" runs "Opus 5.5"). */
      runs_as: z.string().nullish(),
    }),
  ),
  /** `current` is unset: before a session only the harness's own setting applies. */
  permission: settingSchema.nullish(),
  /** Why it reported nothing; the picker then offers its Default only. */
  unavailable: z.string().nullish(),
});
export type HarnessOptions = z.infer<typeof harnessOptionsSchema>;

export const harnessSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
});
export type HarnessSkill = z.infer<typeof harnessSkillSchema>;

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
    shared_with: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        retention: retentionSchema,
      }),
    ),
    /** The git branch checked out there, read by the host; absent outside a repository. */
    branch: z
      .object({
        kind: z.enum(["branch", "detached", "unreadable"]),
        name: z.string().nullish(),
      })
      .nullish(),
    project: projectRefSchema.nullish(),
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
    images_refused: z.boolean().optional(),
    /** What steering does to running work, as the harness defines it. */
    effect: z.string().nullish(),
  }),
  /** Stop was asked for and the turn has not ended; Stop waits. Not set once unconfirmed. */
  stopping: z.boolean().default(false),
  links: z.array(linkedRecordSchema),
  queue: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      attachments: z.array(chatAttachmentSchema).optional(),
      editing: z.boolean().optional(),
      /** Sent to steer, and the harness did not take it: the host's reason. */
      refused_steer: z.string().nullish(),
    }),
  ),
  queue_paused: z.boolean(),
  /** The live session's context window; absent until the harness reports it. */
  context: contextSchema.nullish(),
  /** The live session's settings, for the composer's pickers (#368). */
  settings: z
    .object({
      model: settingSchema.nullish(),
      effort: settingSchema.nullish(),
      permission: settingSchema.nullish(),
    })
    .nullish(),
  unseen: z.boolean(),
  muted: z.boolean(),
  /** There is something to type into: not in trash, and the folder and session are there. */
  has_composer: z.boolean(),
  /** Linked records now in the trash: a mention of one reads "(in Trash)". */
  trashed_links: z.array(z.string()).default([]),
  /** The slash commands the live session's harness lists; `/` opens only with some. */
  commands: z
    .array(z.object({ name: z.string(), description: z.string().nullish() }))
    .default([]),
  /** The last transcript item the person had in view, kept by the host: the New marker goes after it. */
  read_through: z.string().nullish(),
  /** Every sub-agent the harness started in this Chat, oldest first. */
  sub_agents: z.array(subAgentSchema).default([]),
  /**
   * Whether a main-agent turn is running. Absent or null: what `activity` says
   * (working or waiting means a turn runs). `false` while `activity` is working
   * or waiting means only sub-agents run: the composer says "Message {Harness}"
   * and sends a new turn, Stop all says "Stop 2 sub-agents", and the transcript
   * has no working line (the strip is the live signal).
   */
  turn_running: z.boolean().nullish(),
  /**
   * Set while ticketd keeps a note on lost sub-agents for the person's next
   * message: the tray says so. Cleared when the message is sent (the note then
   * shows on that message as `note`).
   */
  restart_notice: z
    .object({
      /** `SubAgent.id`s that lost contact when ticketd quit. */
      sub_agents: z.array(z.string()),
      /** The harness can resume them (Claude Code); Codex cannot. */
      resume: z.boolean(),
    })
    .nullish(),
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

/** A file or folder in a Chat's folder; `path` is relative, with `/` separators. */
export const folderFileSchema = z.object({
  path: z.string(),
  folder: z.boolean(),
});
export type FolderFile = z.infer<typeof folderFileSchema>;

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

const linkedTicketSchema = linkedRecordSchema.options[0];
/** What New Chat offers while its box is empty, chosen by the host from local records. */
export const suggestionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("continue"),
    ticket: linkedTicketSchema,
    at: z.string().nullish(),
  }),
  z.object({
    kind: z.literal("review"),
    ticket: linkedTicketSchema,
    at: z.string().nullish(),
  }),
  /** `count` unread Inbox entries about the linked tickets; `at` is the newest. */
  z.object({
    kind: z.literal("triage"),
    count: z.number().int().positive(),
    links: z.array(linkedTicketSchema),
    at: z.string(),
  }),
]);
export type Suggestion = z.infer<typeof suggestionSchema>;
export type RequestAnswer = { option_id: string } | { text: string };
export type HistorySelection =
  | { kind: "none" }
  | { kind: "last_response" }
  | { kind: "last_messages"; count: number }
  | { kind: "all" }
  | { kind: "picked"; ids: string[] };
export type Unsubscribe = () => void;

/**
 * What turning Chat off or quitting would stop: Chats working or waiting, and
 * Automation runs that are going. A run's own Chat counts as its run.
 */
export interface Stopping {
  chats: number;
  runs: number;
}

/**
 * A command the host refused. `stale` means the request, turn or runtime it
 * named is no longer current; the view shows the current state instead. `gone`
 * means the file it named is no longer there.
 */
export class ChatError extends Error {
  constructor(
    readonly code: "stale" | "gone" | "failed" | "project_archived",
    message: string,
  ) {
    super(message);
  }
}

export type QueueEditSave = { commandId: string; messageIds: string[] };
export type QueueEditStatus = { saved: string[]; removed: string[] };

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
  /** Compiled-in harness data, without probing installations or starting Chat. */
  harnessCatalog(): Promise<HarnessInfo[]>;
  /** What a harness offers before a session; asked of the harness once per version. */
  harnessOptions(harnessId: string): Promise<HarnessOptions>;
  harnessSkills(
    harnessId: string,
    folder: string | null,
  ): Promise<HarnessSkill[]>;
  /** The native folder dialog; null when dismissed. */
  pickFolder(): Promise<string | null>;
  /** Registered Project checkouts on this computer. */
  listProjectFolders(): Promise<ProjectFolder[]>;
  /** How many Chats already run in the folder. */
  folderUse(path: string): Promise<number>;
  /** The Project whose checkout holds `path`, for New Chat's folder button. */
  folderProject(path: string): Promise<ProjectRef | null>;
  /** A Project's folder on this computer, for New Chat when it is linked; null without one. */
  projectFolder(projectId: string): Promise<string | null>;
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
    attachments?: ChatAttachmentInput[];
    /** New Chat's picks: option ids the harness offered. Unset keeps its own setting. */
    model?: string;
    effort?: string;
    permission?: string;
  }): Promise<CreatedChat>;
  openChat(id: string): Promise<ChatSnapshot>;
  /** Changes after `cursor`, in order. */
  subscribe(
    id: string,
    cursor: number,
    listener: (change: ChatChange) => void,
  ): Unsubscribe;
  /**
   * Starts a turn, or steers the one in progress; the host queues it when steering is known not to have been accepted.
   * `links` are the records the message mentions or quotes: linked as it is sent (spec 21.4).
   */
  send(
    id: string,
    text: string,
    links?: LinkRef[],
    attachments?: ChatAttachmentInput[],
    queueEdit?: QueueEditSave,
  ): Promise<void>;
  captureAttachment(file: File): Promise<ChatAttachmentInput>;
  exportAttachment(id: string, file: ChatAttachment): Promise<void>;
  queue(
    id: string,
    text: string,
    links?: LinkRef[],
    attachments?: ChatAttachmentInput[],
    queueEdit?: QueueEditSave,
  ): Promise<void>;
  /** The Chats outside the trash linked to one record. Refetch on `revision`. */
  linkedTo(link: LinkRef): Promise<ChatSummary[]>;
  /**
   * The agents at work on one ticket, in display order (T-UB271 reads it,
   * T-UB238 supplies it). Refetch on `revision`; an empty list is no agent at work.
   */
  ticketAgents(ticketId: string): Promise<TicketAgent[]>;
  /** Files and folders under `folder` matching `query`, for the composer's `@` menu. */
  folderFiles(folder: string, query: string): Promise<FolderFile[]>;
  removeQueued(id: string, queuedId: string): Promise<void>;
  editQueued(
    id: string,
    queuedId: string,
  ): Promise<{ text: string; attachments: ChatAttachmentInput[] }>;
  /** Reads save receipts and checks whether explicitly removed originals still exist. */
  checkQueueEdits(
    id: string,
    saves: string[],
    removals: string[],
  ): Promise<QueueEditStatus>;
  /** Holds the original message for editing after the draft displays its snapshot. */
  confirmQueueEdit(
    id: string,
    queuedId: string,
    transferId: string,
  ): Promise<boolean>;
  resumeQueue(id: string): Promise<void>;
  /** Sends one queued message now, alone: it steers the turn or starts one; a paused queue stays paused. */
  sendQueuedNow(id: string, queuedId: string): Promise<void>;
  stop(id: string): Promise<void>;
  /** Stops one sub-agent, where its record's `capabilities.stop` allows. No confirmation. */
  stopSubAgent(id: string, subAgent: string): Promise<void>;
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
  /**
   * Uses `value` for a harness setting from the next turn. While a turn runs
   * the change is held until it ends. Resolves to where it stands.
   */
  changeSetting(
    id: string,
    setting: "model" | "effort" | "permission",
    value: string,
  ): Promise<SettingChange>;
  /** Opens the Chat's folder itself in the file manager. */
  openFolder(id: string): Promise<void>;
  /**
   * Opens a file in the Chat's folder in the system's default app: one a step
   * named (relative to the folder) or one a turn changed (absolute). Fails with
   * `gone` when the file is no longer there; a path outside the folder fails.
   */
  openFile(id: string, path: string): Promise<void>;
  /** A step's whole output, which views carry only the last lines of; null when there is none. */
  stepOutput(id: string, toolId: string): Promise<string | null>;
  /** Ordinary core Document creation from a response or a plan; resolves to the Document's id. */
  saveAsDocument(
    id: string,
    responseId: string,
    title: string,
  ): Promise<string>;
  /**
   * New Chat's suggestions for a folder (null: one ticketd keeps), skipping the
   * tickets already linked to it.
   */
  suggestions(folder: string | null, linked: string[]): Promise<Suggestion[]>;
  /** Mark as read clears an unseen outcome, never a live request. */
  markRead(id: string): Promise<void>;
  /** The last turn reads as unseen until the Chat is next opened. */
  markUnread(id: string): Promise<void>;
  /** The person had the transcript in view through `itemId`; kept with the Chat. */
  readThrough(id: string, itemId: string): Promise<void>;
  setMuted(id: string, muted: boolean): Promise<void>;
  /** Settings > Chat > Notify me about Chats, as the person last chose it. */
  setNotify(enabled: boolean): Promise<void>;
  /** The person clicked a Chat's system notification. */
  onOpenRequested(listener: (request: OpenRequest) => void): Unsubscribe;
  /** What turning Chat off would stop now, for its confirmation. */
  stopping(): Promise<Stopping>;
  /** Quit was asked for; it would stop `stopping`. */
  onQuitRequested(listener: (stopping: Stopping) => void): Unsubscribe;
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
