import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkBump,
  compareVersions,
  parseVersion,
  setVersion,
  tauriBuildConfig,
} from "./release-version.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("orders versions by SemVer precedence", () => {
  const ordered = [
    "0.1.0",
    "0.1.1-alpha",
    "0.1.1-alpha.1",
    "0.1.1-alpha.beta",
    "0.1.1-beta.2",
    "0.1.1-beta.11",
    "0.1.1-dryrun.1",
    "0.1.1-rc.1",
    "0.1.1",
    "0.2.0",
    "0.10.0",
    "1.0.0",
  ];
  const shuffled = [...ordered].reverse();
  assert.deepEqual(shuffled.sort(compareVersions), ordered);
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
});

test("rejects versions that cannot name a release", () => {
  for (const version of ["v0.2.0", "0.2", "0.2.0+1", "01.2.0", "0.2.0-", ""]) {
    assert.throws(() => parseVersion(version), /not a release version/);
  }
});

test("a bump must be newer than every published release, prereleases included", () => {
  const releases = [
    { tag_name: "v0.1.0", draft: false },
    { tag_name: "v0.2.0-beta.1", draft: false, prerelease: true },
    { tag_name: "v0.9.0", draft: true },
  ];
  assert.deepEqual(checkBump("0.2.0", releases), {
    version: "0.2.0",
    latest: "0.2.0-beta.1",
  });
  assert.throws(() => checkBump("0.2.0-beta.1", releases), /not newer/);
  assert.throws(() => checkBump("0.1.1", releases), /not newer/);
  assert.equal(checkBump("0.1.0", []).latest, null);
});

test("gives a prerelease that Windows Installer cannot read an explicit MSI version", () => {
  assert.deepEqual(tauriBuildConfig("0.2.0", ""), {});
  assert.deepEqual(tauriBuildConfig("0.2.0-1", ""), {});
  assert.deepEqual(tauriBuildConfig("0.1.1-dryrun.1", " key\n"), {
    bundle: {
      windows: { wix: { version: "0.1.1" } },
      createUpdaterArtifacts: true,
    },
    plugins: { updater: { pubkey: "key" } },
  });
});

function copyVersionFiles(t) {
  const copy = mkdtempSync(join(tmpdir(), "ticketd-version-"));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  const cargo = readFileSync(join(root, "Cargo.toml"), "utf8");
  const members = [
    ...cargo.match(/^members\s*=\s*\[([^\]]*)\]/m)[1].matchAll(/"([^"]+)"/g),
  ].map(([, path]) => `${path}/Cargo.toml`);
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "package.json",
    "package-lock.json",
    "apps/desktop/package.json",
    "apps/chat-bridge-claude/package.json",
    "apps/desktop/src-tauri/tauri.conf.json",
    ...members,
  ]) {
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    cpSync(join(root, file), join(copy, file));
  }
  return { copy, members: members.length };
}

function changedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  assert.equal(a.length, b.length);
  return a.filter((line, i) => line !== b[i]).length;
}

test("sets the version in every version file and only the workspace's own lockfile entries", (t) => {
  const { copy, members } = copyVersionFiles(t);
  setVersion(copy, "0.1.1-dryrun.1");

  const changes = {
    "Cargo.toml": 1,
    "Cargo.lock": members,
    "package.json": 1,
    "package-lock.json": 4,
    "apps/desktop/package.json": 1,
    "apps/chat-bridge-claude/package.json": 1,
    "apps/desktop/src-tauri/tauri.conf.json": 1,
  };
  for (const [file, count] of Object.entries(changes)) {
    const after = readFileSync(join(copy, file), "utf8");
    assert.equal(
      changedLines(readFileSync(join(root, file), "utf8"), after),
      count,
      file,
    );
    assert.match(after, /"?version"?\s*[:=]\s*"0\.1\.1-dryrun\.1"/, file);
  }
  assert.throws(() => setVersion(copy, "v0.2.0"), /not a release version/);
});
