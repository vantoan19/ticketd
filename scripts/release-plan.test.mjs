import assert from "node:assert/strict";
import { test } from "node:test";
import { planDraft } from "./release-plan.mjs";

const sha = "a".repeat(40);
const other = "b".repeat(40);
const published = {
  id: 1,
  tag_name: "v0.1.0",
  draft: false,
  target_commitish: "main",
};
const auto = (version, releases) =>
  planDraft({ mode: "auto", sha, version, releases });
const manual = (version, releases, checks = {}) =>
  planDraft({
    mode: "manual",
    sha,
    version,
    releases,
    onMain: true,
    green: true,
    ...checks,
  });

test("a green main commit whose version is published is built but not drafted", () => {
  const plan = auto("0.1.0", [published]);
  assert.equal(plan.draft, false);
  assert.match(plan.reason, /already published/);
});

test("a version-bump commit creates its draft", () => {
  assert.deepEqual(auto("0.1.1", [published]), {
    draft: true,
    tag: "v0.1.1",
    version: "0.1.1",
    prerelease: false,
    replace: [],
    reason: `Creating the draft v0.1.1 from ${sha}.`,
  });
});

test("a later commit leaves a draft built from another commit alone", () => {
  const draft = {
    id: 7,
    tag_name: "v0.1.1",
    draft: true,
    target_commitish: other,
  };
  const plan = auto("0.1.1", [published, draft]);
  assert.equal(plan.draft, false);
  assert.match(plan.reason, /may be under test/);
});

test("rerunning the same commit replaces its own draft", () => {
  const draft = {
    id: 7,
    tag_name: "v0.1.1",
    draft: true,
    target_commitish: sha,
  };
  assert.deepEqual(auto("0.1.1", [published, draft]).replace, [7]);
});

test("a manual run replaces any draft of the version and marks a prerelease", () => {
  const drafts = [
    {
      id: 7,
      tag_name: "v0.1.1-dryrun.1",
      draft: true,
      target_commitish: other,
    },
    { id: 8, tag_name: "v0.1.1", draft: true, target_commitish: other },
  ];
  const plan = manual("0.1.1-dryrun.1", [published, ...drafts]);
  assert.equal(plan.draft, true);
  assert.equal(plan.prerelease, true);
  assert.deepEqual(plan.replace, [7]);
});

test("a manual run refuses a published, older or invalid version", () => {
  assert.throws(() => manual("0.1.0", [published]), /already published/);
  assert.throws(() => manual("0.0.9", [published]), /not newer/);
  assert.throws(() => manual("v0.1.1", [published]), /not a release version/);
});

test("a manual run refuses a commit that is not a green main commit", () => {
  assert.throws(
    () => manual("0.1.1", [published], { onMain: false }),
    /not on main/,
  );
  assert.throws(
    () => manual("0.1.1", [published], { green: false }),
    /Quality has not passed/,
  );
});
