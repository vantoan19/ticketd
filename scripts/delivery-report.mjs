#!/usr/bin/env node
// Delivery report: DORA-style measures of how changes reach main, read from GitHub.
// Usage: node scripts/delivery-report.mjs [--days 30]
// Needs an authenticated `gh` (in Actions, GH_TOKEN). Prints Markdown, and appends it to
// the run summary when GITHUB_STEP_SUMMARY is set.
//
// Until ticketd publishes releases, merges to main stand in for deployments and a failed
// main run stands in for a failed change; the report says so rather than inventing
// release numbers.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Hosted CI never executed a step before this run (an account billing block), so earlier
// runs say nothing about the code.
export const FIRST_EXECUTED_RUN = "2026-11-19T18:25:00Z";

const HOUR = 3600 * 1000;

/** The p-th percentile (0-100) of `values`, by nearest rank; null when empty. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** A duration in milliseconds as minutes, hours or days. */
export function formatDuration(ms) {
  if (ms === null) return "n/a";
  const minutes = ms / 60000;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1440).toFixed(1)} d`;
}

/** Milliseconds from each merged PR's first commit to its merge. */
export function leadTimes(prs) {
  return prs
    .filter((pr) => pr.firstCommitAt)
    .map((pr) => Date.parse(pr.mergedAt) - Date.parse(pr.firstCommitAt));
}

/** Milliseconds from each merge to the end of the successful main run of its commit. */
export function mergeToGreen(prs, runs) {
  const green = new Map(
    runs
      .filter((run) => run.conclusion === "success")
      .map((run) => [run.sha, run.endedAt]),
  );
  return prs
    .filter((pr) => green.has(pr.mergeSha))
    .map((pr) => Date.parse(green.get(pr.mergeSha)) - Date.parse(pr.mergedAt));
}

/**
 * Main's health from its push runs: how many failed, and how long main stayed red each
 * time it broke (from the first failing run's start to the next successful run's end).
 * Canceled and unfinished runs count for neither.
 */
export function mainHealth(runs) {
  const finished = runs
    .filter(
      (run) => run.conclusion === "success" || run.conclusion === "failure",
    )
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const restores = [];
  let redSince = null;
  for (const run of finished) {
    if (run.conclusion === "failure") {
      redSince ??= run.startedAt;
    } else if (redSince !== null) {
      restores.push(Date.parse(run.endedAt) - Date.parse(redSince));
      redSince = null;
    }
  }
  return {
    finished: finished.length,
    failed: finished.filter((run) => run.conclusion === "failure").length,
    restores,
    redSince,
  };
}

export function render({ since, until, prs, runs, releases }) {
  const leads = leadTimes(prs);
  const toGreen = mergeToGreen(prs, runs);
  const health = mainHealth(runs);
  const stable = releases.filter((release) => !release.prerelease).length;
  const spread = (values) =>
    `${formatDuration(percentile(values, 50))} / ${formatDuration(percentile(values, 95))}`;
  // Per week over the window actually measured, counting a short window as one week.
  const weeks = Math.max(
    1,
    (Date.parse(until) - Date.parse(since)) / (7 * 24 * HOUR),
  );
  const failedShare =
    health.finished === 0
      ? "n/a"
      : `${health.failed} of ${health.finished} (${Math.round((100 * health.failed) / health.finished)}%)`;
  const lines = [
    `## Delivery report since ${since.slice(0, 10)}`,
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Merged PRs (deployment frequency, until releases exist) | ${prs.length} (${(prs.length / weeks).toFixed(1)} a week) |`,
    `| Lead time, first commit to merge, p50 / p95 | ${spread(leads)} |`,
    `| Merge to green main, p50 / p95 | ${spread(toGreen)} (${toGreen.length} of ${prs.length} merges matched a green run) |`,
    `| Main runs that failed (change failure rate) | ${failedShare} |`,
    `| Time to restore green main, p50 / p95 | ${spread(health.restores)} (${health.restores.length} times) |`,
    `| Releases published | ${stable} stable, ${releases.length - stable} prerelease |`,
  ];
  if (health.redSince) {
    lines.push(
      "",
      `Main is red: its runs have failed since ${health.redSince}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** One JSON value per line, as `gh api --paginate --jq` prints them. */
function jsonLines(text) {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function fetchReport(days) {
  const repo =
    process.env.GITHUB_REPOSITORY ||
    gh([
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "--jq",
      ".nameWithOwner",
    ]).trim();
  const windowStart = new Date(Date.now() - days * 24 * HOUR).toISOString();
  const since =
    windowStart > FIRST_EXECUTED_RUN ? windowStart : FIRST_EXECUTED_RUN;

  const query = `query($q: String!, $endCursor: String) {
    search(query: $q, type: ISSUE, first: 100, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest {
        mergedAt
        mergeCommit { oid }
        commits(first: 1) { nodes { commit { authoredDate } } }
      } }
    }
  }`;
  const prs = jsonLines(
    gh([
      "api",
      "graphql",
      "--paginate",
      "-f",
      `query=${query}`,
      "-f",
      `q=repo:${repo} is:pr is:merged base:main merged:>=${since}`,
      "--jq",
      ".data.search.nodes[]",
    ]),
  ).map((pr) => ({
    mergedAt: pr.mergedAt,
    mergeSha: pr.mergeCommit?.oid,
    firstCommitAt: pr.commits.nodes[0]?.commit.authoredDate,
  }));

  const runs = jsonLines(
    gh([
      "api",
      "--paginate",
      `repos/${repo}/actions/workflows/quality.yml/runs?branch=main&event=push&created=>=${since}&per_page=100`,
      "--jq",
      ".workflow_runs[] | {sha: .head_sha, conclusion, startedAt: .run_started_at, endedAt: .updated_at}",
    ]),
  );

  const releases = jsonLines(
    gh([
      "api",
      "--paginate",
      `repos/${repo}/releases?per_page=100`,
      "--jq",
      ".[] | select(.draft | not) | {publishedAt: .published_at, prerelease}",
    ]),
  ).filter((release) => release.publishedAt >= since);

  return { since, until: new Date().toISOString(), prs, runs, releases };
}

function main() {
  const at = process.argv.indexOf("--days");
  const days = at === -1 ? 30 : Number(process.argv[at + 1]);
  if (!Number.isInteger(days) || days < 1) {
    console.error("usage: node scripts/delivery-report.mjs [--days N]");
    process.exit(2);
  }
  const markdown = render(fetchReport(days));
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
