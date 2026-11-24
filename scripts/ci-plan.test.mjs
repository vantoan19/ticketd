import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { JOBS, classify, makePlan, renderPlan, verdict } from "./ci-plan.mjs";

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "ci-plan.mjs",
);

// The fast job runs these tests with real CI variables; a child process must not write to them.
const childEnv = (extra = {}) => {
  const env = { ...process.env };
  for (const name of [
    "GITHUB_OUTPUT",
    "GITHUB_STEP_SUMMARY",
    "PLAN_LABELS",
    "GITHUB_EVENT_NAME",
  ])
    delete env[name];
  return { ...env, ...extra };
};

const pr = (files, extra = {}) =>
  makePlan({ event: "pull_request", labels: [], files, ...extra });
const lanes = (plan) => ({ frontend: plan.frontend, rust: plan.rust });
const NONE = { frontend: false, rust: false };
const FRONTEND = { frontend: true, rust: false };
const RUST = { frontend: false, rust: true };
const BOTH = { frontend: true, rust: true };

// One row per line of the table in the agreed design (docs/adr/0023-ci-runs-the-jobs-a-change-needs.md and the Fast CI spec).
const table = [
  // No lane: only the fast checks run.
  ["docs/architecture.md", NONE],
  ["docs/agents/quality.md", NONE],
  ["README.md", NONE],
  ["CONTRIBUTING.md", NONE],
  ["LICENSE", NONE],
  [".github/ISSUE_TEMPLATE/bug.yml", NONE],
  [".github/pull_request_template.md", NONE],
  [".github/actionlint.yaml", NONE],
  [".coderabbit.yaml", NONE],
  [".markdownlint-cli2.jsonc", NONE],
  [".gitignore", NONE],
  ["benchmarks/cli.py", NONE],
  ["tests/native/install.mjs", NONE],
  ["tests/live/README.md", NONE],
  // Frontend only.
  ["apps/desktop/src/features/tickets/Inbox.tsx", FRONTEND],
  ["apps/desktop/vite.config.ts", FRONTEND],
  ["apps/desktop/package.json", FRONTEND],
  ["apps/docs/content/docs/install.mdx", FRONTEND],
  ["apps/docs/check-pages.mjs", FRONTEND],
  // The docs site includes the glossary (content/docs/reference/glossary.mdx).
  ["GLOSSARY.md", FRONTEND],
  // The docs site includes the privacy policy (content/docs/reference/privacy.mdx).
  ["PRIVACY.md", FRONTEND],
  ["THIRD_PARTY_NOTICES.md", NONE],
  ["DESIGN.md", NONE],
  // Embedded by Rust at compile time: both.
  ["apps/desktop/src/features/chats/client.ts", BOTH],
  ["apps/desktop/src/features/chats/Transcript.tsx", BOTH],
  ["apps/desktop/public/startup-fallback.js", BOTH],
  // The chat bridge is bundled into the desktop build: both.
  ["apps/chat-bridge-claude/src/index.ts", BOTH],
  // Frontend tests and the docs site read files under src-tauri (tauri.conf.json, icons): both.
  ["apps/desktop/src-tauri/src/lib.rs", BOTH],
  ["apps/desktop/src-tauri/tauri.conf.json", BOTH],
  ["apps/desktop/src-tauri/icons/32x32.png", BOTH],
  // Rust only.
  ["crates/ticketd-core/src/lib.rs", RUST],
  ["skills/ticketd/SKILL.md", RUST],
  // Rust tests read these files.
  ["docs/sync-file-format.md", RUST],
  ["docs/source-extensions/contract-2.schema.json", RUST],
  // Shared configuration: both.
  ["Cargo.toml", BOTH],
  ["Cargo.lock", BOTH],
  ["rust-toolchain.toml", BOTH],
  ["clippy.toml", BOTH],
  ["rustfmt.toml", BOTH],
  [".cargo/config.toml", BOTH],
  [".config/nextest.toml", BOTH],
  ["package.json", BOTH],
  ["package-lock.json", BOTH],
  [".nvmrc", BOTH],
  ["eslint.config.js", BOTH],
  [".prettierrc.json", BOTH],
  [".prettierignore", BOTH],
  [".editorconfig", BOTH],
  [".gitattributes", BOTH],
  ["scripts/check", BOTH],
  ["scripts/check.test.mjs", BOTH],
  ["scripts/ci-plan.mjs", BOTH],
  [".github/workflows/quality.yml", BOTH],
  [".github/workflows/pages.yml", BOTH],
  [".github/actions/prepare/action.yml", BOTH],
  ["AGENTS.md", BOTH],
  ["CLAUDE.md", BOTH],
];

for (const [file, expected] of table) {
  test(`${file} -> ${JSON.stringify(expected)}`, () => {
    assert.deepEqual(classify(file), expected);
    const plan = pr([file]);
    assert.deepEqual(lanes(plan), expected);
    assert.equal(plan.reason, null);
  });
}

test("a Markdown file below the root is not a root Markdown file", () => {
  // A new top-level folder is unknown, so it runs everything rather than being guessed.
  assert.equal(classify("newdir/NOTES.md"), null);
  assert.equal(classify("apps/other/README.md"), null);
});

test("a mixed diff takes the union of its lanes", () => {
  assert.deepEqual(
    lanes(pr(["docs/product.md", "apps/desktop/src/app/App.tsx"])),
    FRONTEND,
  );
  assert.deepEqual(
    lanes(
      pr(["apps/desktop/src/app/App.tsx", "crates/ticketd-cli/src/main.rs"]),
    ),
    BOTH,
  );
  assert.deepEqual(
    lanes(pr(["docs/product.md", "crates/ticketd-cli/src/main.rs"])),
    RUST,
  );
  assert.deepEqual(lanes(pr(["docs/product.md", "README.md"])), NONE);
});

test("the plan names the paths that caused each lane", () => {
  const plan = pr([
    "docs/product.md",
    "apps/desktop/src/app/App.tsx",
    "apps/desktop/src/app/Other.tsx",
    "crates/ticketd-cli/src/main.rs",
  ]);
  assert.deepEqual(plan.causes.frontend, {
    count: 2,
    paths: ["apps/desktop/src/app/App.tsx", "apps/desktop/src/app/Other.tsx"],
  });
  assert.deepEqual(plan.causes.rust, {
    count: 1,
    paths: ["crates/ticketd-cli/src/main.rs"],
  });
});

test("the plan lists at most ten causing paths per lane and counts the rest", () => {
  const files = Array.from(
    { length: 25 },
    (_, i) => `crates/ticketd-core/src/m${i}.rs`,
  );
  const plan = pr(files);
  assert.equal(plan.causes.rust.count, 25);
  assert.equal(plan.causes.rust.paths.length, 10);
});

test("a path that matches no rule runs everything and is named", () => {
  const plan = pr(["docs/product.md", "mystery/file.txt"]);
  assert.deepEqual(lanes(plan), BOTH);
  assert.match(plan.reason, /no rule/);
  assert.deepEqual(plan.unmatched, ["mystery/file.txt"]);
});

test("a git failure runs everything and says so", () => {
  const plan = makePlan({
    event: "pull_request",
    labels: [],
    files: null,
    gitError: "bad revision",
  });
  assert.deepEqual(lanes(plan), BOTH);
  assert.match(plan.reason, /git/);
  assert.match(plan.reason, /bad revision/);
});

test("a missing file list is a failure, never an empty diff", () => {
  const plan = makePlan({ event: "pull_request", labels: [] });
  assert.deepEqual(lanes(plan), BOTH);
});

test("an empty diff runs everything rather than nothing", () => {
  const plan = pr([]);
  assert.deepEqual(lanes(plan), BOTH);
  assert.match(plan.reason, /no changed files/);
});

for (const event of [
  "push",
  "schedule",
  "workflow_dispatch",
  "merge_group",
  "something_new",
]) {
  test(`a ${event} event runs everything, even for a docs-only diff`, () => {
    const plan = makePlan({ event, labels: [], files: ["docs/product.md"] });
    assert.deepEqual(lanes(plan), BOTH);
    assert.match(plan.reason, new RegExp(event));
  });
}

test("a push needs no file list at all", () => {
  const plan = makePlan({ event: "push", labels: [], files: null });
  assert.deepEqual(lanes(plan), BOTH);
});

test("the ci-full label runs everything", () => {
  const plan = pr(["docs/product.md"], { labels: ["bug", "ci-full"] });
  assert.deepEqual(lanes(plan), BOTH);
  assert.match(plan.reason, /ci-full/);
});

test("other labels change nothing", () => {
  assert.deepEqual(
    lanes(pr(["docs/product.md"], { labels: ["bug", "platform-check"] })),
    NONE,
  );
});

// The command line, against a real throwaway repository.

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function repo(secondCommit) {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-plan-test-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "ci@example.invalid");
  git(dir, "config", "user.name", "ci");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "docs/a.md"), "one\n");
  writeFileSync(path.join(dir, "README.md"), "readme\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  secondCommit(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "second", "--allow-empty");
  return dir;
}

function cli(dir, args, env = {}) {
  const outputFile = path.join(dir, "..", `${path.basename(dir)}-output.txt`);
  writeFileSync(outputFile, "");
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: childEnv({ GITHUB_OUTPUT: outputFile, ...env }),
  });
  const outputs = Object.fromEntries(
    readFileSync(outputFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  return { ...result, outputs };
}

test("cli: a docs-only pull request publishes both lanes as false", () => {
  const dir = repo((d) => writeFileSync(path.join(d, "docs/a.md"), "two\n"));
  const result = cli(dir, ["--base", "HEAD^1", "--event", "pull_request"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs.frontend, "false");
  assert.equal(result.outputs.rust, "false");
  assert.equal(JSON.parse(result.outputs.plan).reason, null);
});

test("cli: a Rust change publishes only the Rust lane", () => {
  const dir = repo((d) => {
    mkdirSync(path.join(d, "crates/x"), { recursive: true });
    writeFileSync(path.join(d, "crates/x/lib.rs"), "\n");
  });
  const result = cli(dir, ["--base", "HEAD^1", "--event", "pull_request"]);
  assert.equal(result.outputs.frontend, "false");
  assert.equal(result.outputs.rust, "true");
});

test("cli: the event comes from GITHUB_EVENT_NAME and a push runs everything", () => {
  const dir = repo((d) => writeFileSync(path.join(d, "docs/a.md"), "two\n"));
  const result = cli(dir, ["--base", "HEAD^1"], { GITHUB_EVENT_NAME: "push" });
  assert.equal(result.outputs.frontend, "true");
  assert.equal(result.outputs.rust, "true");
});

test("cli: labels are comma separated", () => {
  const dir = repo((d) => writeFileSync(path.join(d, "docs/a.md"), "two\n"));
  const result = cli(dir, [
    "--base",
    "HEAD^1",
    "--event",
    "pull_request",
    "--labels",
    "bug,ci-full",
  ]);
  assert.equal(result.outputs.rust, "true");
  assert.match(JSON.parse(result.outputs.plan).reason, /ci-full/);
});

test("cli: a git failure runs everything and still exits 0", () => {
  const dir = repo((d) => writeFileSync(path.join(d, "docs/a.md"), "two\n"));
  const result = cli(dir, [
    "--base",
    "no-such-revision",
    "--event",
    "pull_request",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs.frontend, "true");
  assert.equal(result.outputs.rust, "true");
  assert.match(JSON.parse(result.outputs.plan).reason, /git/);
});

test("cli: running outside a git repository runs everything", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-plan-nogit-"));
  const result = cli(dir, ["--base", "HEAD^1", "--event", "pull_request"], {
    GIT_CEILING_DIRECTORIES: path.dirname(dir),
  });
  assert.equal(result.outputs.frontend, "true");
  assert.equal(result.outputs.rust, "true");
});

test("cli: a rename out of a Rust folder still counts as a Rust change", () => {
  const dir = repo((d) => {
    mkdirSync(path.join(d, "crates/x"), { recursive: true });
    writeFileSync(
      path.join(d, "crates/x/lib.rs"),
      "a long enough line of content\n".repeat(20),
    );
  });
  git(dir, "mv", "crates/x/lib.rs", "docs/lib.md");
  git(dir, "commit", "-q", "-m", "rename");
  const result = cli(dir, ["--base", "HEAD^1", "--event", "pull_request"]);
  assert.equal(result.outputs.rust, "true");
});

test("cli: an unknown option fails the plan job instead of guessing", () => {
  const dir = repo((d) => writeFileSync(path.join(d, "docs/a.md"), "two\n"));
  const result = cli(dir, ["--bse", "HEAD^1"]);
  assert.notEqual(result.status, 0);
});

test("cli: the base is required", () => {
  const dir = repo((d) => writeFileSync(path.join(d, "docs/a.md"), "two\n"));
  const result = cli(dir, ["--event", "pull_request"]);
  assert.notEqual(result.status, 0);
});

// The aggregate check behind `CI result`.

const needsFor = (plan, results) => ({
  plan: { result: "success", outputs: { plan: JSON.stringify(plan) } },
  ...Object.fromEntries(
    Object.entries(results).map(([job, result]) => [job, { result }]),
  ),
});
const docsPlan = () => pr(["docs/product.md"]);
const frontendPlan = () => pr(["apps/desktop/src/app/App.tsx"]);
const fullPlan = () => makePlan({ event: "push", labels: [], files: null });
const allSuccess = {
  fast: "success",
  clippy: "success",
  rust: "success",
  ui: "success",
  pages: "success",
};

test("verdict: a full run passes when every job succeeded", () => {
  assert.deepEqual(verdict(needsFor(fullPlan(), allSuccess)), {
    ok: true,
    problems: [],
  });
});

test("verdict: a docs-only run passes when only the fast checks ran", () => {
  const results = {
    fast: "success",
    clippy: "skipped",
    rust: "skipped",
    ui: "skipped",
    pages: "skipped",
  };
  assert.deepEqual(verdict(needsFor(docsPlan(), results)), {
    ok: true,
    problems: [],
  });
});

test("verdict: a frontend-only run passes with the Rust lane skipped", () => {
  const results = {
    fast: "success",
    clippy: "skipped",
    rust: "skipped",
    ui: "success",
    pages: "success",
  };
  assert.deepEqual(verdict(needsFor(frontendPlan(), results)), {
    ok: true,
    problems: [],
  });
});

test("verdict: a planned job that was skipped fails", () => {
  const results = { ...allSuccess, rust: "skipped" };
  const { ok, problems } = verdict(needsFor(fullPlan(), results));
  assert.equal(ok, false);
  assert.match(problems.join("\n"), /rust: skipped/);
});

test("verdict: an unplanned job that ran fails, because the plan and the workflow disagree", () => {
  const results = {
    fast: "success",
    clippy: "skipped",
    rust: "skipped",
    ui: "success",
    pages: "skipped",
  };
  assert.equal(verdict(needsFor(docsPlan(), results)).ok, false);
});

test("verdict: the Windows Pages check is planned with the frontend lane, so a skip fails", () => {
  const results = {
    fast: "success",
    clippy: "skipped",
    rust: "skipped",
    ui: "success",
    pages: "skipped",
  };
  const { ok, problems } = verdict(needsFor(frontendPlan(), results));
  assert.equal(ok, false);
  assert.match(problems.join("\n"), /pages: skipped/);
  // And an unplanned run of it fails too.
  assert.equal(
    verdict(
      needsFor(docsPlan(), {
        fast: "success",
        clippy: "skipped",
        rust: "skipped",
        ui: "skipped",
        pages: "success",
      }),
    ).ok,
    false,
  );
});

test("verdict: a failed or cancelled job always fails, planned or not", () => {
  for (const result of ["failure", "cancelled"]) {
    assert.equal(
      verdict(needsFor(fullPlan(), { ...allSuccess, ui: result })).ok,
      false,
      result,
    );
    const docsOnly = {
      fast: "success",
      clippy: "skipped",
      rust: "skipped",
      ui: result,
      pages: "skipped",
    };
    assert.equal(verdict(needsFor(docsPlan(), docsOnly)).ok, false, result);
  }
});

test("verdict: the fast checks are required in every plan", () => {
  const results = { ...allSuccess, fast: "skipped" };
  assert.equal(verdict(needsFor(docsPlan(), results)).ok, false);
});

test("verdict: a plan job that did not succeed fails, whatever the others report", () => {
  const needs = needsFor(fullPlan(), allSuccess);
  for (const result of ["failure", "cancelled", "skipped"]) {
    needs.plan.result = result;
    assert.equal(verdict(needs).ok, false, result);
  }
});

test("verdict: an unreadable plan fails instead of skipping everything", () => {
  const needs = needsFor(fullPlan(), allSuccess);
  for (const plan of [
    "",
    "not json",
    "{}",
    '{"frontend":"true","rust":true}',
  ]) {
    needs.plan.outputs.plan = plan;
    assert.equal(verdict(needs).ok, false, plan);
  }
});

test("verdict: a job missing from needs fails", () => {
  const needs = needsFor(fullPlan(), allSuccess);
  delete needs.ui;
  assert.equal(verdict(needs).ok, false);
});

test("the workflow's jobs are the plan, the result and exactly the jobs the verdict knows", () => {
  const workflow = readFileSync(
    path.join(path.dirname(script), "../.github/workflows/quality.yml"),
    "utf8",
  );
  const jobsSection = workflow.slice(workflow.indexOf("\njobs:\n"));
  const ids = [...jobsSection.matchAll(/^ {2}([a-z][a-z-]*):\s*$/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    ids.filter((id) => id !== "plan" && id !== "result").sort(),
    Object.keys(JOBS).sort(),
  );
  assert.ok(ids.includes("plan") && ids.includes("result"));
  // The result job waits for the plan and every job the verdict knows.
  const needs = jobsSection
    .match(/needs: \[plan, ([a-z, ]+)\]\n\s+runs-on/)?.[1]
    .split(", ")
    .sort();
  assert.deepEqual(needs, Object.keys(JOBS).sort());
});

test("renderPlan lists each job with the paths that caused it", () => {
  const plan = pr(["docs/product.md", "apps/desktop/src/app/App.tsx"]);
  const text = renderPlan(plan);
  assert.match(text, /### Plan/);
  assert.match(text, /\| Fast checks \| yes \|/);
  assert.match(
    text,
    /\| Frontend tests \| yes \| .*apps\/desktop\/src\/app\/App\.tsx/,
  );
  assert.match(text, /\| Rust tests \| no \|/);
  assert.match(text, /\| Clippy \| no \|/);
});

test("renderPlan says why everything runs", () => {
  const text = renderPlan(
    makePlan({ event: "schedule", labels: [], files: null }),
  );
  assert.match(text, /schedule event runs everything/);
  assert.match(text, /\| Rust tests \| yes \|/);
});

function runResult(env) {
  return spawnSync(process.execPath, [script, "result"], {
    encoding: "utf8",
    env: childEnv(env),
  });
}

test("cli result: exits 1 and names the problem when the verdict fails", () => {
  const needs = needsFor(fullPlan(), { ...allSuccess, rust: "skipped" });
  const result = runResult({ NEEDS_JSON: JSON.stringify(needs) });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::/);
  assert.match(result.stdout, /### Plan/);
});

test("cli result: exits 0 when the plan was followed", () => {
  const needs = needsFor(docsPlan(), {
    fast: "success",
    clippy: "skipped",
    rust: "skipped",
    ui: "skipped",
    pages: "skipped",
  });
  const result = runResult({ NEEDS_JSON: JSON.stringify(needs) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("cli result: missing or malformed input fails", () => {
  assert.equal(runResult({ NEEDS_JSON: "" }).status, 1);
  assert.equal(runResult({ NEEDS_JSON: "{not json" }).status, 1);
});
