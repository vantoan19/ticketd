import assert from "node:assert/strict";
import { test } from "node:test";
import { planDraft, resolveTag } from "./release-plan.mjs";

const sha = "a".repeat(40);
const other = "b".repeat(40);
const published = {
  id: 1,
  tag_name: "v0.1.0",
  draft: false,
  target_commitish: "main",
};
const auto = (version, releases, checks = {}) =>
  planDraft({ mode: "auto", sha, version, releases, ...checks });
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
    reason: `Creating the draft v0.1.1 from ${sha}.`,
  });
});

test("an existing draft is never replaced, even for the same commit", () => {
  for (const target of [sha, other]) {
    const draft = {
      id: 7,
      tag_name: "v0.1.1",
      draft: true,
      target_commitish: target,
    };
    const plan = auto("0.1.1", [published, draft]);
    assert.equal(plan.draft, false);
    assert.match(plan.reason, /delete that draft on the Releases page/);
    assert.throws(
      () => manual("0.1.1", [published, draft]),
      /delete that draft/,
    );
  }
});

test("a manual dry run marks a prerelease and ignores other versions' drafts", () => {
  const draft = {
    id: 8,
    tag_name: "v0.1.1",
    draft: true,
    target_commitish: other,
  };
  const plan = manual("0.1.1-dryrun.1", [published, draft]);
  assert.equal(plan.draft, true);
  assert.equal(plan.prerelease, true);
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

test("resolves a tag to its commit through annotated tag objects", () => {
  const api = {
    "git/ref/tags/v0.1.1": { object: { type: "tag", sha: "t1" } },
    "git/tags/t1": { object: { type: "tag", sha: "t2" } },
    "git/tags/t2": { object: { type: "commit", sha } },
    "git/ref/tags/v0.1.2": { object: { type: "commit", sha: other } },
    "git/ref/tags/v0.1.3": { object: { type: "tree", sha: other } },
  };
  const read = (path) => api[path] ?? null;
  assert.equal(resolveTag("v0.1.1", read), sha);
  assert.equal(resolveTag("v0.1.2", read), other);
  assert.equal(resolveTag("v0.1.9", read), null);
  assert.throws(() => resolveTag("v0.1.3", read), /not a commit/);
});

test("refuses a version whose tag already points at another commit", () => {
  assert.throws(
    () => manual("0.1.1", [published], { tagCommit: other }),
    /already exists at b{40}, not at a{40}/,
  );
  assert.equal(auto("0.1.1", [published], { tagCommit: other }).draft, false);
  assert.equal(manual("0.1.1", [published], { tagCommit: sha }).draft, true);
  assert.equal(manual("0.1.1", [published], { tagCommit: null }).draft, true);
});
