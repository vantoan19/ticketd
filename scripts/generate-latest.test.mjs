import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./generate-latest.mjs", import.meta.url));
const mac = "ticketd.app.tar.gz";
const linux = "ticketd_0.2.0_amd64.deb";
const windows = "ticketd_0.2.0_x64_en-US.msi";

function releaseAssets(t, assets) {
  const directory = mkdtempSync(join(tmpdir(), "ticketd-updater-assets-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [filename, contents] of Object.entries(assets)) {
    writeFileSync(join(directory, filename), contents);
  }
  return {
    manifest: join(directory, "latest.json"),
    generate: () =>
      spawnSync(
        process.execPath,
        [script, "0.2.0", "2026-11-22T01:00:00Z", directory],
        {
          encoding: "utf8",
        },
      ),
  };
}

test("publishes the signature and versioned download URL for each updater target", (t) => {
  const { generate, manifest } = releaseAssets(t, {
    [mac]: "archive",
    [`${mac}.sig`]: "mac signature\n",
    [linux]: "Debian installer",
    [`${linux}.sig`]: "deb signature",
    [windows]: "Windows installer",
    [`${windows}.sig`]: "msi signature",
    "ticketd_0.2.0_aarch64.dmg": "Mac installer",
  });

  const result = generate();
  assert.equal(result.status, 0, result.stderr);
  const macUpdate = {
    signature: "mac signature",
    url: "https://github.com/vantoan19/ticketd/releases/download/v0.2.0/ticketd.app.tar.gz",
  };
  const linuxUpdate = {
    signature: "deb signature",
    url: "https://github.com/vantoan19/ticketd/releases/download/v0.2.0/ticketd_0.2.0_amd64.deb",
  };
  const windowsUpdate = {
    signature: "msi signature",
    url: "https://github.com/vantoan19/ticketd/releases/download/v0.2.0/ticketd_0.2.0_x64_en-US.msi",
  };
  assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")), {
    version: "0.2.0",
    pub_date: "2026-11-22T01:00:00Z",
    notes: "https://github.com/vantoan19/ticketd/releases/tag/v0.2.0",
    platforms: {
      "darwin-aarch64": macUpdate,
      "linux-x86_64-deb": linuxUpdate,
      "linux-x86_64": linuxUpdate,
      "windows-x86_64-msi": windowsUpdate,
      "windows-x86_64": windowsUpdate,
    },
  });
});

test("refuses an unsigned installer and leaves no manifest to upload", (t) => {
  const { generate, manifest } = releaseAssets(t, {
    [mac]: "archive",
    [`${mac}.sig`]: "mac signature",
    [linux]: "Debian installer",
    [windows]: "Windows installer",
    [`${windows}.sig`]: "msi signature",
    "latest.json": "manifest from a previous attempt",
  });

  const result = generate();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ticketd_0\.2\.0_amd64\.deb\.sig/);
  assert.equal(existsSync(manifest), false);
});

test("skips the manifest with a warning when signing was disabled for every build", (t) => {
  const { generate, manifest } = releaseAssets(t, {
    [linux]: "Debian installer",
    [windows]: "Windows installer",
    "ticketd_0.2.0_aarch64.dmg": "Mac installer",
  });

  const result = generate();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /skipping latest\.json/i);
  assert.equal(existsSync(manifest), false);
});
