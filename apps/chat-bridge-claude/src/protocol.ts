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
    // No permission mode can be passed: Claude Code's own setting applies, and the
    // bridge can never be asked to skip permissions.
  }),
  z.strictObject({
    id,
    cmd: z.literal("submit"),
    generation,
    submission_id: id,
    text: z.string().min(1),
    allow_active_turn: z.boolean().optional(),
  }),
  z.strictObject({
    id,
    cmd: z.literal("respond"),
    generation,
    request_id: id,
    decision,
  }),
  z.strictObject({ id, cmd: z.literal("interrupt"), generation }),
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
    }
  | {
      event: "session_info";
      generation: number;
      session_id: string | null;
      claude_code_version: string | null;
      cwd: string | null;
      model: string | null;
      permission_mode: string | null;
      capabilities: string[];
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
      denied_tool_names: string[];
      queued_turn_count: number | null;
      num_turns: number | null;
      duration_ms: number | null;
      session_id: string | null;
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

export type BridgeEvent = { v: typeof PROTOCOL_VERSION } & EventBody;
/** An event before the bridge stamps the protocol version on it. */
export type BridgeEventBody = EventBody;
