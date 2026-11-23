// Assembles a release's files from the three Distribution build artifacts:
//
//   node scripts/assemble-release.mjs --version 0.2.0 --artifacts <dir> --source <checkout> --out <dir>
//
// <artifacts> holds one directory per platform as the Distribution workflow uploads them
// (ticketd-macos-arm64-<sha>, ...). <source> is a checkout of the build commit: its documents
// and its generate-latest.mjs, which reads that commit's workspace format, are released.
// The result is exactly releaseAssetNames(version), ending with SHA256SUMS over the rest.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseVersion } from "./release-version.mjs";

const platforms = (version) => [
  {
    artifact: "ticketd-macos-arm64",
    installer: `ticketd_${version}_aarch64.dmg`,
    // The macOS updater file is a separate archive of the app; the installer is the updater
    // file elsewhere. It is renamed so each release's files are distinct; its signature covers
    // the bytes, not the name.
    updater: ["ticketd.app.tar.gz", `ticketd_${version}_aarch64.app.tar.gz`],
    cli: "ticketd",
    archive: `ticketd-cli-${version}-macos-arm64.tar.gz`,
  },
  {
    artifact: "ticketd-ubuntu-24.04-x86_64",
    installer: `ticketd_${version}_amd64.deb`,
    cli: "ticketd",
    archive: `ticketd-cli-${version}-linux-x86_64.tar.gz`,
  },
  {
    artifact: "ticketd-windows-x86_64",
    installer: `ticketd_${version}_x64_en-US.msi`,
    cli: "ticketd.exe",
    archive: `ticketd-cli-${version}-windows-x86_64.zip`,
  },
];

const documents = [
  ["LICENSE", "LICENSE"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["docs/install.md", "INSTALL.md"],
];

export const checksumFile = "SHA256SUMS";

// Byte order, as `sort` in the C locale and `shasum` listings use.
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function releaseAssetNames(version) {
  const names = [
    ...documents.map(([, name]) => name),
    "latest.json",
    checksumFile,
  ];
  for (const platform of platforms(version)) {
    const updater = platform.updater?.[1] ?? platform.installer;
    names.push(platform.installer, platform.archive, `${updater}.sig`);
    if (platform.updater) names.push(updater);
  }
  return names.sort(byName);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error)
    throw new Error(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr.trim()}`,
    );
  }
  return result;
}

function artifactDirectory(artifacts, name) {
  const matches = readdirSync(artifacts, { withFileTypes: true }).filter(
    (entry) =>
      entry.isDirectory() &&
      (entry.name === name || entry.name.startsWith(`${name}-`)),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${name} artifact in ${artifacts}, found ${matches.length}`,
    );
  }
  return join(artifacts, matches[0].name);
}

function copyRequired(from, to) {
  if (!existsSync(from)) throw new Error(`Missing ${from}`);
  copyFileSync(from, to);
}

// The standalone CLI archive holds only the executable, at its root, mode 0755. Artifact
// downloads drop the executable bit, so it is restored here.
function archiveCli(binary, name, out) {
  const stage = mkdtempSync(join(tmpdir(), "ticketd-cli-"));
  try {
    const file = binary.endsWith(".exe") ? "ticketd.exe" : "ticketd";
    copyRequired(binary, join(stage, file));
    chmodSync(join(stage, file), 0o755);
    const archive = resolve(out, name);
    if (name.endsWith(".zip"))
      run("zip", ["-q", "-X", archive, file], { cwd: stage });
    else run("tar", ["-czf", archive, "-C", stage, file]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function checksums(directory) {
  return readdirSync(directory)
    .filter((name) => name !== checksumFile)
    .sort(byName)
    .map((name) => {
      const digest = createHash("sha256")
        .update(readFileSync(join(directory, name)))
        .digest("hex");
      return `${digest}  ${name}\n`;
    })
    .join("");
}

export function assemble({ version, artifacts, source, out, pubDate }) {
  parseVersion(version);
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`${out} is not empty`);
  }
  mkdirSync(out, { recursive: true });

  for (const platform of platforms(version)) {
    const directory = artifactDirectory(artifacts, platform.artifact);
    copyRequired(
      join(directory, platform.installer),
      join(out, platform.installer),
    );
    const [built, released] = platform.updater ?? [
      platform.installer,
      platform.installer,
    ];
    if (platform.updater)
      copyRequired(join(directory, built), join(out, released));
    copyRequired(join(directory, `${built}.sig`), join(out, `${released}.sig`));
    archiveCli(join(directory, platform.cli), platform.archive, out);
  }
  for (const [from, to] of documents)
    copyRequired(join(source, from), join(out, to));

  run(process.execPath, [
    join(source, "scripts/generate-latest.mjs"),
    version,
    pubDate,
    out,
  ]);

  writeFileSync(join(out, checksumFile), checksums(out));
  const actual = readdirSync(out).sort(byName);
  const expected = releaseAssetNames(version);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Release files differ from the expected set.\nExpected: ${expected.join(", ")}\nFound: ${actual.join(", ")}`,
    );
  }
  return actual;
}

function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      artifacts: { type: "string" },
      source: { type: "string" },
      out: { type: "string" },
      date: { type: "string" },
    },
  });
  for (const key of ["version", "artifacts", "source", "out"]) {
    if (!values[key]) {
      throw new Error(
        "Usage: node scripts/assemble-release.mjs --version <v> --artifacts <dir> --source <checkout> --out <dir> [--date <RFC3339>]",
      );
    }
  }
  const pubDate =
    values.date ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const files = assemble({ ...values, pubDate });
  console.log(`Assembled ${files.length} release files in ${values.out}:`);
  for (const file of files) console.log(`  ${file}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
