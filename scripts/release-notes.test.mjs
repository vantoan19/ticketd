import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { releaseAssetNames } from "./assemble-release.mjs";
import {
  extractNotes,
  formatVersion,
  handWrittenNotes,
  versionBumpBody,
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
