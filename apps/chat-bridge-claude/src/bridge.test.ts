import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { createBridge, type QueryFn } from "./bridge";
import {
  SDK_CLAUDE_CODE_VERSION,
  SDK_VERSION,
  type BridgeEvent,
} from "./protocol";

const CWD = process.platform === "win32" ? "C:\\work" : "/work";
const CLAUDE =
  process.platform === "win32" ? "C:\\bin\\claude.exe" : "/bin/claude";

/** Lets queued promise callbacks and async-iterator steps run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** What the next query's `initializationResult()` lists as models. */
let initModels: unknown[] = [];
/** What the next query's `initializationResult()` lists as slash commands. */
let initCommands: unknown[] = [];

/** A scripted stand-in for one SDK `query()` handle. No process is started. */
class FakeQuery {
  readonly options: Options;
  closed = false;
  interrupts = 0;
  interruptReply: { still_queued: string[] } | undefined | Error = undefined;
  private readonly input: AsyncIterator<SDKUserMessage>;
  private readonly output: Array<IteratorResult<unknown> | Error> = [];
  private wake: (() => void) | undefined;

  constructor(prompt: AsyncIterable<SDKUserMessage>, options: Options) {
    this.options = options;
    this.input = prompt[Symbol.asyncIterator]();
  }

  /** The SDK's input reader taking the next message, as its transport would. */
  async readInput(): Promise<SDKUserMessage> {
    const next = await this.input.next();
    if (next.done) throw new Error("input stream ended");
    return next.value;
  }

  push(message: unknown) {
    this.output.push({ done: false, value: message });
    this.wake?.();
  }

  /** The Claude Code process exiting: the output iterator throws. */
  crash(error: Error) {
    this.output.push(error);
    this.wake?.();
  }

  askPermission(
    toolName: string,
    input: Record<string, unknown>,
    extra: Partial<Parameters<CanUseTool>[2]> = {},
  ) {
    const abort = new AbortController();
    const canUseTool = this.options.canUseTool;
    if (!canUseTool) throw new Error("bridge did not register canUseTool");
    let settled: PermissionResult | null | undefined;
    const result = canUseTool(toolName, input, {
      signal: abort.signal,
      toolUseID: "toolu_1",
      requestId: "native-1",
      ...extra,
    }).then((value) => (settled = value));
    return { abort, result, settled: () => settled };
  }

  async interrupt() {
    this.interrupts += 1;
    if (this.interruptReply instanceof Error) throw this.interruptReply;
    return this.interruptReply;
  }

  async initializationResult() {
    return {
      claude_code_version: "2.1.322",
      models: initModels,
      commands: initCommands,
      account: { subscriptionType: "max", tokenSource: "claude.ai" },
    };
  }

  settingsApplied: unknown[] = [];
  settingError: Error | undefined;
  contextUsage: unknown = undefined;

  async setModel(model?: string) {
    if (this.settingError) throw this.settingError;
    this.settingsApplied.push({ model });
  }

  async setPermissionMode(mode: string) {
    this.settingsApplied.push({ mode });
  }

  async applyFlagSettings(settings: Record<string, unknown>) {
    this.settingsApplied.push(settings);
  }

  async getContextUsage() {
    return this.contextUsage;
  }

  close() {
    this.closed = true;
    this.output.push({ done: true, value: undefined });
    this.wake?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async () => {
        while (this.output.length === 0) {
          await new Promise<void>((resolve) => (this.wake = resolve));
        }
        const next = this.output.shift();
        if (next instanceof Error) throw next;
        return next ?? { done: true, value: undefined };
      },
    };
  }
}

function harness() {
  const events: BridgeEvent[] = [];
  const queries: FakeQuery[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    const fake = new FakeQuery(prompt, options);
    queries.push(fake);
    return fake;
  };
  const bridge = createBridge({
    query,
    emit: (event) => events.push(event),
    diagnostic: () => {},
    readClaudeVersion: async () => "2.1.322 (Claude Code)",
  });
  let nextId = 0;
  const send = async (command: Record<string, unknown>) => {
    bridge.handleLine(JSON.stringify({ id: `c${++nextId}`, ...command }));
    await settle();
  };
  const open = async (generation = 1, extra: Record<string, unknown> = {}) => {
    await send({
      cmd: "open",
      generation,
      cwd: CWD,
      claude_executable: CLAUDE,
      ...extra,
    });
    const fake = queries.at(-1);
    if (!fake) throw new Error("open did not create a query");
    return fake;
  };
  const named = <E extends BridgeEvent["event"]>(name: E) =>
    events.filter(
      (event): event is Extract<BridgeEvent, { event: E }> =>
        event.event === name,
    );
  return { bridge, events, queries, send, open, named };
}

const submit = (
  submission_id: string,
  extra: Record<string, unknown> = {},
) => ({
  cmd: "submit",
  generation: 1,
  submission_id,
  text: `text of ${submission_id}`,
  ...extra,
});

const result = (uuids: string[] | undefined, extra: object = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  num_turns: 1,
  duration_ms: 5,
  stop_reason: "end_turn",
  session_id: "native-session",
  ...(uuids
    ? { user_message_uuid: uuids.at(-1), user_message_uuids: uuids }
    : {}),
  ...extra,
});

describe("hello and inspect", () => {
  it("pins the SDK versions it reports to the installed package", () => {
    const require = createRequire(import.meta.url);
    const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const installed = JSON.parse(
      readFileSync(join(dirname(sdkEntry), "package.json"), "utf8"),
    ) as { version: string; claudeCodeVersion: string };
    expect(SDK_VERSION).toBe(installed.version);
    expect(SDK_CLAUDE_CODE_VERSION).toBe(installed.claudeCodeVersion);
  });

  it("answers hello without creating a session", async () => {
    const h = harness();
    await h.send({ cmd: "hello", protocol: 1 });
    expect(h.events).toEqual([
      {
        v: 1,
        event: "hello",
        id: "c1",
        protocol: 1,
        sdk_version: "0.3.322",
        sdk_claude_code_version: "2.1.322",
      },
    ]);
    expect(h.queries).toHaveLength(0);
  });

  it("rejects a protocol version it does not speak", async () => {
    const h = harness();
    await h.send({ cmd: "hello", protocol: 2 });
    expect(h.events[0]).toMatchObject({
      event: "command_rejected",
      id: "c1",
      code: "unsupported_protocol",
    });
  });

  it("reports whether the installed Claude Code matches the SDK's version", async () => {
    const h = harness();
    await h.send({ cmd: "inspect", claude_executable: CLAUDE });
    expect(h.events[0]).toMatchObject({
      event: "inspection",
      claude_executable: CLAUDE,
      claude_version: "2.1.322",
      pairing: "matched",
      error: null,
    });
    expect(h.queries).toHaveLength(0);
  });
});

describe("options", () => {
  it("lists the models with a session that is never prompted, then closes it", async () => {
    const h = harness();
    initModels = [
      {
        value: "default",
        displayName: "Default",
        description: "Opus 5.5",
        supportedEffortLevels: ["low", "high"],
      },
    ];
    await h.send({ cmd: "options", claude_executable: CLAUDE });
    initModels = [];

    const [fake] = h.queries;
    expect(fake?.closed).toBe(true);
    expect(fake?.options).toMatchObject({
      pathToClaudeCodeExecutable: CLAUDE,
      persistSession: false,
      settings: { disableAllHooks: true },
    });
    expect(h.named("options")).toEqual([
      expect.objectContaining({
        error: null,
        account: expect.objectContaining({ subscription_type: "max" }),
        models: [
          expect.objectContaining({
            value: "default",
            effort_levels: ["low", "high"],
          }),
        ],
      }),
    ]);
    // Nothing was handed to the SDK as a message.
    expect(h.named("input_handed_to_sdk")).toHaveLength(0);
  });
});

describe("open", () => {
  it("opens a new session with New Chat's picks", async () => {
    const h = harness();
    const fake = await h.open(1, {
      model: "sonnet",
      effort: "high",
      permission_mode: "acceptEdits",
    });
    expect(fake.options).toMatchObject({
      model: "sonnet",
      effort: "high",
      permissionMode: "acceptEdits",
    });
  });

  it("starts the user's Claude Code with native settings and permissions intact", async () => {
    const h = harness();
    const fake = await h.open(1, { resume_session_id: "native-session" });
    expect(fake.options).toMatchObject({
      cwd: CWD,
      pathToClaudeCodeExecutable: CLAUDE,
      resume: "native-session",
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
    });
    // Left to Claude Code's own configuration, never overridden by the bridge.
    for (const untouched of [
      "permissionMode",
      "allowDangerouslySkipPermissions",
      "mcpServers",
      "strictMcpConfig",
      "hooks",
      "plugins",
      "skills",
      "tools",
      "allowedTools",
      "disallowedTools",
      "env",
    ]) {
      expect(fake.options).not.toHaveProperty(untouched);
    }
    expect(h.named("session_opened")).toHaveLength(1);
    expect(h.named("session_initialized")[0]).toMatchObject({
      generation: 1,
      claude_code_version: "2.1.322",
    });
  });

  it("refuses to bypass permissions", async () => {
    const h = harness();
    await h.send({
      cmd: "open",
      generation: 1,
      cwd: CWD,
      claude_executable: CLAUDE,
      permission_mode: "bypassPermissions",
    });
    expect(h.events[0]).toMatchObject({
      event: "command_rejected",
      code: "invalid_command",
    });
    expect(h.queries).toHaveLength(0);
  });

  it("runs an unattended session without asking and denies what is not allowed", async () => {
    const h = harness();
    const fake = await h.open(1, {
      unattended: {
        model: "claude-test",
        allowed_tools: ["Read", "Bash(ticketd:*)"],
        disallowed_tools: ["Edit", "Write"],
        max_turns: 40,
      },
    });
    expect(fake.options).toMatchObject({
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Bash(ticketd:*)"],
      disallowedTools: ["Edit", "Write"],
      maxTurns: 40,
      model: "claude-test",
    });
    expect(fake.options).not.toHaveProperty("allowDangerouslySkipPermissions");
    // None of the person's user, project or local settings are loaded, so an allow
    // rule there cannot widen what the agent may do.
    expect(fake.options.settingSources).toEqual([]);
    // L32: no MCP server, claude.ai connector or skill of the person's either.
    expect(fake.options).toMatchObject({
      mcpServers: {},
      strictMcpConfig: true,
      skills: [],
    });
    // L1: the environment is the bridge's own, with the ticketd CLI on PATH, since
    // the SDK replaces the environment when `env` is given.
    expect(fake.options.env).toEqual({
      ...process.env,
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    });

    // A request that still reaches the bridge is denied here, never sent to the host.
    const asked = fake.askPermission("Bash", { command: "rm -rf build" });
    await expect(asked.result).resolves.toMatchObject({ behavior: "deny" });
    expect(h.named("permission_request")).toHaveLength(0);
  });

  it("leaves the model to Claude Code when an unattended session names none", async () => {
    const h = harness();
    const fake = await h.open(1, {
      unattended: { allowed_tools: [], disallowed_tools: [], max_turns: 5 },
    });
    expect(fake.options).not.toHaveProperty("model");
    expect(fake.options.permissionMode).toBe("dontAsk");
  });

  it("requires the host to name the Claude Code executable", async () => {
    const h = harness();
    await h.send({ cmd: "open", generation: 1, cwd: CWD });
    expect(h.events[0]).toMatchObject({ event: "command_rejected" });
    expect(h.queries).toHaveLength(0);
  });
});

describe("input lifecycle", () => {
  it("reports only what was observed: handed to the SDK, processing, then the result", async () => {
    const h = harness();
    const fake = await h.open();
    await h.send(submit("s1"));
    // The SDK has not read its input yet, so there is no evidence to report.
    expect(h.named("input_handed_to_sdk")).toHaveLength(0);

    const written = await fake.readInput();
    await settle();
    expect(written).toMatchObject({
      type: "user",
      message: { role: "user", content: "text of s1" },
      parent_tool_use_id: null,
    });
    expect(written).not.toHaveProperty("priority");
    expect(h.named("input_handed_to_sdk")).toMatchObject([
      { generation: 1, submission_id: "s1" },
    ]);
    expect(h.named("input_processing")).toHaveLength(0);

    const uuid = written.uuid as string;
    fake.push({
      type: "stream_event",
      parent_tool_use_id: null,
      user_message_uuid: uuid,
      user_message_uuids: [uuid],
      event: { type: "message_start", message: { id: "msg_1" } },
    });
    fake.push({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hel" },
      },
    });
    fake.push({
      type: "assistant",
      uuid: "a-1",
      parent_tool_use_id: null,
      user_message_uuid: uuid,
      user_message_uuids: [uuid],
      message: {
        id: "msg_1",
        content: [
          { type: "text", text: "Hello" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "a" },
          },
        ],
      },
    });
    fake.push({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "file body" },
        ],
      },
    });
    fake.push(result([uuid]));
    await settle();

    expect(h.named("input_processing")).toMatchObject([
      { submission_ids: ["s1"] },
    ]);
    expect(h.named("delta")).toMatchObject([
      { kind: "text", text: "Hel", index: 0 },
    ]);
    expect(h.named("assistant_content")).toMatchObject([
      {
        message_id: "msg_1",
        blocks: [
          { type: "text", text: "Hello" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "a" },
          },
        ],
      },
    ]);
    expect(h.named("tool_result")).toMatchObject([
      {
        tool_use_id: "toolu_1",
        is_error: false,
        text: "file body",
        truncated: false,
      },
    ]);
    expect(h.named("turn_result")).toMatchObject([
      {
        generation: 1,
        correlation: "uuid",
        submission_ids: ["s1"],
        pending_submission_ids: [],
        subtype: "success",
        is_error: false,
        result_text: "done",
        session_id: "native-session",
      },
    ]);
    expect(h.events.map((event) => event.event)).not.toContain("accepted");
  });

  it("keeps one active turn unless the host explicitly sends into it", async () => {
    const h = harness();
    await h.open();
    await h.send(submit("s1"));
    await h.send(submit("s2"));
    expect(h.named("command_rejected")).toMatchObject([
      { code: "turn_active" },
    ]);
    await h.send(submit("s1", { allow_active_turn: true }));
    expect(h.named("command_rejected")[1]).toMatchObject({
      code: "duplicate_submission",
    });
  });

  it("binds one result to every input the turn merged", async () => {
    const h = harness();
    const fake = await h.open();
    await h.send(submit("s1"));
    await h.send(submit("s2", { allow_active_turn: true }));
    await h.send(submit("s3", { allow_active_turn: true }));
    const first = await fake.readInput();
    const second = await fake.readInput();
    fake.push(
      result([first.uuid as string, second.uuid as string, "not-ours"], {
        queued_turn_count: 1,
      }),
    );
    await settle();
    expect(h.named("turn_result")).toMatchObject([
      {
        correlation: "uuid",
        submission_ids: ["s1", "s2"],
        unmatched_uuids: ["not-ours"],
        pending_submission_ids: ["s3"],
        queued_turn_count: 1,
      },
    ]);
    // s3 is still unresolved, so the turn is still active for the host.
    await h.send(submit("s4"));
    expect(h.named("command_rejected")).toMatchObject([
      { code: "turn_active" },
    ]);
  });

  it("does not guess which input an uncorrelated result answers", async () => {
    const h = harness();
    const fake = await h.open();
    await h.send(submit("s1"));
    await fake.readInput();
    fake.push(
      result(undefined, {
        subtype: "error_during_execution",
        is_error: true,
        errors: ["boom"],
        result: undefined,
      }),
    );
    await settle();
    expect(h.named("turn_result")).toMatchObject([
      {
        correlation: "none",
        submission_ids: [],
        pending_submission_ids: ["s1"],
        subtype: "error_during_execution",
        is_error: true,
        errors: ["boom"],
      },
    ]);
  });

  it("names the command of each shell tool Claude Code denied", async () => {
    const h = harness();
    const fake = await h.open();
    await h.send(submit("s1"));
    const written = await fake.readInput();
    fake.push(
      result([written.uuid as string], {
        permission_denials: [
          {
            tool_name: "PowerShell",
            tool_use_id: "toolu_1",
            tool_input: { command: "node test.js" },
          },
          {
            tool_name: "Write",
            tool_use_id: "toolu_2",
            tool_input: { file_path: "a.txt" },
          },
        ],
      }),
    );
    await settle();
    expect(h.named("turn_result")).toMatchObject([
      {
        denials: [
          { tool_name: "PowerShell", command: "node test.js" },
          { tool_name: "Write", command: null },
        ],
      },
    ]);
  });
});

describe("permissions and questions", () => {
  it("keeps reading output while a permission answer is pending, then returns the answer", async () => {
    const h = harness();
    const fake = await h.open();
    const ask = fake.askPermission(
      "Bash",
      { command: "ls" },
      {
        title: "Claude wants to run ls",
        suggestions: [
          { type: "setMode", mode: "acceptEdits", destination: "session" },
        ],
      },
    );
    await settle();
    const [request] = h.named("permission_request");
    expect(request).toMatchObject({
      generation: 1,
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      input: { command: "ls" },
      title: "Claude wants to run ls",
      can_remember: true,
    });

    fake.push({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "thinking_delta", thinking: "hm" },
      },
    });
    await settle();
    expect(h.named("delta")).toMatchObject([{ kind: "thinking", text: "hm" }]);
    expect(ask.settled()).toBeUndefined();

    await h.send({
      cmd: "respond",
      generation: 1,
      request_id: request?.request_id,
      decision: { kind: "allow", remember: true },
    });
    expect(await ask.result).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
      updatedPermissions: [
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
    });
    expect(h.named("request_resolved")).toMatchObject([
      { request_id: request?.request_id, outcome: "allow" },
    ]);
  });

  it("returns a denial with the user's message", async () => {
    const h = harness();
    const fake = await h.open();
    const ask = fake.askPermission("Write", { file_path: "a" });
    await settle();
    await h.send({
      cmd: "respond",
      generation: 1,
      request_id: h.named("permission_request")[0]?.request_id,
      decision: { kind: "deny", message: "not that file" },
    });
    expect(await ask.result).toEqual({
      behavior: "deny",
      message: "not that file",
    });
  });

  it("carries a native question to the host and the answers back", async () => {
    const h = harness();
    const fake = await h.open();
    const questions = [
      {
        question: "Which format?",
        header: "Format",
        options: [
          { label: "Summary", description: "Brief" },
          { label: "Detailed", description: "Full" },
        ],
        multiSelect: false,
      },
    ];
    const ask = fake.askPermission("AskUserQuestion", { questions });
    await settle();
    expect(h.named("permission_request")).toHaveLength(0);
    const [request] = h.named("question_request");
    expect(request).toMatchObject({ generation: 1, questions });

    // A question cannot be answered as if it were a tool approval.
    await h.send({
      cmd: "respond",
      generation: 1,
      request_id: request?.request_id,
      decision: { kind: "allow" },
    });
    expect(h.named("command_rejected")).toMatchObject([
      { code: "invalid_command" },
    ]);

    await h.send({
      cmd: "respond",
      generation: 1,
      request_id: request?.request_id,
      decision: { kind: "answer", answers: { "Which format?": "Summary" } },
    });
    expect(await ask.result).toEqual({
      behavior: "allow",
      updatedInput: { questions, answers: { "Which format?": "Summary" } },
    });
  });

  it("invalidates an answer once the SDK cancels the request", async () => {
    const h = harness();
    const fake = await h.open();
    const ask = fake.askPermission("Bash", { command: "ls" });
    await settle();
    const requestId = h.named("permission_request")[0]?.request_id;
    ask.abort.abort();
    await settle();
    expect(h.named("request_cancelled")).toMatchObject([
      { request_id: requestId, reason: "aborted" },
    ]);
    expect(await ask.result).toMatchObject({ behavior: "deny" });

    await h.send({
      cmd: "respond",
      generation: 1,
      request_id: requestId,
      decision: { kind: "allow" },
    });
    expect(h.named("command_rejected")).toMatchObject([
      { code: "stale_request" },
    ]);
    expect(h.named("request_resolved")).toHaveLength(0);
  });

  it("lets Stop win a race with a late approval", async () => {
    const h = harness();
    const fake = await h.open();
    await h.send(submit("s1"));
    const written = await fake.readInput();
    const ask = fake.askPermission("Bash", { command: "rm -rf build" });
    await settle();
    const requestId = h.named("permission_request")[0]?.request_id;
    fake.interruptReply = {
      still_queued: [written.uuid as string, "cron-uuid"],
    };

    // Both lines arrive before the bridge yields: interrupt first, approval second.
    h.bridge.handleLine(
      JSON.stringify({ id: "stop", cmd: "interrupt", generation: 1 }),
    );
    h.bridge.handleLine(
      JSON.stringify({
        id: "late",
        cmd: "respond",
        generation: 1,
        request_id: requestId,
        decision: { kind: "allow" },
      }),
    );
    await settle();

    expect(fake.interrupts).toBe(1);
    expect(await ask.result).toMatchObject({
      behavior: "deny",
      interrupt: true,
    });
    expect(h.named("request_cancelled")).toMatchObject([
      { request_id: requestId, reason: "interrupted" },
    ]);
    expect(h.named("command_rejected")).toMatchObject([
      { id: "late", code: "stale_request" },
    ]);
    // The receipt acknowledges the interrupt; it is not the turn's terminal result.
    expect(h.named("interrupt_result")).toMatchObject([
      { id: "stop", receipt: true, still_queued_submission_ids: ["s1"] },
    ]);
    expect(h.named("turn_result")).toHaveLength(0);
  });

  it("reports an interrupt the SDK failed to deliver as a thrown failure", async () => {
    const h = harness();
    const fake = await h.open();
    fake.interruptReply = new Error("transport closed");
    await h.send({ cmd: "interrupt", generation: 1 });
    expect(h.named("sdk_error")).toMatchObject([
      {
        generation: 1,
        source: "interrupt",
        error: { message: "transport closed" },
      },
    ]);
  });
});

describe("generations", () => {
  it("rejects commands and answers addressed to another generation", async () => {
    const h = harness();
    const first = await h.open(1);
    const ask = first.askPermission("Bash", { command: "ls" });
    await settle();
    const staleRequest = h.named("permission_request")[0]?.request_id;

    await h.send({
      cmd: "open",
      generation: 2,
      cwd: CWD,
      claude_executable: CLAUDE,
    });
    expect(h.named("command_rejected")).toMatchObject([
      { code: "session_exists" },
    ]);

    await h.send({ cmd: "close", generation: 1 });
    expect(first.closed).toBe(true);
    expect(await ask.result).toMatchObject({ behavior: "deny" });
    expect(h.named("session_ended")).toMatchObject([
      { generation: 1, reason: "closed" },
    ]);

    await h.send({
      cmd: "open",
      generation: 1,
      cwd: CWD,
      claude_executable: CLAUDE,
    });
    expect(h.named("command_rejected")[1]).toMatchObject({
      code: "stale_generation",
    });

    await h.open(2);
    await h.send({
      cmd: "respond",
      generation: 1,
      request_id: staleRequest,
      decision: { kind: "allow" },
    });
    await h.send({
      cmd: "respond",
      generation: 2,
      request_id: staleRequest,
      decision: { kind: "allow" },
    });
    await h.send(submit("s1"));
    expect(h.named("command_rejected").slice(2)).toMatchObject([
      { code: "stale_generation" },
      { code: "stale_request" },
      { code: "stale_generation" },
    ]);
    expect(h.named("session_ended")).toHaveLength(1);
  });
});

describe("process loss and unknown frames", () => {
  it("reports each unfinished input with the last evidence seen when Claude Code is lost", async () => {
    const h = harness();
    const fake = await h.open();
    await h.send(submit("s1"));
    await h.send(submit("s2", { allow_active_turn: true }));
    await h.send(submit("s3", { allow_active_turn: true }));
    const first = await fake.readInput();
    await fake.readInput();
    fake.push({
      type: "assistant",
      uuid: "a-1",
      parent_tool_use_id: null,
      user_message_uuid: first.uuid,
      message: { id: "msg_1", content: [] },
    });
    const ask = fake.askPermission("Bash", { command: "ls" });
    await settle();

    fake.crash(new Error("Claude Code process exited with code 1"));
    await settle();

    expect(h.named("session_ended")).toMatchObject([
      {
        generation: 1,
        reason: "sdk_error",
        error: {
          name: "Error",
          message: "Claude Code process exited with code 1",
        },
        unresolved_inputs: [
          { submission_id: "s1", evidence: "processing" },
          { submission_id: "s2", evidence: "handed_to_sdk" },
          { submission_id: "s3", evidence: "none" },
        ],
      },
    ]);
    expect(h.named("request_cancelled")).toMatchObject([
      { reason: "session_ended" },
    ]);
    expect(await ask.result).toMatchObject({ behavior: "deny" });
    expect(fake.closed).toBe(true);

    // The lost generation is gone; a later one was never opened.
    await h.send(submit("s4"));
    await h.send({ cmd: "interrupt", generation: 2 });
    expect(h.named("command_rejected")).toMatchObject([
      { code: "stale_generation" },
      { code: "no_session" },
    ]);
  });

  it("reports the output stream ending without a close as a loss, not a clean close", async () => {
    const h = harness();
    const fake = await h.open();
    fake.close();
    await settle();
    expect(h.named("session_ended")).toMatchObject([
      { reason: "output_ended", error: null, unresolved_inputs: [] },
    ]);
  });

  it("forwards frames it does not map as a bounded fallback and keeps going", async () => {
    const h = harness();
    const fake = await h.open();
    fake.push({ type: "from_the_future", payload: "x".repeat(50_000) });
    fake.push("not even an object");
    fake.push({ type: "system", subtype: "status", status: "compacting" });
    fake.push({
      type: "system",
      subtype: "init",
      session_id: "native-session",
      claude_code_version: "2.1.322",
      cwd: CWD,
      model: "claude-test",
      permissionMode: "default",
      capabilities: ["interrupt_receipt_v1"],
    });
    await settle();
    const unmapped = h.named("sdk_message_unmapped");
    expect(unmapped).toMatchObject([
      { sdk_type: "from_the_future", sdk_subtype: null, truncated: true },
      { sdk_type: null, truncated: false, json: '"not even an object"' },
      { sdk_type: "system", sdk_subtype: "status", truncated: false },
    ]);
    expect(unmapped[0]?.json.length).toBe(4096);
    expect(h.named("session_info")).toMatchObject([
      {
        session_id: "native-session",
        claude_code_version: "2.1.322",
        permission_mode: "default",
        capabilities: ["interrupt_receipt_v1"],
      },
    ]);
    expect(h.named("session_ended")).toHaveLength(0);
  });

  it("marks a tool result it had to shorten", async () => {
    const h = harness();
    const fake = await h.open();
    fake.push({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_9",
            is_error: true,
            content: [
              { type: "text", text: `head${"y".repeat(1_048_576)}tail` },
            ],
          },
        ],
      },
    });
    await settle();
    const [toolResult] = h.named("tool_result");
    expect(toolResult).toMatchObject({
      tool_use_id: "toolu_9",
      is_error: true,
      truncated: true,
    });
    // The end is kept, as the host and the transcript say.
    expect(toolResult?.text.length).toBe(1_048_576);
    expect(toolResult?.text.startsWith("yyyy")).toBe(true);
    expect(toolResult?.text.endsWith("ytail")).toBe(true);
  });

  it("rejects lines that are not commands without stopping", async () => {
    const h = harness();
    h.bridge.handleLine("{nope");
    await h.send({ cmd: "dance" });
    await h.send({ cmd: "hello", protocol: 1 });
    expect(h.events.map((event) => event.event)).toEqual([
      "command_rejected",
      "command_rejected",
      "hello",
    ]);
    expect(h.events[0]).toMatchObject({ id: null, code: "invalid_json" });
    expect(h.events[1]).toMatchObject({ id: "c1", code: "invalid_command" });
  });
});

describe("reasoning, files, context and settings", () => {
  it("says when a thinking block starts and stops, redacted ones included", async () => {
    const h = harness();
    const fake = await h.open();
    const stream = (event: object) =>
      fake.push({ type: "stream_event", parent_tool_use_id: null, event });
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    });
    stream({ type: "content_block_stop", index: 0 });
    stream({
      type: "content_block_start",
      index: 1,
      content_block: { type: "redacted_thinking", data: "x" },
    });
    // A text block's stop is framing, not thinking.
    stream({
      type: "content_block_start",
      index: 2,
      content_block: { type: "text", text: "" },
    });
    stream({ type: "content_block_stop", index: 2 });
    await settle();
    expect(
      h.named("thinking").map(({ phase, index, redacted }) => ({
        phase,
        index,
        redacted,
      })),
    ).toEqual([
      { phase: "started", index: 0, redacted: false },
      { phase: "stopped", index: 0, redacted: false },
      { phase: "started", index: 1, redacted: true },
    ]);
  });

  it("forwards what an edit's structured result reports, and nothing for other tools", async () => {
    const h = harness();
    const fake = await h.open();
    const toolResult = (tool_use_result: unknown) =>
      fake.push({
        type: "user",
        parent_tool_use_id: null,
        tool_use_result,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }],
        },
      });
    toolResult({
      filePath: "/work/a.ts",
      oldString: "a",
      newString: "b",
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: ["-a", "+b", "+c", " d"],
        },
      ],
    });
    toolResult({
      type: "create",
      filePath: "/work/new.ts",
      content: "one\ntwo\n",
      structuredPatch: [],
      originalFile: null,
    });
    toolResult({ task: { id: "1", subject: "Write tests" } });
    toolResult({ file: { filePath: "/work/read.ts", content: "x" } });
    await settle();
    expect(h.named("tool_result").map((event) => event.outcome)).toEqual([
      {
        kind: "file",
        path: "/work/a.ts",
        change: null,
        added_lines: 2,
        removed_lines: 1,
      },
      {
        kind: "file",
        path: "/work/new.ts",
        change: "create",
        added_lines: 2,
        removed_lines: 0,
      },
      { kind: "task_created", task_id: "1", subject: "Write tests" },
      null,
    ]);
  });

  it("reports the slash commands Claude Code lists at start", async () => {
    initCommands = [
      {
        name: "review",
        description: "Review a pull request",
        argumentHint: "",
      },
      { name: "", description: "nameless" },
      { name: "compact", description: "" },
    ];
    const h = harness();
    await h.open();
    initCommands = [];
    expect(h.named("session_initialized")[0]?.commands).toEqual([
      { name: "review", description: "Review a pull request" },
      { name: "compact", description: null },
    ]);
  });

  it("reports the models at start and the context Claude Code counts after a turn", async () => {
    initModels = [
      {
        value: "default",
        resolvedModel: "claude-opus-test",
        displayName: "Default",
        description: "Recommended",
        supportedEffortLevels: ["low", "high"],
      },
      {
        value: "haiku",
        displayName: "Haiku",
        description: "",
        supportsEffort: false,
      },
    ];
    const h = harness();
    const fake = await h.open();
    initModels = [];
    expect(h.named("session_initialized")[0]?.models).toEqual([
      {
        value: "default",
        resolved_model: "claude-opus-test",
        display_name: "Default",
        description: "Recommended",
        effort_levels: ["low", "high"],
      },
      {
        value: "haiku",
        resolved_model: null,
        display_name: "Haiku",
        description: "",
        effort_levels: [],
      },
    ]);
    fake.contextUsage = {
      totalTokens: 124_000,
      maxTokens: 200_000,
      isAutoCompactEnabled: true,
      autoCompactThreshold: 167_000,
      categories: [
        { name: "Messages", tokens: 100_000, kind: "used", color: "" },
        { name: "Free space", tokens: 76_000, kind: "free", color: "" },
        { name: "Empty", tokens: 0, kind: "used", color: "" },
      ],
    };
    fake.push(result(undefined));
    fake.push({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 1 },
    });
    await settle();
    expect(h.named("context_usage")[0]).toMatchObject({
      total_tokens: 124_000,
      max_tokens: 200_000,
      categories: [{ name: "Messages", tokens: 100_000 }],
      compacts_at: 167_000,
    });
    expect(h.named("compacted")).toHaveLength(1);
  });

  it("changes a setting through the SDK and never takes bypassPermissions", async () => {
    const h = harness();
    const fake = await h.open();
    const set = (setting: object) =>
      h.send({ cmd: "set_setting", generation: 1, setting });
    await set({ kind: "model", value: "opus" });
    await set({ kind: "effort", value: "high" });
    await set({ kind: "permission", value: "acceptEdits" });
    await set({ kind: "permission", value: "bypassPermissions" });
    fake.settingError = new Error("unknown model");
    await set({ kind: "model", value: "nope" });
    expect(fake.settingsApplied).toEqual([
      { model: "opus" },
      { effortLevel: "high" },
      { mode: "acceptEdits" },
    ]);
    expect(
      h.events
        .filter(
          (event) =>
            event.event === "setting_result" ||
            event.event === "command_rejected",
        )
        .map((event) => ("outcome" in event ? event.outcome : event.event)),
    ).toEqual(["applied", "applied", "applied", "command_rejected", "refused"]);
    expect(h.named("setting_result").at(-1)?.message).toBe("unknown model");
  });
});
