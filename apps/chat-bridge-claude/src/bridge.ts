// Translates host commands into Claude Agent SDK calls and SDK output into
// protocol events. It holds SDK objects and callbacks for one session at a time
// and nothing durable: the Rust host owns the queue, storage and process lifetime.

import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  PROTOCOL_VERSION,
  SDK_CLAUDE_CODE_VERSION,
  SDK_VERSION,
  commandSchema,
  type BridgeEvent,
  type BridgeEventBody,
  type Command,
  type ContentBlock,
  type ErrorInfo,
  type InputEvidence,
  type RejectionCode,
} from "./protocol";

/** Characters kept from the end of one tool result; the host stores the last 1 MiB per output. */
export const MAX_TOOL_RESULT_CHARS = 1_048_576;
/** Characters kept from an SDK frame the bridge has no event for. */
export const MAX_UNMAPPED_JSON_CHARS = 4096;

/** The part of an SDK query handle the bridge uses. The SDK's `Query` satisfies it. */
export interface SdkQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<{ still_queued: string[] } | undefined>;
  initializationResult(): Promise<{ claude_code_version?: string }>;
  close(): void;
}

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => SdkQuery;

export interface BridgeDeps {
  query: QueryFn;
  emit: (event: BridgeEvent) => void;
  /** Bounded diagnostics for stderr; never protocol data. */
  diagnostic: (text: string) => void;
  /** Runs `<executable> --version` and returns its output. Starts no session. */
  readClaudeVersion: (executable: string) => Promise<string>;
}

type Json = Record<string, unknown>;

interface Submission {
  submissionId: string;
  evidence: InputEvidence;
}

interface PendingRequest {
  isQuestion: boolean;
  input: Json;
  suggestions: NonNullable<Parameters<CanUseTool>[2]["suggestions"]>;
  resolve: (result: PermissionResult) => void;
}

/** Session state the SDK callbacks need; it exists before the query handle does. */
interface SessionState {
  generation: number;
  /** Unresolved inputs by the uuid sent to Claude Code, in submission order. */
  submissions: Map<string, Submission>;
  inputQueue: SDKUserMessage[];
  wakeInput: (() => void) | undefined;
  requests: Map<string, PendingRequest>;
  ended: boolean;
}

interface Session extends SessionState {
  query: SdkQuery;
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : null);
const number = (value: unknown) => (typeof value === "number" ? value : null);
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

const errorInfo = (error: unknown): ErrorInfo =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };

export function createBridge(deps: BridgeDeps) {
  let session: Session | undefined;
  let lastGeneration = -1;
  let requestCounter = 0;

  const emit = (body: BridgeEventBody) =>
    deps.emit({ v: PROTOCOL_VERSION, ...body });

  const reject = (id: string | null, code: RejectionCode, message: string) =>
    emit({ event: "command_rejected", id, code, message });

  function handleLine(line: string) {
    if (line.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      return reject(null, "invalid_json", errorInfo(error).message);
    }
    const id = isObject(raw) ? text(raw.id) : null;
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) {
      return reject(id, "invalid_command", parsed.error.message);
    }
    const command = parsed.data;
    switch (command.cmd) {
      case "hello":
        return hello(command);
      case "inspect":
        return void inspect(command);
      case "open":
        return open(command);
      default: {
        const current = session;
        if (!current || current.generation !== command.generation) {
          return current || command.generation <= lastGeneration
            ? reject(command.id, "stale_generation", "not the open generation")
            : reject(command.id, "no_session", "no session is open");
        }
        switch (command.cmd) {
          case "submit":
            return submit(current, command);
          case "respond":
            return respond(current, command);
          case "interrupt":
            return interrupt(current, command);
          case "close":
            return endSession(current, "closed", null);
        }
      }
    }
  }

  function hello(command: Extract<Command, { cmd: "hello" }>) {
    if (command.protocol !== PROTOCOL_VERSION) {
      return reject(
        command.id,
        "unsupported_protocol",
        `this bridge speaks protocol ${PROTOCOL_VERSION}`,
      );
    }
    emit({
      event: "hello",
      id: command.id,
      protocol: PROTOCOL_VERSION,
      sdk_version: SDK_VERSION,
      sdk_claude_code_version: SDK_CLAUDE_CODE_VERSION,
    });
  }

  async function inspect(command: Extract<Command, { cmd: "inspect" }>) {
    let version: string | null = null;
    let error: string | null = null;
    try {
      const output = await deps.readClaudeVersion(command.claude_executable);
      version = /^\s*(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
      if (!version) error = "unrecognized version output";
    } catch (cause) {
      error = errorInfo(cause).message;
    }
    emit({
      event: "inspection",
      id: command.id,
      claude_executable: command.claude_executable,
      claude_version: version,
      sdk_version: SDK_VERSION,
      sdk_claude_code_version: SDK_CLAUDE_CODE_VERSION,
      pairing:
        version === null
          ? "unknown"
          : version === SDK_CLAUDE_CODE_VERSION
            ? "matched"
            : "mismatched",
      error,
    });
  }

  function open(command: Extract<Command, { cmd: "open" }>) {
    if (session) {
      return reject(
        command.id,
        "session_exists",
        "close the open session first",
      );
    }
    if (command.generation <= lastGeneration) {
      return reject(command.id, "stale_generation", "generation already used");
    }
    const state: SessionState = {
      generation: command.generation,
      submissions: new Map(),
      inputQueue: [],
      wakeInput: undefined,
      requests: new Map(),
      ended: false,
    };
    const options: Options = {
      cwd: command.cwd,
      // Always the user's installed Claude Code, never a binary bundled with the SDK.
      pathToClaudeCodeExecutable: command.claude_executable,
      // The SDK defaults to an empty system prompt; these keep Claude Code's own
      // prompt, settings, CLAUDE.md, skills, plugins, hooks and MCP configuration.
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      canUseTool: (toolName, input, context) =>
        requestDecision(state, toolName, input, context),
      stderr: deps.diagnostic,
      ...(command.resume_session_id && { resume: command.resume_session_id }),
      ...(command.unattended && {
        permissionMode: "dontAsk" as const,
        allowedTools: command.unattended.allowed_tools,
        disallowedTools: command.unattended.disallowed_tools,
        maxTurns: command.unattended.max_turns,
        ...(command.unattended.model && { model: command.unattended.model }),
        // "Don't ask" denies before this is reached. Should a request arrive
        // anyway, it is denied here: nobody is there for the host to ask.
        canUseTool: async () => ({
          behavior: "deny" as const,
          message: "This tool is not among the agent's allowed tools.",
        }),
      }),
    };
    let opening: Session;
    try {
      const query = deps.query({ prompt: produceInput(state), options });
      opening = Object.assign(state, { query });
    } catch (error) {
      return reject(command.id, "sdk_error", errorInfo(error).message);
    }
    session = opening;
    lastGeneration = command.generation;
    emit({
      event: "session_opened",
      id: command.id,
      generation: command.generation,
    });
    void readOutput(opening);
    opening.query.initializationResult().then(
      (init) =>
        emit({
          event: "session_initialized",
          generation: opening.generation,
          claude_code_version: init.claude_code_version ?? null,
        }),
      (error: unknown) => {
        // A lost process also ends the output stream, which reports the loss.
        if (opening.ended) return;
        emit({
          event: "sdk_error",
          generation: opening.generation,
          source: "initialize",
          error: errorInfo(error),
        });
      },
    );
  }

  /**
   * The held-open input stream. The SDK reads it for the whole session, so its
   * consumption is not a per-message receipt; the only thing observable here is
   * the moment the SDK takes a message.
   */
  async function* produceInput(
    current: SessionState,
  ): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (current.inputQueue.length === 0 && !current.ended) {
        await new Promise<void>((resolve) => (current.wakeInput = resolve));
      }
      const message = current.inputQueue.shift();
      if (current.ended || !message) return;
      const submission = current.submissions.get(message.uuid ?? "");
      if (submission) {
        submission.evidence = "handed_to_sdk";
        emit({
          event: "input_handed_to_sdk",
          generation: current.generation,
          submission_id: submission.submissionId,
        });
      }
      yield message;
    }
  }

  function submit(
    current: Session,
    command: Extract<Command, { cmd: "submit" }>,
  ) {
    const unresolved = [...current.submissions.values()];
    if (unresolved.some((s) => s.submissionId === command.submission_id)) {
      return reject(
        command.id,
        "duplicate_submission",
        "submission is unresolved",
      );
    }
    if (unresolved.length > 0 && !command.allow_active_turn) {
      return reject(command.id, "turn_active", "a turn is active");
    }
    const uuid = randomUUID();
    current.submissions.set(uuid, {
      submissionId: command.submission_id,
      evidence: "none",
    });
    current.inputQueue.push({
      type: "user",
      uuid,
      message: { role: "user", content: command.text },
      parent_tool_use_id: null,
    });
    current.wakeInput?.();
  }

  function requestDecision(
    current: SessionState,
    toolName: string,
    input: Json,
    context: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    return new Promise((resolve) => {
      if (current.ended || context.signal.aborted) {
        return resolve({ behavior: "deny", message: "Request cancelled" });
      }
      const requestId = `${current.generation}-${++requestCounter}`;
      const isQuestion = toolName === "AskUserQuestion";
      const suggestions = context.suppressAlwaysAllowRule
        ? []
        : (context.suggestions ?? []);
      current.requests.set(requestId, {
        isQuestion,
        input,
        suggestions,
        resolve,
      });
      context.signal.addEventListener(
        "abort",
        () => cancelRequest(current, requestId, "aborted"),
        { once: true },
      );
      if (isQuestion) {
        return emit({
          event: "question_request",
          generation: current.generation,
          request_id: requestId,
          tool_use_id: context.toolUseID,
          questions: input.questions ?? [],
        });
      }
      emit({
        event: "permission_request",
        generation: current.generation,
        request_id: requestId,
        tool_name: toolName,
        tool_use_id: context.toolUseID,
        input,
        title: context.title ?? null,
        display_name: context.displayName ?? null,
        description: context.description ?? null,
        decision_reason: context.decisionReason ?? null,
        blocked_path: context.blockedPath ?? null,
        agent_id: context.agentID ?? null,
        default_to_no: context.defaultToNo ?? false,
        can_remember: suggestions.length > 0,
      });
    });
  }

  function cancelRequest(
    current: SessionState,
    requestId: string,
    reason: "aborted" | "interrupted" | "session_ended",
  ) {
    const pending = current.requests.get(requestId);
    if (!pending) return;
    current.requests.delete(requestId);
    emit({
      event: "request_cancelled",
      generation: current.generation,
      request_id: requestId,
      reason,
    });
    // Fail closed: a cancelled request never becomes an approval.
    pending.resolve({
      behavior: "deny",
      message: "Request cancelled",
      ...(reason === "interrupted" && { interrupt: true }),
    });
  }

  function respond(
    current: Session,
    command: Extract<Command, { cmd: "respond" }>,
  ) {
    const pending = current.requests.get(command.request_id);
    if (!pending) {
      return reject(command.id, "stale_request", "request is not pending");
    }
    const decision = command.decision;
    if (
      pending.isQuestion
        ? decision.kind === "allow"
        : decision.kind === "answer"
    ) {
      return reject(
        command.id,
        "invalid_command",
        pending.isQuestion
          ? "a question takes an answer or a denial"
          : "a permission request takes allow or deny",
      );
    }
    current.requests.delete(command.request_id);
    switch (decision.kind) {
      case "allow":
        pending.resolve({
          behavior: "allow",
          updatedInput: pending.input,
          ...(decision.remember &&
            pending.suggestions.length > 0 && {
              updatedPermissions: pending.suggestions,
            }),
        });
        break;
      case "answer":
        pending.resolve({
          behavior: "allow",
          updatedInput: {
            questions: pending.input.questions,
            answers: decision.answers,
          },
        });
        break;
      case "deny":
        pending.resolve({
          behavior: "deny",
          message: decision.message ?? "The user denied this request",
        });
    }
    emit({
      event: "request_resolved",
      id: command.id,
      generation: current.generation,
      request_id: command.request_id,
      outcome: decision.kind,
    });
  }

  function interrupt(
    current: Session,
    command: Extract<Command, { cmd: "interrupt" }>,
  ) {
    // Stop wins over any answer still on its way from the host.
    for (const requestId of [...current.requests.keys()]) {
      cancelRequest(current, requestId, "interrupted");
    }
    current.query.interrupt().then(
      (receipt) =>
        emit({
          event: "interrupt_result",
          id: command.id,
          generation: current.generation,
          receipt: receipt !== undefined,
          still_queued_submission_ids: submissionIds(
            current,
            receipt?.still_queued,
          ),
        }),
      (error: unknown) =>
        emit({
          event: "sdk_error",
          generation: current.generation,
          source: "interrupt",
          error: errorInfo(error),
        }),
    );
  }

  const submissionIds = (current: Session, uuids: unknown) =>
    strings(uuids).flatMap(
      (uuid) => current.submissions.get(uuid)?.submissionId ?? [],
    );

  /** Reads SDK output independently of input and of pending human answers. */
  async function readOutput(current: Session) {
    try {
      for await (const message of current.query) {
        if (current.ended) return;
        try {
          translate(current, message);
        } catch (error) {
          deps.diagnostic(
            `could not translate an SDK message: ${String(error)}`,
          );
          unmapped(current, message);
        }
      }
      endSession(current, "output_ended", null);
    } catch (error) {
      endSession(current, "sdk_error", errorInfo(error));
    }
  }

  function endSession(
    current: Session,
    reason: "closed" | "output_ended" | "sdk_error",
    error: ErrorInfo | null,
  ) {
    if (current.ended) return;
    current.ended = true;
    for (const requestId of [...current.requests.keys()]) {
      cancelRequest(current, requestId, "session_ended");
    }
    current.wakeInput?.();
    try {
      current.query.close();
    } catch (cause) {
      deps.diagnostic(`closing the SDK query failed: ${String(cause)}`);
    }
    if (session === current) session = undefined;
    emit({
      event: "session_ended",
      generation: current.generation,
      reason,
      error,
      unresolved_inputs: [...current.submissions.values()].map((s) => ({
        submission_id: s.submissionId,
        evidence: s.evidence,
      })),
    });
  }

  function translate(current: Session, message: unknown) {
    if (!isObject(message)) return unmapped(current, message);
    const generation = current.generation;
    const parent = text(message.parent_tool_use_id);
    switch (message.type) {
      case "system":
        if (message.subtype !== "init") return unmapped(current, message);
        return emit({
          event: "session_info",
          generation,
          session_id: text(message.session_id),
          claude_code_version: text(message.claude_code_version),
          cwd: text(message.cwd),
          model: text(message.model),
          permission_mode: text(message.permissionMode),
          capabilities: strings(message.capabilities),
        });
      case "stream_event": {
        noteProcessing(current, message);
        const event = isObject(message.event) ? message.event : {};
        const delta = isObject(event.delta) ? event.delta : {};
        if (event.type !== "content_block_delta") return;
        const body =
          delta.type === "text_delta"
            ? ({ kind: "text", text: text(delta.text) } as const)
            : delta.type === "thinking_delta"
              ? ({ kind: "thinking", text: text(delta.thinking) } as const)
              : null;
        // Other stream events are framing; assistant_content is authoritative.
        if (!body || body.text === null) return;
        return emit({
          event: "delta",
          generation,
          kind: body.kind,
          text: body.text,
          index: number(event.index),
          parent_tool_use_id: parent,
        });
      }
      case "assistant": {
        noteProcessing(current, message);
        const inner = isObject(message.message) ? message.message : {};
        return emit({
          event: "assistant_content",
          generation,
          uuid: text(message.uuid),
          message_id: text(inner.id),
          parent_tool_use_id: parent,
          blocks: blocks(inner.content).map(contentBlock),
          error: text(message.error),
          aborted: message.aborted === true,
        });
      }
      case "user": {
        // Echoed and replayed user text is the host's own input; only tool
        // results carry new information.
        const inner = isObject(message.message) ? message.message : {};
        for (const block of blocks(inner.content)) {
          if (block.type !== "tool_result") continue;
          const full =
            text(block.content) ??
            blocks(block.content)
              .map(
                (part) =>
                  text(part.text) ?? `[${text(part.type) ?? "content"}]`,
              )
              .join("\n");
          emit({
            event: "tool_result",
            generation,
            tool_use_id: text(block.tool_use_id),
            parent_tool_use_id: parent,
            is_error: block.is_error === true,
            text: full.slice(-MAX_TOOL_RESULT_CHARS),
            truncated: full.length > MAX_TOOL_RESULT_CHARS,
          });
        }
        return;
      }
      case "result":
        return turnResult(current, message);
      default:
        return unmapped(current, message);
    }
  }

  const blocks = (content: unknown) =>
    Array.isArray(content) ? content.filter(isObject) : [];

  function contentBlock(block: Json): ContentBlock {
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      return { type: "thinking", text: block.thinking };
    }
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
    return { type: "other", block_type: text(block.type) };
  }

  /** Uuids of the user messages a frame says its turn has consumed. */
  const consumedUuids = (message: Json) =>
    Array.isArray(message.user_message_uuids)
      ? strings(message.user_message_uuids)
      : strings([message.user_message_uuid]);

  function noteProcessing(current: Session, message: Json) {
    const seen: string[] = [];
    for (const uuid of consumedUuids(message)) {
      const submission = current.submissions.get(uuid);
      if (!submission || submission.evidence === "processing") continue;
      submission.evidence = "processing";
      seen.push(submission.submissionId);
    }
    if (seen.length > 0) {
      emit({
        event: "input_processing",
        generation: current.generation,
        submission_ids: seen,
      });
    }
  }

  function turnResult(current: Session, message: Json) {
    const uuids = consumedUuids(message);
    const resolved: string[] = [];
    const unmatched: string[] = [];
    for (const uuid of uuids) {
      const submission = current.submissions.get(uuid);
      if (!submission) {
        unmatched.push(uuid);
        continue;
      }
      resolved.push(submission.submissionId);
      current.submissions.delete(uuid);
    }
    emit({
      event: "turn_result",
      generation: current.generation,
      // Without uuids the result cannot be bound to an input, so none is resolved.
      correlation: uuids.length > 0 ? "uuid" : "none",
      submission_ids: resolved,
      unmatched_uuids: unmatched,
      pending_submission_ids: [...current.submissions.values()].map(
        (s) => s.submissionId,
      ),
      subtype: text(message.subtype),
      is_error: message.is_error === true,
      result_text: text(message.result),
      errors: strings(message.errors),
      stop_reason: text(message.stop_reason),
      terminal_reason: text(message.terminal_reason),
      denied_tool_names: blocks(message.permission_denials).flatMap(
        (denial) => text(denial.tool_name) ?? [],
      ),
      queued_turn_count: number(message.queued_turn_count),
      num_turns: number(message.num_turns),
      duration_ms: number(message.duration_ms),
      session_id: text(message.session_id),
    });
  }

  function unmapped(current: Session, message: unknown) {
    const json = JSON.stringify(message) ?? "null";
    emit({
      event: "sdk_message_unmapped",
      generation: current.generation,
      sdk_type: isObject(message) ? text(message.type) : null,
      sdk_subtype: isObject(message) ? text(message.subtype) : null,
      json: json.slice(0, MAX_UNMAPPED_JSON_CHARS),
      truncated: json.length > MAX_UNMAPPED_JSON_CHARS,
    });
  }

  return {
    handleLine,
    /** The host closed stdin or is going away: release the SDK session. */
    shutdown() {
      if (session) endSession(session, "closed", null);
    },
  };
}
