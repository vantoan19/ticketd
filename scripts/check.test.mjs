import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const check = path.join(path.dirname(fileURLToPath(import.meta.url)), "check");

// Runs scripts/check with stub `cargo` and `npm` first on PATH. The stubs only record the
// command line they were given, so the test sees exactly what check asks the tools to do.
function run(args, { nextest = true, env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "check-test-"));
  const log = path.join(dir, "calls.log");
  const stub = (name, body) => {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  };
  stub(
    "cargo",
    `if [[ "$1" == nextest && "$2" == --version ]]; then exit ${nextest ? 0 : 1}; fi
echo "cargo $*" >> "${log}"`,
  );
  stub("npm", `echo "npm $*" >> "${log}"`);
  // The fast job runs these tests with real CI variables; scripts/check must not write to them.
  const inherited = { ...process.env };
  for (const name of [
    "GITHUB_OUTPUT",
    "GITHUB_STEP_SUMMARY",
    "PLAN_LABELS",
    "GITHUB_EVENT_NAME",
  ])
    delete inherited[name];
  // Through bash: native Node on Windows cannot start an extensionless script by its shebang.
  const result = spawnSync("bash", [check, ...args], {
    encoding: "utf8",
    env: {
      ...inherited,
      CI: "",
      ...env,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    },
  });
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n");
  } catch {
    // No tool was called.
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
  };
}

test("rust runs every test through nextest, then the doc-tests", () => {
  const { status, calls } = run(["rust"]);
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    "cargo nextest run --workspace --locked",
    "cargo test --doc --workspace --locked",
  ]);
});

test("rust partition k/n becomes a nextest hash partition, and only shard 1 runs the doc-tests", () => {
  const first = run(["rust", "--partition", "1/3"]);
  assert.equal(first.status, 0);
  assert.deepEqual(first.calls, [
    "cargo nextest run --workspace --locked --partition hash:1/3",
    "cargo test --doc --workspace --locked",
  ]);
  const second = run(["rust", "--partition", "2/3"]);
  assert.equal(second.status, 0);
  assert.deepEqual(second.calls, [
    "cargo nextest run --workspace --locked --partition hash:2/3",
  ]);
});

test("rust uses the ci nextest profile when CI is set", () => {
  const { calls } = run(["rust", "--partition=3/3"], { env: { CI: "true" } });
  assert.deepEqual(calls, [
    "cargo nextest run --workspace --locked --profile ci --partition hash:3/3",
  ]);
});

test("rust without nextest still runs every test, and says how to get nextest", () => {
  const { status, stderr, calls } = run(["rust"], { nextest: false });
  assert.equal(status, 0);
  assert.deepEqual(calls, ["cargo test --workspace --locked --no-fail-fast"]);
  assert.match(stderr, /cargo-nextest/);
});

test("rust refuses a partition it cannot honor instead of running everything in every shard", () => {
  const { status, stderr, calls } = run(["rust", "--partition", "1/2"], {
    nextest: false,
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /cargo-nextest/);
  assert.deepEqual(calls, []);
});

test("a malformed partition is a usage error", () => {
  for (const bad of ["0/3", "4/3", "1", "a/b", "1/0", "1/2/3"]) {
    const { status, stderr, calls } = run(["rust", "--partition", bad]);
    assert.equal(status, 2, bad);
    assert.match(stderr, /usage/, bad);
    assert.deepEqual(calls, [], bad);
  }
  assert.equal(run(["rust", "--partition"]).status, 2);
});

test("a partition only applies to rust and ui", () => {
  assert.equal(run(["fast", "--partition", "1/2"]).status, 2);
  assert.equal(run(["clippy", "--partition", "1/2"]).status, 2);
});

test("plan needs a base revision and takes no partition", () => {
  assert.equal(run(["plan"]).status, 2);
  assert.equal(run(["plan", "HEAD", "--partition", "1/2"]).status, 2);
  assert.equal(run(["rust", "HEAD"]).status, 2);
  assert.equal(run(["plan", "HEAD", "HEAD"]).status, 2);
});

test("plan prints the change plan and runs no build tool", () => {
  // A push plans everything whatever the diff says, so this does not depend on the checkout.
  const { status, stdout, calls } = run(["plan", "HEAD"], {
    env: { GITHUB_EVENT_NAME: "push" },
  });
  assert.equal(status, 0);
  assert.match(stdout, /frontend lane: true/);
  assert.match(stdout, /rust lane:\s+true/);
  assert.deepEqual(calls, []);
});

test("clippy runs on its own", () => {
  const { status, calls } = run(["clippy"]);
  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.match(
    calls[0] ?? "",
    /^cargo clippy --workspace --all-targets --locked -- -D warnings/,
  );
});

test("ui partition k/n becomes a vitest shard in every workspace", () => {
  const { status, calls } = run(["ui", "--partition", "2/3"]);
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    "npm run test --workspaces -- --shard 2/3 --passWithNoTests",
  ]);
});

test("ui without a partition runs the whole frontend suite", () => {
  assert.deepEqual(run(["ui"]).calls, ["npm test"]);
});

test("slow runs Clippy, then the Rust tests, then the frontend tests", () => {
  const { calls } = run(["slow"]);
  assert.deepEqual(
    calls.map((call) => call.split(" ").slice(0, 3).join(" ")),
    [
      "cargo clippy --workspace",
      "cargo nextest run",
      "cargo test --doc",
      "npm test",
    ],
  );
});
