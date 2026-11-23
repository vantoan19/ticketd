import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { releaseAssetNames } from "./assemble-release.mjs";
import {
  extractNotes,
  formatVersion,
  handWrittenNotes,
  retargetNotes,
  versionBumpBody,
  versionBumpLink,
} from "./release-notes.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the template names the release's own downloads and workspace format", () => {
  const notes = handWrittenNotes("0.2.0", 86);
  const downloads = [
    ...notes.matchAll(/`(ticketd[^`]*\.(?:dmg|deb|msi|tar\.gz|zip))`/g),
  ].map(([, name]) => name);
  assert.equal(downloads.length, 6);
  for (const name of downloads)
    assert.ok(releaseAssetNames("0.2.0").includes(name), name);
  assert.match(
    notes,
    /\/usr\/bin\/xattr -dr com\.apple\.quarantine \/Applications\/ticketd\.app/,
  );
  assert.match(notes, /Workspace format: 86\./);
  assert.doesNotMatch(notes, /Prerelease/);
  assert.match(handWrittenNotes("0.3.0-beta.1", 86), /\*\*Prerelease\.\*\*/);
});

test("the draft takes the hand-written notes the version-bump PR carries", () => {
  const format = formatVersion(root);
  const body = versionBumpBody("0.2.0", format);
  assert.equal(extractNotes(body), handWrittenNotes("0.2.0", format));
  assert.match(body, /close this PR and reopen it/);

  const edited = body.replace(
    /<!-- One or two sentences[^>]*-->/,
    "Faster sync.",
  );
  assert.match(extractNotes(edited), /^Faster sync\./);
});

test("a PR without the markers has no release notes", () => {
  assert.equal(extractNotes("Fixes a bug."), null);
  assert.equal(extractNotes(null), null);
  assert.equal(
    extractNotes("<!-- release-notes:start -->\n<!-- release-notes:end -->"),
    null,
  );
});

test("the fallback link opens the version-bump PR prefilled", () => {
  const link = new URL(versionBumpLink("0.2.0", "Body & notes"));
  assert.equal(
    link.pathname,
    "/vantoan19/ticketd/compare/main...release/v0.2.0",
  );
  assert.equal(link.searchParams.get("title"), "Release 0.2.0");
  assert.equal(link.searchParams.get("labels"), "release");
  assert.equal(link.searchParams.get("body"), "Body & notes");
});

test("an override keeps the authored notes and rewrites the parts that name the version", () => {
  const authored = handWrittenNotes("0.2.0", 86)
    .replace(
      "<!-- One or two sentences on what this release is for. -->",
      "Faster sync.",
    )
    .replace(
      '<!-- CLI changes that scripts or agents read, or "No CLI changes." -->',
      "No CLI changes.",
    );

  const notes = retargetNotes(authored, "0.2.1-dryrun.1");
  assert.match(notes, /^Faster sync\.\n\n> \[!NOTE\]\n> \*\*Prerelease\.\*\*/);
  assert.match(notes, /- No CLI changes\./);
  assert.match(notes, /`ticketd_0\.2\.1-dryrun\.1_x64_en-US\.msi`/);
  assert.match(notes, /blob\/v0\.2\.1-dryrun\.1\/docs\/install\.md/);
  assert.doesNotMatch(notes, /0\.2\.0/);

  // Retargeting to the same version changes nothing.
  assert.equal(retargetNotes(authored, "0.2.0"), authored);
});
