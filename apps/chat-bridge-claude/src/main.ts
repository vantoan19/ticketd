// Process entry: stdin carries commands, stdout carries protocol events only,
// stderr carries bounded diagnostics. The host owns this process's lifetime.

import { execFile } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createBridge } from "./bridge";

/** Characters written to stderr for one diagnostic. */
const MAX_DIAGNOSTIC_CHARS = 8192;
const VERSION_TIMEOUT_MS = 10_000;

const diagnostic = (text: string) =>
  process.stderr.write(`${text.slice(0, MAX_DIAGNOSTIC_CHARS).trimEnd()}\n`);

/** stdout refused more until it drains: the host is behind. */
let full = false;

const bridge = createBridge({
  query,
  emit: (event) => {
    if (!process.stdout.write(`${JSON.stringify(event)}\n`)) full = true;
  },
  writable: async () => {
    if (!full) return;
    await once(process.stdout, "drain");
    full = false;
  },
  diagnostic,
  readClaudeVersion: async (executable) =>
    (
      await promisify(execFile)(executable, ["--version"], {
        timeout: VERSION_TIMEOUT_MS,
        windowsHide: true,
      })
    ).stdout,
});

process.on("unhandledRejection", (reason) =>
  diagnostic(`unhandled rejection: ${String(reason)}`),
);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => bridge.handleLine(line));
// Stdin closing means the host is gone: release Claude Code, flush, and exit.
lines.on("close", () => {
  bridge.shutdown();
  process.stdout.write("", () => process.exit(0));
});
