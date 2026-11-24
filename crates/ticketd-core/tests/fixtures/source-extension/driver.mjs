import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as pause } from "node:timers/promises";

if (process.argv[2] === "descendant") {
  process.on("SIGTERM", () => {});
  const socket = createConnection(Number(process.argv[3]), "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write("ready");
  process.send?.("ready");
  // A broken test can keep this helper alive for at most six seconds.
  await pause(6_000);
  socket.end();
  process.exit(0);
}

const now = "2026-02-01T00:00:00Z";
const provider = "scripted";
const schema = {
  fields: [
    { key: "mode", label: "Mode", type: "text", required: true },
    { key: "port", label: "Fixture port", type: "text" },
    {
      key: "fixture_key",
      label: "Fixture key",
      type: "secret",
      show_if: "mode",
      pattern: {
        regex: "^(private-|mv3k2$)",
        message: "must start with private-",
      },
    },
  ],
};
const description = {
  provider,
  name: "Scripted source",
  contract_version: 2,
  capabilities: ["discover", "fetch", "publish", "comments"],
  schema,
  presentation: {},
};

function issue(id, title, category = "open", name = "Done", author = "octo") {
  return {
    reference: {
      identity: { provider, id },
      locator: "o/r#" + id,
      partition: "o/r",
    },
    display: "o/r#" + id,
    title,
    state: { category, name },
    url: "https://example.invalid/issues/" + id,
    body: "",
    assignees: [],
    labels: [],
    author,
    created_at: now,
    updated_at: now,
  };
}
const first = issue("1", "First issue");
const last = issue("2", "Issue after the empty page");
const moved = { ...first, title: "First issue after a move" };
const closure = {
  1: issue("1", "Issue state probe", "open", "Done"),
  2: issue("2", "Issue state probe", "completed", "Released"),
  3: issue("3", "Issue state probe", "unknown", "Closed"),
  4: issue("4", "Issue state probe", "unknown", "Completed"),
};
const problem = (kind, message, classification, detail) => ({
  error: {
    code: -32000,
    message,
    data: { code: kind, class: classification, message, detail },
  },
});
let reads = 0;

async function dispatch({ id, method, params }, signal) {
  if (method === "describe") {
    const accepts = params.contract_versions.includes(2);
    return {
      result: {
        contract_versions: [2],
        contract_version: accepts ? 2 : null,
        version: "0.0.1",
        description: accepts ? description : null,
      },
    };
  }
  if (
    typeof params.connection_id !== "string" ||
    params.connection_id.length === 0
  ) {
    return problem("protocol", "missing connection ID", "system");
  }
  const { mode, port, fixture_key: credential } = params.config;
  if (
    process.env.TICKETD_SOURCE_SCRIPTED_FIXTURE_KEY ||
    process.env.TICKETD_SOURCE_SCRIPTED_FIXTURE_KEY_COMMAND ||
    (typeof credential === "string" &&
      Object.values(process.env).includes(credential))
  ) {
    return problem(
      "protocol",
      "credential reached the process environment",
      "system",
    );
  }
  if (typeof credential === "string") {
    const middle = Math.floor(credential.length / 2);
    process.stderr.write(`fragment ${credential.slice(0, middle)}`);
    await pause(10);
    process.stderr.write(
      `${credential.slice(middle)}\nencoded ${Buffer.from(credential).toString("base64")}\n`,
    );
    if (mode === "secret_stdout") {
      process.stdout.write(
        `not RPC: ${credential} ${encodeURIComponent(credential)}\n`,
      );
      return null;
    }
    if (mode === "secret_error") {
      return problem(
        "unauthenticated",
        `tracker refused ${credential}`,
        "auth",
      );
    }
    if (mode === "safe_detail") {
      return problem(
        "protocol",
        "could not read the tracker",
        "system",
        "fixture_response_missing",
      );
    }
    if (mode === "private_detail") {
      return problem(
        "protocol",
        "could not read the tracker",
        "system",
        "Private ticket for someone@example.invalid",
      );
    }
    if (mode === "credential_detail") {
      return problem(
        "protocol",
        "could not read the tracker",
        "system",
        credential,
      );
    }
    if (mode === "secret_result") {
      return { result: { unexpected: credential } };
    }
    if (mode === "embedded_secret_result") {
      return { result: { title: `prefix${credential}suffix` } };
    }
  }
  if (mode === "broken") {
    process.stdout.write("not a protocol message\n");
    return null;
  }
  if (mode === "oversized") {
    process.stdout.write("x".repeat(4 * 1024 * 1024 + 1));
    await pause(6_000);
    return null;
  }
  if (mode === "hang") {
    await pause(6_000);
    return null;
  }
  if (mode === "crash") process.exit(42);
  if (mode === "orphan") {
    const child = spawn(
      process.execPath,
      [import.meta.filename, "descendant", port],
      {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      },
    );
    await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
    });
    process.exit(42);
  }
  switch (method) {
    case "check_connection":
      if (mode === "noisy") process.stderr.write("x".repeat(150_000));
      return {
        result: {
          connection: {
            account: ["session", "idle_noise"].includes(mode)
              ? `${params.connection_id}:${process.pid}`
              : mode === "credential_account" && credential !== "private-first"
                ? "another-account"
                : "octo",
            site: "fixture",
          },
          derived: {
            partitions: ["o/r"],
            discovery_scope: "",
            publication: { destinations: ["o/r"], case_insensitive: false },
          },
        },
      };
    case "validate":
    case "options":
      return { result: [] };
    case "discover": {
      if (["slow_progress", "cooperative", "ignore_cancel"].includes(mode)) {
        const repeats = mode === "slow_progress" ? 6 : 100;
        for (let completed = 1; completed <= repeats; completed += 1) {
          await pause(90, undefined, { signal });
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "progress",
              params: { id, completed, total: repeats },
            }) + "\n",
          );
        }
      }
      const pages = new Map([
        [null, [[first], "1"]],
        ["1", [[], "2"]],
        ["2", [[moved, last], null]],
      ]);
      const [issues, next_cursor] = pages.get(params.cursor) ?? [[], null];
      return { result: { issues, next_cursor, skipped: [] } };
    }
    case "fetch": {
      const id = params.reference.identity.id;
      const found =
        mode === "closure" ? closure[id] : id === "1" ? first : last;
      return found
        ? { result: found }
        : problem(
            id === "5" ? "not_found" : "forbidden",
            "issue unavailable",
            id === "5" ? "config" : "auth",
          );
    }
    case "conversation": {
      const comment = (id, body) => ({
        id,
        author: "alice",
        body,
        url: first.url,
        created_at: now,
        updated_at: now,
      });
      reads += 1;
      return {
        result: {
          comments: [
            comment("101", reads === 1 ? "original" : "edited"),
            comment("102", "second"),
          ],
          events: [],
        },
      };
    }
    case "publish":
      if (mode === "credential_account") {
        return credential === "private-first"
          ? { result: issue("33", params.request.title) }
          : problem(
              "forbidden",
              "credential belongs to another account",
              "auth",
            );
      }
      if (mode === "refuse") return problem("forbidden", "no access", "auth");
      if (mode === "not_sent")
        return problem("not_sent", "request was never sent", "transient");
      return problem("unavailable", "response lost", "transient");
    case "find_published":
      return {
        result:
          mode === "complete"
            ? {
                matches: [
                  issue("1", "Conformance publication"),
                  issue(
                    "2",
                    "Issue originally sent as Conformance publication",
                  ),
                ],
                recent: [issue("3", "Recent issue with different content")],
                complete: true,
              }
            : { matches: [], recent: [], complete: false },
      };
    default:
      return problem("unsupported", "method not implemented", "system");
  }
}

const pending = new Map();
async function handle(request, signal) {
  let message;
  try {
    message = await dispatch(request, signal);
  } catch (error) {
    if (!signal?.aborted) throw error;
    message = { error: { code: -32800, message: "Request canceled" } };
  }
  if (message) {
    const response =
      JSON.stringify({ jsonrpc: "2.0", id: request.id, ...message }) +
      (request.params.config?.mode === "idle_noise"
        ? "\nfixture idle output\n"
        : "\n");
    await new Promise((resolve) => process.stdout.write(response, resolve));
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.method === "cancel") {
    pending.get(request.params.id)?.abort();
    continue;
  }
  const mode = request.params.config?.mode;
  if (
    request.method === "discover" &&
    ["cooperative", "ignore_cancel"].includes(mode)
  ) {
    const controller = new AbortController();
    if (mode === "cooperative") pending.set(request.id, controller);
    void handle(request, controller.signal).finally(() =>
      pending.delete(request.id),
    );
    continue;
  }
  await handle(request);
  if (mode === "stop_reading") {
    lines.close();
    process.stdin.pause();
    await pause(6_000);
  }
}
for (const controller of pending.values()) controller.abort();
