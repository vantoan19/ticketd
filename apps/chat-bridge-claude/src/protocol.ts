// The stdio protocol between the Rust Chat host and this bridge: one JSON object
// per line, commands on stdin and events on stdout.

import { isAbsolute } from "node:path";
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// Pinned in package.json; a test keeps these equal to the installed package.
export const SDK_VERSION = "0.3.322";
/** The Claude Code version this SDK release was built and tested against. */
export const SDK_CLAUDE_CODE_VERSION = "2.1.322";

const id = z.string().min(1).max(200);
const generation = z.number().int().nonnegative();
const absolutePath = z.string().refine(isAbsolute, "must be an absolute path");
const attachment = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("image"),
    media_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    data: z.base64().min(1),
  }),
  z.strictObject({
    type: z.literal("file"),
    name: z.string().min(1),
    path: absolutePath,
  }),
]);
/**
 * The modes a person's Chat can be in. `bypassPermissions` is Full access: Claude
 * Code runs every tool without asking. It is only ever the person's own pick; an
 * unattended session runs in "don't ask" whatever is sent.
 */
const permissionMode = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);
export type PermissionMode = z.infer<typeof permissionMode>;

const decision = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("allow"),
    /** Also apply the permission updates Claude Code suggested for this request. */
    remember: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("deny"),
    message: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("answer"),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  }),
]);

export const commandSchema = z.discriminatedUnion("cmd", [
  z.strictObject({ id, cmd: z.literal("hello"), protocol: z.number().int() }),
  z.strictObject({
    id,
    cmd: z.literal("inspect"),
    claude_executable: absolutePath,
  }),
  z.strictObject({
    id,
    cmd: z.literal("open"),
    generation,
    cwd: absolutePath,
    claude_executable: absolutePath,
    resume_session_id: z.string().min(1).optional(),
    // New Chat's picks; without one Claude Code's own setting applies.
    model: z.string().min(1).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    permission_mode: permissionMode.optional(),
    /**
     * Set for the Chat of an Automation run, where nobody can approve. The session
     * runs in the "don't ask" permission mode: a tool on `allowed_tools` runs and
     * anything else is denied without a prompt. The person's own Claude Code
     * settings files are not loaded, so nothing in them adds to `allowed_tools`.
     */
    unattended: z
      .strictObject({
        /** Omitted for Claude Code's default model. */
        model: z.string().min(1).optional(),
        allowed_tools: z.array(z.string().min(1)),
        disallowed_tools: z.array(z.string().min(1)),
        max_turns: z.number().int().positive(),
      })
      .optional(),
  }),
  // Lists the models Claude Code offers without a session: no prompt is sent.
  z.strictObject({
    id,
    cmd: z.literal("options"),
    claude_executable: absolutePath,
  }),
  z
    .strictObject({
      id,
      cmd: z.literal("submit"),
      generation,
      submission_id: id,
      text: z.string(),
      attachments: z.array(attachment).optional(),
      allow_active_turn: z.boolean().optional(),
    })
    .refine(
      ({ text, attachments }) => text.length > 0 || !!attachments?.length,
      "a message needs text or an attachment",
    ),
  z.strictObject({
    id,
    cmd: z.literal("respond"),
    generation,
    request_id: id,
    decision,
  }),
  z.strictObject({ id, cmd: z.literal("interrupt"), generation }),
  // Stops one task (a sub-agent running in the background) and leaves the session, its
  // turn and every other task alone. The task's own end follows as a task notification.
  z.strictObject({
    id,
    cmd: z.literal("stop_task"),
    generation,
    task_id: z.string().min(1),
  }),
  // Applies from Claude Code's next request; the host sends it between turns.
  z.strictObject({
    id,
    cmd: z.literal("set_setting"),
    generation,
    setting: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("model"), value: z.string().min(1) }),
      z.strictObject({
        kind: z.literal("effort"),
        value: z.enum(["low", "medium", "high", "xhigh", "max"]),
      }),
      z.strictObject({ kind: z.literal("permission"), value: permissionMode }),
    ]),
  }),
  z.strictObject({ id, cmd: z.literal("close"), generation }),
]);

export type Command = z.infer<typeof commandSchema>;
export type Decision = z.infer<typeof decision>;

export type RejectionCode =
  | "invalid_json"
  | "invalid_command"
  | "unsupported_protocol"
  | "no_session"
  | "session_exists"
  | "stale_generation"
  | "stale_request"
  | "turn_active"
  | "duplicate_submission"
  | "sdk_error";

/** How far an input got, as observed. Later evidence replaces earlier. */
export type InputEvidence = "none" | "handed_to_sdk" | "processing";

export type ErrorInfo = { name: string; message: string };

/** A model Claude Code offers, as `supportedModels()` describes it. */
export type ModelOption = {
  value: string;
  /** The model id `value` resolves to, when the SDK said. */
  resolved_model: string | null;
  display_name: string;
  description: string;
  /** In the SDK's order; empty when the model takes no effort level. */
  effort_levels: string[];
};

export type CommandOption = {
  /** Without its slash: "review". */
  name: string;
  description: string | null;
};

/** What a tool's structured result says, for the tools whose result is shown. */
export type ToolOutcome =
  | {
      kind: "file";
      path: string;
      /** `create` for a new file, else `update`; null when the tool did not say. */
      change: "create" | "update" | null;
      /** Counted from the patch Claude Code reported, or a new file's content. */
      added_lines: number | null;
      removed_lines: number | null;
    }
  | { kind: "task_created"; task_id: string; subject: string }
  | { kind: "task_updated"; task_id: string; success: boolean }
  | {
      kind: "task_list";
      tasks: { id: string; subject: string; status: string }[];
    };

export type ContextCategory = { name: string; tokens: number };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "other"; block_type: string | null };

type EventBody =
  | {
      event: "hello";
      id: string;
      protocol: number;
      sdk_version: string;
      sdk_claude_code_version: string;
    }
  | {
      event: "inspection";
      id: string;
      claude_executable: string;
      claude_version: string | null;
      sdk_version: string;
      sdk_claude_code_version: string;
      pairing: "matched" | "mismatched" | "unknown";
      error: string | null;
    }
  | {
      event: "options";
      id: string;
      models: ModelOption[];
      /** How Claude Code describes its account (no credential), when it said. */
      account: {
        subscription_type: string | null;
        token_source: string | null;
        api_key_source: string | null;
        api_provider: string | null;
      } | null;
      error: string | null;
    }
  | {
      event: "command_rejected";
      id: string | null;
      code: RejectionCode;
      message: string;
    }
  | { event: "session_opened"; id: string; generation: number }
  | {
      event: "session_initialized";
      generation: number;
      claude_code_version: string | null;
      models: ModelOption[];
      /** The slash commands Claude Code lists for the session, in its order. */
      commands: CommandOption[];
    }
  | {
      event: "session_info";
      generation: number;
      session_id: string | null;
      claude_code_version: string | null;
      cwd: string | null;
      model: string | null;
      permission_mode: string | null;
      /** The effort for the next message, when Claude Code published it. */
      effort: string | null;
      capabilities: string[];
    }
  | {
      /** A thinking block began or ended; `at` is when the bridge saw it (ms). */
      event: "thinking";
      generation: number;
      phase: "started" | "stopped";
      index: number | null;
      redacted: boolean;
      at: number;
      parent_tool_use_id: string | null;
    }
  | {
      /** `get_context_usage`'s answer: the window and what fills it. */
      event: "context_usage";
      generation: number;
      total_tokens: number;
      max_tokens: number;
      categories: ContextCategory[];
      /** Where Claude Code compacts on its own; null when auto-compact is off. */
      compacts_at: number | null;
    }
  | { event: "compacted"; generation: number }
  | {
      event: "setting_result";
      id: string;
      generation: number;
      outcome: "applied" | "refused";
      message: string | null;
    }
  | { event: "input_handed_to_sdk"; generation: number; submission_id: string }
  | { event: "input_processing"; generation: number; submission_ids: string[] }
  | {
      event: "delta";
      generation: number;
      kind: "text" | "thinking";
      text: string;
      index: number | null;
      parent_tool_use_id: string | null;
    }
  | {
      event: "assistant_content";
      generation: number;
      uuid: string | null;
      message_id: string | null;
      parent_tool_use_id: string | null;
      /** The model the message reports, e.g. a sub-agent's own (null when it says none). */
      model: string | null;
      blocks: ContentBlock[];
      error: string | null;
      aborted: boolean;
    }
  | {
      event: "tool_result";
      generation: number;
      tool_use_id: string | null;
      parent_tool_use_id: string | null;
      is_error: boolean;
      text: string;
      truncated: boolean;
      outcome: ToolOutcome | null;
    }
  | {
      event: "permission_request";
      generation: number;
      request_id: string;
      tool_name: string;
      tool_use_id: string;
      input: Record<string, unknown>;
      title: string | null;
      display_name: string | null;
      description: string | null;
      decision_reason: string | null;
      blocked_path: string | null;
      agent_id: string | null;
      default_to_no: boolean;
      can_remember: boolean;
    }
  | {
      event: "question_request";
      generation: number;
      request_id: string;
      tool_use_id: string;
      agent_id: string | null;
      questions: unknown;
    }
  | {
      event: "request_resolved";
      id: string;
      generation: number;
      request_id: string;
      outcome: Decision["kind"];
    }
  | {
      event: "request_cancelled";
      generation: number;
      request_id: string;
      reason: "aborted" | "interrupted" | "session_ended";
    }
  | {
      event: "stop_task_result";
      id: string;
      generation: number;
      task_id: string;
      /** `asked`: the SDK took the request; the task's end follows as `sub_agent_ended`. */
      outcome: "asked" | "refused";
      message: string | null;
    }
  | {
      event: "interrupt_result";
      id: string;
      generation: number;
      receipt: boolean;
      still_queued_submission_ids: string[];
    }
  | {
      event: "turn_result";
      generation: number;
      correlation: "uuid" | "none";
      submission_ids: string[];
      unmatched_uuids: string[];
      pending_submission_ids: string[];
      subtype: string | null;
      is_error: boolean;
      result_text: string | null;
      errors: string[];
      stop_reason: string | null;
      terminal_reason: string | null;
      /**
       * What Claude Code denied: the tool, the command when it was a shell, and
       * the path when it was a file tool.
       */
      denials: {
        tool_name: string;
        command: string | null;
        path: string | null;
      }[];
      queued_turn_count: number | null;
      num_turns: number | null;
      duration_ms: number | null;
      session_id: string | null;
    }
  | {
      /**
       * A sub-agent began, or was resumed for another run: an agent-kind task. Shell
       * and monitor tasks, and ambient or transcript-less ones, are not sub-agents
       * and arrive as `sdk_message_unmapped`. `tool_use_id` is the `Agent` tool call
       * that started it, and what its frames name as `parent_tool_use_id`.
       */
      event: "sub_agent_started";
      generation: number;
      task_id: string;
      run_id: string | null;
      tool_use_id: string | null;
      /** The sub-agent task whose agent started this one; null for the main agent's. */
      parent_task_id: string | null;
      description: string;
      subagent_type: string | null;
      /** Registered in the background rather than blocking the `Agent` tool call. */
      background: boolean;
      /** What it was asked, cut to `MAX_SUB_AGENT_PROMPT_CHARS`. */
      prompt: string | null;
      prompt_truncated: boolean;
      spawn_depth: number | null;
    }
  | {
      /** A change to a sub-agent's task state. Only what the SDK patched is set. */
      event: "sub_agent_updated";
      generation: number;
      task_id: string;
      run_id: string | null;
      status: SubAgentTaskStatus | null;
      description: string | null;
      /** Set when the task moved to (or out of) the background. */
      background: boolean | null;
      error: string | null;
    }
  | {
      /** A sub-agent run ended, as the SDK's task notification says. */
      event: "sub_agent_ended";
      generation: number;
      task_id: string;
      run_id: string | null;
      tool_use_id: string | null;
      status: "completed" | "failed" | "stopped";
      /** Set when it did not end in an ordinary way: `worker_restart`. */
      reason: string | null;
      summary: string;
    }
  | {
      event: "sdk_message_unmapped";
      generation: number;
      sdk_type: string | null;
      sdk_subtype: string | null;
      json: string;
      truncated: boolean;
    }
  | {
      event: "sdk_error";
      generation: number;
      source: "initialize" | "interrupt";
      error: ErrorInfo;
    }
  | {
      event: "session_ended";
      generation: number;
      reason: "closed" | "output_ended" | "sdk_error";
      error: ErrorInfo | null;
      unresolved_inputs: { submission_id: string; evidence: InputEvidence }[];
    };

/** A sub-agent task's status, as the SDK's `task_updated` patch names it. */
export type SubAgentTaskStatus =
  "pending" | "running" | "completed" | "failed" | "killed" | "paused";

export type BridgeEvent = { v: typeof PROTOCOL_VERSION } & EventBody;
/** An event before the bridge stamps the protocol version on it. */
export type BridgeEventBody = EventBody;
