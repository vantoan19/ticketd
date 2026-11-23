import { createInterface } from "node:readline";
import { setTimeout as pause } from "node:timers/promises";

const provider = "example-tracker";
const versions = [2];
const now = "2026-01-01T00:00:00Z";
const description = {
  provider,
  name: "Example Tracker",
  contract_version: 2,
  capabilities: ["discover", "fetch", "comments"],
  schema: {
    fields: [
      {
        key: "board",
        label: "Board",
        type: "text",
        required: true,
        placeholder: "Demo",
      },
      {
        key: "labels",
        label: "Labels",
        type: "multi_select",
        max_items: 5,
        options: { source: "dynamic", depends_on: ["board"] },
      },
    ],
  },
  presentation: {
    icon_svg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 3h14v18H5z m3 9 3 3 5-6" fill="none" stroke="black" stroke-width="2"/></svg>',
    issue_name: { separator: "-", separator_in_number: true },
    discovery_note: "Explore the local sample board.",
    target: {
      field: "board",
      label: "Board",
      example: "Demo",
      choose: "Choose a board",
      add: "Enter a board",
    },
  },
};

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : {};

function issue(board: string, number: number) {
  const display = `${board}-${number}`;
  return {
    reference: {
      identity: { provider, id: `${board}:${number}` },
      locator: display,
      partition: board,
    },
    display,
    url: `https://example.invalid/boards/${board}/tickets/${number}`,
    title:
      number === 1 ? "Write the release notes" : "Archive last month's board",
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

class TrackerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function dispatch(
  method: unknown,
  params: RecordValue,
  signal: AbortSignal,
  progress: (completed: number, total: number) => void,
): Promise<unknown> {
  if (method === "describe") {
    const offered = params.contract_versions;
    const accepted = Array.isArray(offered) && offered.includes(2);
    return {
      contract_versions: versions,
      contract_version: accepted ? 2 : null,
      version: "0.1.0",
      description: accepted ? description : null,
    };
  }

  if (
    typeof params.connection_id !== "string" ||
    params.connection_id.length === 0
  ) {
    throw new Error("A connection ID is required");
  }
  const config = object(params.config);
  const board = config.board;
  const validBoard = board === "Demo" || board === "Sandbox";
  if (method === "validate") {
    return validBoard
      ? []
      : [{ field: "board", message: "Choose Demo or Sandbox." }];
  }
  if (method === "options") {
    if (params.field !== "labels")
      throw new TrackerError("invalid_configuration", "Unknown option field.");
    const query = typeof params.query === "string" ? params.query : "";
    return ["docs", "planning"]
      .filter((label) => label.includes(query))
      .map((label) => ({ label, value: label }));
  }
  if (!validBoard)
    throw new TrackerError("invalid_configuration", "Choose Demo or Sandbox.");

  if (method === "check_connection") {
    return {
      connection: { account: "demo", site: board },
      derived: {
        partitions: [board],
        discovery_scope: "",
        publication: { destinations: [], case_insensitive: false },
      },
    };
  }
  if (method === "discover") {
    const pages = new Map<unknown, [number[], string | null]>([
      [null, [[1], "middle"]],
      ["middle", [[], "last"]],
      ["last", [[2], null]],
    ]);
    const [numbers, next_cursor] = pages.get(params.cursor) ?? [[], null];
    progress(0, numbers.length);
    // Stand in for an abortable tracker read while the stdin loop handles cancel.
    await pause(30, undefined, { signal });
    const issues = numbers.map((number, index) => {
      signal.throwIfAborted();
      progress(index + 1, numbers.length);
      return issue(board, number);
    });
    return { issues, next_cursor, skipped: [] };
  }

  const reference = object(params.reference);
  const identity = object(reference.identity);
  const found = [issue(board, 1), issue(board, 2)].find(
    (ticket) =>
      identity.provider === provider &&
      ticket.reference.identity.id === identity.id,
  );
  if (!found)
    throw new TrackerError("not_found", "That example ticket does not exist.");
  if (method === "fetch") return found;
  if (method === "conversation") {
    return {
      comments: [
        {
          id: "comment-1",
          author: "demo",
          body: "This came from the example tracker.",
          url: `${found.url}#comment-1`,
          created_at: now,
          updated_at: now,
        },
      ],
      events: [],
    };
  }
  throw new Error("Unknown method");
}

function send(message: RecordValue) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

async function serve(
  id: number,
  method: unknown,
  params: RecordValue,
  signal: AbortSignal,
) {
  let reply: RecordValue;
  try {
    const result = await dispatch(
      method,
      params,
      signal,
      (completed, total) => {
        send({ method: "progress", params: { id, completed, total } });
      },
    );
    signal.throwIfAborted();
    reply = { result };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The tracker failed.";
    reply = signal.aborted
      ? { error: { code: -32800, message: "Request canceled" } }
      : error instanceof TrackerError
        ? {
            error: {
              code: -32000,
              message,
              data: {
                class: "config",
                code: error.code,
                message,
              },
            },
          }
        : { error: { code: -32603, message } };
  }
  send({ id, ...reply });
}

const running = new Map<number, AbortController>();
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  const request = object(JSON.parse(line));
  const { id, method } = request;
  const params = object(request.params);
  if (request.jsonrpc !== "2.0") continue;
  if (method === "cancel" && typeof params.id === "number") {
    running.get(params.id)?.abort();
  } else if (typeof id === "number") {
    const controller = new AbortController();
    running.set(id, controller);
    void serve(id, method, params, controller.signal).finally(() => {
      running.delete(id);
    });
  }
}
for (const controller of running.values()) controller.abort();
