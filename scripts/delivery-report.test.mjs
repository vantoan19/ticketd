import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatDuration,
  mainHealth,
  mergeToGreen,
  percentile,
} from "./delivery-report.mjs";

const run = (conclusion, startedAt, endedAt, sha = startedAt) => ({
  sha,
  conclusion,
  startedAt,
  endedAt,
});

test("percentiles use the nearest rank and are empty without data", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.equal(formatDuration(null), "n/a");
  assert.equal(formatDuration(30 * 60000), "30 min");
  assert.equal(formatDuration(3 * 3600000), "3.0 h");
  assert.equal(formatDuration(72 * 3600000), "3.0 d");
});

test("main stays red from the first failing run to the next green run", () => {
  const health = mainHealth([
    run("success", "2026-11-20T10:00:00Z", "2026-11-20T10:20:00Z"),
    run("failure", "2026-11-20T11:00:00Z", "2026-11-20T11:20:00Z"),
    run("cancelled", "2026-11-20T11:30:00Z", "2026-11-20T11:31:00Z"),
    run("failure", "2026-11-20T12:00:00Z", "2026-11-20T12:20:00Z"),
    run("success", "2026-11-20T13:00:00Z", "2026-11-20T13:30:00Z"),
    run("failure", "2026-11-20T14:00:00Z", "2026-11-20T14:20:00Z"),
  ]);
  assert.equal(health.finished, 5);
  assert.equal(health.failed, 3);
  // 11:00 to 13:30; the canceled run counts for neither side.
  assert.deepEqual(health.restores, [2.5 * 3600000]);
  assert.equal(health.redSince, "2026-11-20T14:00:00Z");
});

test("a merge counts toward merge-to-green only once its commit has a green run", () => {
  const prs = [
    { mergedAt: "2026-11-20T10:00:00Z", mergeSha: "a" },
    { mergedAt: "2026-11-20T11:00:00Z", mergeSha: "b" },
  ];
  const runs = [
    run("success", "2026-11-20T10:01:00Z", "2026-11-20T10:21:00Z", "a"),
    run("failure", "2026-11-20T11:01:00Z", "2026-11-20T11:21:00Z", "b"),
  ];
  assert.deepEqual(mergeToGreen(prs, runs), [21 * 60000]);
});
