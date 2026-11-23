import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { releaseAssetNames } from "./assemble-release.mjs";

const script = fileURLToPath(
  new URL("./assemble-release.mjs", import.meta.url),
);
const source = fileURLToPath(new URL("..", import.meta.url));
const version = "0.1.1-dryrun.1";

// The three artifacts as the Distribution workflow uploads them, without the executable bit.
const builds = {
  "ticketd-macos-arm64-abc1234": {
    [`ticketd_${version}_aarch64.dmg`]: "dmg",
    "ticketd.app.tar.gz": "app archive",
    "ticketd.app.tar.gz.sig": "mac signature",
    ticketd: "mac cli",
    "INSTALL.md": "install",
  },
  "ticketd-ubuntu-24.04-x86_64-abc1234": {
    [`ticketd_${version}_amd64.deb`]: "deb",
    [`ticketd_${version}_amd64.deb.sig`]: "deb signature",
    ticketd: "linux cli",
    "INSTALL.md": "install",
  },
  "ticketd-windows-x86_64-abc1234": {
    [`ticketd_${version}_x64_en-US.msi`]: "msi",
    [`ticketd_${version}_x64_en-US.msi.sig`]: "msi signature",
    "ticketd.exe": "windows cli",
    "INSTALL.md": "install",
  },
};

function fixture(t, omit) {
  const root = mkdtempSync(join(tmpdir(), "ticketd-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [artifact, files] of Object.entries(builds)) {
    mkdirSync(join(root, "artifacts", artifact), { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      if (name !== omit)
        writeFileSync(join(root, "artifacts", artifact, name), contents, {
          mode: 0o644,
        });
    }
  }
  const out = join(root, "release");
  const assemble = () =>
    spawnSync(
      process.execPath,
      [
        script,
        "--version",
        version,
        "--artifacts",
        join(root, "artifacts"),
        "--source",
        source,
        "--out",
        out,
        "--date",
        "2026-11-23T00:00:00Z",
      ],
      { encoding: "utf8" },
    );
  return { out, assemble };
}

const listing = (command, args) =>
  spawnSync(command, args, { encoding: "utf8" }).stdout;

test("assembles the release files the v0.1.0 draft had, with matching checksums", (t) => {
  const { out, assemble } = fixture(t);
  const result = assemble();
  assert.equal(result.status, 0, result.stderr);

  const names = readdirSync(out).sort();
  assert.equal(names.length, 15);
  assert.deepEqual(names, releaseAssetNames(version));
  assert.equal(
    readFileSync(join(out, `ticketd_${version}_aarch64.app.tar.gz`), "utf8"),
    "app archive",
  );
  assert.equal(
    readFileSync(
      join(out, `ticketd_${version}_aarch64.app.tar.gz.sig`),
      "utf8",
    ),
    "mac signature",
  );
  assert.equal(
    readFileSync(join(out, "INSTALL.md"), "utf8"),
    readFileSync(join(source, "docs/install.md"), "utf8"),
  );

  const sums = names
    .filter((name) => name !== "SHA256SUMS")
    .map(
      (name) =>
        `${createHash("sha256")
          .update(readFileSync(join(out, name)))
          .digest("hex")}  ${name}\n`,
    )
    .join("");
  assert.equal(readFileSync(join(out, "SHA256SUMS"), "utf8"), sums);

  const manifest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
  assert.equal(manifest.version, version);
  assert.equal(
    manifest.platforms["darwin-aarch64"].url,
    `https://github.com/vantoan19/ticketd/releases/download/v${version}/ticketd_${version}_aarch64.app.tar.gz`,
  );

  for (const platform of ["macos-arm64", "linux-x86_64"]) {
    const entries = listing("tar", [
      "-tvzf",
      join(out, `ticketd-cli-${version}-${platform}.tar.gz`),
    ])
      .trim()
      .split("\n");
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^-rwxr-xr-x .* ticketd$/);
  }
  const zip = listing("unzip", [
    "-Z1",
    join(out, `ticketd-cli-${version}-windows-x86_64.zip`),
  ]);
  assert.equal(zip, "ticketd.exe\n");
});

test("refuses a build without an updater signature", (t) => {
  const { assemble } = fixture(t, `ticketd_${version}_amd64.deb.sig`);
  const result = assemble();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing .*amd64\.deb\.sig/);
});

test("refuses a build without the installer for the release version", (t) => {
  const { assemble } = fixture(t, `ticketd_${version}_x64_en-US.msi`);
  const result = assemble();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing .*x64_en-US\.msi/);
});
