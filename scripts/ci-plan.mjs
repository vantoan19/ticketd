#!/usr/bin/env node
// The change plan: which CI lanes a change needs.
//
// Usage: node scripts/ci-plan.mjs --base <revision> [--event <name>] [--labels a,b]
//        node scripts/ci-plan.mjs result   (the `CI result` job: reads $NEEDS_JSON)
//   (or `scripts/check plan <revision>`)
//
// It diffs <revision> against HEAD, maps each changed path to the frontend and Rust lanes, and
// prints the plan. In GitHub Actions it also writes the outputs `frontend`, `rust` and `plan`
// (JSON) to $GITHUB_OUTPUT. The fast checks are not a lane: they always run.
//
// The one rule that matters: when in doubt, everything runs. A path that matches no rule, a git
// failure, an empty diff, a `ci-full` label and every event except a pull request all plan both
// lanes. A skipped job must never be able to look like "nothing to check".
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BOTH = { frontend: true, rust: true };
const NONE = { frontend: false, rust: false };

const startsWith = (prefix) => (p) => p.startsWith(prefix);
const oneOf = (...names) => {
  const set = new Set(names);
  return (p) => set.has(p);
};

// First match wins, so the specific rules come before the folders that contain them. The
// agreed table is in the "Fast CI: agreed design" spec and ADR 0023.
const rules = [
  // Rust embeds these three frontend files at compile time (chat_view.rs, lib.rs).
  {
    match: oneOf(
      "apps/desktop/src/features/chats/client.ts",
      "apps/desktop/src/features/chats/Transcript.tsx",
      "apps/desktop/public/startup-fallback.js",
    ),
    ...BOTH,
  },
  // The desktop build bundles the chat bridge, and the chat-host fixtures replay its protocol.
  { match: startsWith("apps/chat-bridge-claude/"), ...BOTH },
  // Frontend tests and the docs site read files here too (tauri.conf.json, icons/).
  { match: startsWith("apps/desktop/src-tauri/"), frontend: true, rust: true },
  { match: startsWith("apps/desktop/"), frontend: true, rust: false },
  // The website is an npm workspace; its tests and Pages check run in the frontend shards.
  { match: startsWith("apps/docs/"), frontend: true, rust: false },
  { match: startsWith("crates/"), frontend: false, rust: true },
  // skills/ticketd/SKILL.md is embedded by ticketd-core (agent_skills.rs).
  { match: startsWith("skills/"), frontend: false, rust: true },
  // A Rust test parses the examples in this document (tests/sync_files.rs).
  { match: oneOf("docs/sync-file-format.md"), frontend: false, rust: true },
  // The docs site includes this file (apps/docs/content/docs/reference/glossary.mdx).
  // It also includes PRIVACY.md (content/docs/reference/privacy.mdx).
  { match: oneOf("GLOSSARY.md", "PRIVACY.md"), frontend: true, rust: false },
  // Documentation and files only people or the fast checks read.
  {
    match: (p) =>
      startsWith("docs/")(p) ||
      (/^[^/]+\.md$/.test(p) && p !== "AGENTS.md" && p !== "CLAUDE.md") ||
      startsWith(".github/ISSUE_TEMPLATE/")(p) ||
      startsWith("benchmarks/")(p) ||
      startsWith("tests/native/")(p) ||
      startsWith("tests/live/")(p) ||
      oneOf(
        "LICENSE",
        ".github/pull_request_template.md",
        ".github/actionlint.yaml",
        ".coderabbit.yaml",
        ".markdownlint-cli2.jsonc",
        ".gitignore",
      )(p),
    ...NONE,
  },
  // Toolchain, dependency, lint and CI configuration, and the scripts that run the checks.
  {
    match: (p) =>
      startsWith(".cargo/")(p) ||
      startsWith(".config/")(p) ||
      startsWith("scripts/")(p) ||
      startsWith(".github/workflows/")(p) ||
      startsWith(".github/actions/")(p) ||
      oneOf(
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "clippy.toml",
        "rustfmt.toml",
        "package.json",
        "package-lock.json",
        ".nvmrc",
        "eslint.config.js",
        ".prettierrc.json",
        ".prettierignore",
        ".editorconfig",
        ".gitattributes",
        "AGENTS.md",
        "CLAUDE.md",
      )(p),
    ...BOTH,
  },
];

/** The lanes one path needs, or null when no rule matches it. */
export function classify(file) {
  for (const rule of rules) {
    if (rule.match(file)) return { frontend: rule.frontend, rust: rule.rust };
  }
  return null;
}

const MAX_CAUSES = 10;

function everything(reason, extra = {}) {
  return {
    ...BOTH,
    reason,
    unmatched: [],
    causes: {
      frontend: { count: 0, paths: [] },
      rust: { count: 0, paths: [] },
    },
    ...extra,
  };
}

/**
 * The plan for one run. `files` is the list of changed paths, or null/undefined when it could
 * not be read; `gitError` says why. Anything uncertain plans both lanes.
 */
export function makePlan({ event, labels = [], files, gitError }) {
  if (event !== "pull_request")
    return everything(`${event || "unknown"} event runs everything`);
  if (labels.includes("ci-full"))
    return everything("the ci-full label runs everything");
  if (gitError)
    return everything(`git failed (${gitError}), so everything runs`);
  if (!Array.isArray(files))
    return everything("the changed files are unknown, so everything runs");
  if (files.length === 0)
    return everything("no changed files were found, so everything runs");

  const causes = { frontend: [], rust: [] };
  const unmatched = [];
  for (const file of files) {
    const lanes = classify(file);
    if (!lanes) {
      unmatched.push(file);
      continue;
    }
    if (lanes.frontend) causes.frontend.push(file);
    if (lanes.rust) causes.rust.push(file);
  }
  const summarize = (paths) => ({
    count: paths.length,
    paths: paths.slice(0, MAX_CAUSES),
  });
  const shown = {
    frontend: summarize(causes.frontend),
    rust: summarize(causes.rust),
  };

  if (unmatched.length > 0) {
    return everything(
      `${unmatched.length} changed path(s) match no rule, so everything runs`,
      {
        unmatched: unmatched.slice(0, MAX_CAUSES),
        causes: shown,
      },
    );
  }
  return {
    frontend: causes.frontend.length > 0,
    rust: causes.rust.length > 0,
    reason: null,
    unmatched: [],
    causes: shown,
  };
}

/** The paths changed between `base` and HEAD: `{ files }` or `{ error }`, never an empty guess. */
export function changedFiles(base, cwd = process.cwd()) {
  // --no-renames lists both sides of a rename; -z keeps unusual file names intact.
  const result = spawnSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", base, "HEAD"],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) return { error: result.error.message };
  if (result.status !== 0) {
    const detail =
      (result.stderr || "").trim().split("\n")[0] ||
      `exit status ${result.status}`;
    return { error: detail };
  }
  return { files: result.stdout.split("\0").filter(Boolean) };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (
      !["--base", "--event", "--labels"].includes(flag) ||
      i + 1 >= argv.length
    ) {
      throw new Error(
        `usage: ci-plan.mjs --base <revision> [--event <name>] [--labels a,b] (got ${flag})`,
      );
    }
    options[flag.slice(2)] = argv[(i += 1)];
  }
  return options;
}

// The jobs of .github/workflows/quality.yml that the plan gates, by job id. `lane` is the plan
// output that decides whether the job runs; null means it always runs. A test keeps this list in
// step with the workflow, so a new job cannot be left out of `CI result`.
export const JOBS = {
  fast: { name: "Fast checks", lane: null },
  clippy: { name: "Clippy", lane: "rust" },
  rust: { name: "Rust tests", lane: "rust" },
  ui: { name: "Frontend tests", lane: "frontend" },
  pages: { name: "Windows Pages check", lane: "frontend" },
  minio: { name: "S3 storage (MinIO)", lane: "rust" },
};

function readPlan(needs) {
  const plan = needs?.plan?.outputs?.plan;
  if (typeof plan !== "string" || plan === "")
    return { error: "the plan job published no plan" };
  let parsed;
  try {
    parsed = JSON.parse(plan);
  } catch {
    return { error: "the plan job's output is not valid JSON" };
  }
  if (
    typeof parsed?.frontend !== "boolean" ||
    typeof parsed?.rust !== "boolean"
  ) {
    return { error: "the plan job's output does not say which lanes run" };
  }
  return { plan: parsed };
}

/**
 * Whether `CI result` passes. `needs` is the `needs` context of the result job. It passes only
 * when the plan job succeeded, every planned job succeeded and every unplanned job was skipped.
 * A failed or cancelled job fails it, and so does a planned job that was skipped.
 */
export function verdict(needs) {
  const problems = [];
  if (needs?.plan?.result !== "success") {
    problems.push(
      `plan: ${needs?.plan?.result ?? "missing"} (expected success)`,
    );
    return { ok: false, problems };
  }
  const { plan, error } = readPlan(needs);
  if (error) return { ok: false, problems: [error] };
  for (const [id, job] of Object.entries(JOBS)) {
    const planned = job.lane === null || plan[job.lane];
    const expected = planned ? "success" : "skipped";
    const result = needs[id]?.result ?? "missing";
    if (result !== expected)
      problems.push(`${id}: ${result} (expected ${expected})`);
  }
  return { ok: problems.length === 0, problems };
}

const code = (path) => `\`${path}\``;

/** The "Plan" section of the run summary: each job, whether it was needed, and why. */
export function renderPlan(plan) {
  const lines = ["### Plan", ""];
  if (plan.reason) lines.push(`Everything runs: ${plan.reason}.`, "");
  lines.push("| Job | Needed | Because |", "| --- | --- | --- |");
  for (const job of Object.values(JOBS)) {
    if (job.lane === null) {
      lines.push(`| ${job.name} | yes | the fast checks always run |`);
      continue;
    }
    const cause = plan.causes?.[job.lane] ?? { count: 0, paths: [] };
    let because;
    if (!plan[job.lane]) because = "no changed path needs it";
    else if (plan.reason) because = plan.reason;
    else {
      const more = cause.count - cause.paths.length;
      because =
        cause.paths.map(code).join(", ") +
        (more > 0 ? ` and ${more} more` : "");
    }
    lines.push(
      `| ${job.name} | ${plan[job.lane] ? "yes" : "no"} | ${because} |`,
    );
  }
  if (plan.unmatched?.length > 0) {
    lines.push("", `No rule for: ${plan.unmatched.map(code).join(", ")}.`);
  }
  return lines.join("\n");
}

/** `ci-plan.mjs result`: the body of the `CI result` job. Returns the exit code. */
export function result(env = process.env) {
  let needs;
  try {
    needs = JSON.parse(env.NEEDS_JSON ?? "");
  } catch {
    console.log("::error::CI result got no readable `needs` context.");
    return 1;
  }
  const { plan } = readPlan(needs);
  if (plan) {
    const section = renderPlan(plan);
    console.log(section);
    // The run summary shows the plan next to the timing table.
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(env.GITHUB_STEP_SUMMARY, `\n${section}\n`);
  }
  const { ok, problems } = verdict(needs);
  for (const problem of problems)
    console.log(`::error::Job did not follow the plan: ${problem}`);
  if (ok)
    console.log(
      "\nAll planned jobs succeeded and every other job was skipped.",
    );
  return ok ? 0 : 1;
}

export function main(argv, env = process.env) {
  const options = parseArgs(argv);
  const event = options.event ?? env.GITHUB_EVENT_NAME ?? "pull_request";
  const labels = (options.labels ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);

  let diff = {};
  if (event === "pull_request" && !labels.includes("ci-full")) {
    if (!options.base)
      throw new Error("--base <revision> is required for a pull request");
    diff = changedFiles(options.base);
  }
  const plan = makePlan({
    event,
    labels,
    files: diff.files,
    gitError: diff.error,
  });

  console.log(`frontend lane: ${plan.frontend}`);
  console.log(`rust lane:     ${plan.rust}`);
  if (plan.reason) console.log(`reason: ${plan.reason}`);
  for (const path of plan.unmatched) console.log(`  no rule for ${path}`);
  for (const lane of ["frontend", "rust"]) {
    for (const path of plan.causes[lane].paths)
      console.log(`  ${lane}: ${path}`);
    const more = plan.causes[lane].count - plan.causes[lane].paths.length;
    if (more > 0) console.log(`  ${lane}: and ${more} more`);
  }

  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `frontend=${plan.frontend}\nrust=${plan.rust}\nplan=${JSON.stringify(plan)}\n`,
    );
  }
  return plan;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === "result") process.exit(result());
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }
}
