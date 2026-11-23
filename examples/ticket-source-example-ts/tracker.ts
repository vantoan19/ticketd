import { createInterface } from "node:readline";
import { setTimeout as pause } from "node:timers/promises";

const provider = "example-tracker";
const now = "2026-01-01T00:00:00Z";
const boardHelp = "Choose Demo, Sandbox or Sign-in.";
const description = {
  provider,
  name: "Example Tracker",
  contract_version: 2,
  capabilities: ["discover", "fetch", "comments"],
  schema: {
    fields: [
      { key: "board", label: "Board", type: "text", required: true },
      {
        key: "labels",
        label: "Labels",
        type: "multi_select",
        max_items: 5,
        options: { source: "dynamic", depends_on: ["board"] },
      },
      { key: "api_key", label: "API key", type: "secret" },
    ],
  },
  presentation: {
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 3h14v18H5z m3 9 3 3 5-6" fill="none" stroke="black" stroke-width="2"/></svg>',
    issue_name: { separator: "-", separator_in_number: true },
    discovery_note: "Explore the local sample board or try Sign-in with a key.",
    target: {
      field: "board",
      label: "Board",
      example: "Demo",
      choose: "Choose a board",
      add: "Enter a board",
    },
  },
};

type ObjectValue = Record<string, unknown>;
type Request = { id: number; method: string; params: ObjectValue };

const object = (value: unknown): ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};

function issue(board: string, number: number) {
  const exampleTitle =
    number === 1 ? "Write the release notes" : "Archive last month's board";
  const display = `${board}-${number}`;
  return {
    reference: {
      identity: { provider, id: `${board}:${number}` },
      locator: display,
      partition: board,
    },
    display,
    url: `https://example.invalid/boards/${board}/tickets/${number}`,
    title: exampleTitle,
    body: "A ticket from the local example tracker.",
    state:
      number === 1
        ? { category: "open", name: "In progress" }
        : { category: "unknown", name: "Archived" },
    assignees: ["demo"],
    labels: ["docs"],
    created_at: now,
    updated_at: now,
  };
}

function failure(code: string, message: string) {
  const errorClass = code === "unauthenticated" ? "auth" : "config";
  const data = { class: errorClass, code, message };
  return { error: { code: -32000, message, data } };
}

const pages = new Map<unknown, [number[], string | null]>([
  [null, [[1], "middle"]],
  ["middle", [[], "last"]],
  ["last", [[2], null]],
]);

async function dispatch({ id, method, params }: Request, signal: AbortSignal) {
  if (method === "describe") {
    const offered = params.contract_versions;
    const accepted = Array.isArray(offered) && offered.includes(2);
    const version = "0.1.0";
    const contract_version = accepted ? 2 : null;
    const reply = { contract_versions: [2], contract_version, version };
    return { result: { ...reply, description: accepted ? description : null } };
  }
  if (typeof params.connection_id !== "string" || !params.connection_id)
    return { error: { code: -32602, message: "A connection ID is required" } };

  const config = object(params.config);
  const board = config.board;
  const validBoard =
    board === "Demo" || board === "Sandbox" || board === "Sign-in";
  if (method === "validate")
    return {
      result: validBoard ? [] : [{ field: "board", message: boardHelp }],
    };
  if (method === "options") {
    if (params.field !== "labels")
      return failure("invalid_configuration", "Unknown option field.");
    const query = typeof params.query === "string" ? params.query : "";
    const labels = ["docs", "planning"].filter((label) =>
      label.includes(query),
    );
    return { result: labels.map((label) => ({ label, value: label })) };
  }
  if (!validBoard) return failure("invalid_configuration", boardHelp);
  const key = config.api_key;
  if (board === "Sign-in" && (typeof key !== "string" || !key.trim()))
    return failure("unauthenticated", "The Sign-in board needs an API key.");

  if (method === "check_connection") {
    const connection = { account: "demo", site: board };
    const publication = { destinations: [], case_insensitive: false };
    const derived = { partitions: [board], discovery_scope: "", publication };
    return { result: { connection, derived } };
  }
  if (method === "discover") {
    const [numbers, next_cursor] = pages.get(params.cursor) ?? [[], null];
    const total = numbers.length;
    const progress = (completed: number) =>
      send({ method: "progress", params: { id, completed, total } });
    progress(0);
    // Simulate an abortable read so cancellation can arrive before discovery ends.
    await pause(100, undefined, { signal });
    const issues = numbers.map((number) => issue(board, number));
    progress(issues.length);
    return { result: { issues, next_cursor, skipped: [] } };
  }

  const identity = object(object(params.reference).identity);
  const tickets = [issue(board, 1), issue(board, 2)];
  const found = tickets.find(
    (ticket) => ticket.reference.identity.id === identity.id,
  );
  if (!found || identity.provider !== provider)
    return failure("not_found", "That example ticket does not exist.");
  if (method === "fetch") return { result: found };
  if (method === "conversation") {
    const comment = {
      id: "comment-1",
      author: "demo",
      body: "This came from the example tracker.",
      url: `${found.url}#comment-1`,
      created_at: now,
      updated_at: now,
    };
    return { result: { comments: [comment], events: [] } };
  }
  return { error: { code: -32601, message: "Unknown method" } };
}

function send(message: ObjectValue) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

async function serve(request: Request, signal: AbortSignal) {
  const { id } = request;
  try {
    const reply = await dispatch(request, signal);
    signal.throwIfAborted();
    send({ id, ...reply });
  } catch {
    const error = signal.aborted
      ? { code: -32800, message: "Request canceled" }
      : { code: -32603, message: "The tracker failed" };
    send({ id, error });
  }
}

const running = new Map<number, AbortController>();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const message = object(JSON.parse(line));
  const { id, method } = message;
  const params = object(message.params);
  if (message.jsonrpc !== "2.0") continue;
  if (method === "cancel" && typeof params.id === "number") {
    running.get(params.id)?.abort();
  } else if (typeof id === "number" && typeof method === "string") {
    const controller = new AbortController();
    running.set(id, controller);
    void serve({ id, method, params }, controller.signal).finally(() => {
      running.delete(id);
    });
  }
}
for (const controller of running.values()) controller.abort();
