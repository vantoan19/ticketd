// Release versions: SemVer parsing and ordering, the version-bump check, and writing one
// version into every file that carries it. Used by the Version bump and Release workflows.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

// SemVer 2.0 without build metadata: a `+build` suffix cannot appear in a tag, an MSI version
// or the updater's comparison, so a release version never has one.
const identifier = String.raw`(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const semver = new RegExp(
  String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(${identifier}(?:\.${identifier})*))?$`,
);

export function parseVersion(text) {
  const match = semver.exec(String(text));
  if (!match) {
    throw new Error(
      `"${text}" is not a release version. Use SemVer such as 0.2.0 or 0.3.0-beta.1, without a leading v or build metadata.`,
    );
  }
  const [, major, minor, patch, prerelease] = match;
  // BigInt, so identifiers beyond 2^53 still compare exactly.
  return {
    major: BigInt(major),
    minor: BigInt(minor),
    patch: BigInt(patch),
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

// SemVer precedence: a prerelease sorts before its release; numeric identifiers sort numerically
// and before alphanumeric ones.
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return b.prerelease.length - a.prerelease.length;
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export const isPrerelease = (version) =>
  parseVersion(version).prerelease.length > 0;

// The highest version among published (non-draft) releases, prereleases included.
export function latestPublished(releases) {
  let latest = null;
  for (const release of releases) {
    if (release.draft || !release.tag_name?.startsWith("v")) continue;
    const version = release.tag_name.slice(1);
    try {
      parseVersion(version);
    } catch {
      continue;
    }
    if (latest === null || compareVersions(version, latest) > 0)
      latest = version;
  }
  return latest;
}

export function checkBump(version, releases) {
  parseVersion(version);
  const latest = latestPublished(releases);
  if (latest !== null && compareVersions(version, latest) <= 0) {
    throw new Error(
      `${version} is not newer than the latest published release, v${latest}.`,
    );
  }
  return { version, latest };
}

// Windows Installer versions are numeric. Tauri derives one from a plain version or a numeric
// prerelease (0.2.0-1 becomes 0.2.0.1) and refuses anything else, so a version such as
// 0.3.0-beta.1 needs an explicit MSI version. Windows Installer ignores the fourth field when
// comparing, so the prerelease installs as its release version would.
export function msiVersion(version) {
  const { major, minor, patch, prerelease } = parseVersion(version);
  if (prerelease.length === 0) return null;
  if (
    prerelease.length === 1 &&
    /^\d+$/.test(prerelease[0]) &&
    BigInt(prerelease[0]) <= 65535n
  ) {
    return null;
  }
  return `${major}.${minor}.${patch}`;
}

// Tauri configuration merged into tauri.conf.json for a distribution build.
export function tauriBuildConfig(version, updaterPublicKey) {
  const config = {};
  const msi = msiVersion(version);
  if (msi) config.bundle = { windows: { wix: { version: msi } } };
  if (updaterPublicKey) {
    config.bundle = { ...config.bundle, createUpdaterArtifacts: true };
    config.plugins = { updater: { pubkey: updaterPublicKey.trim() } };
  }
  return config;
}

const packageFiles = [
  "package.json",
  "apps/desktop/package.json",
  "apps/chat-bridge-claude/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
];

// Replaces the top-level "version" field without reformatting the rest of the file.
function setJsonVersion(text, file, version) {
  const next = text.replace(
    /^( {2}"version": )"[^"]*"/m,
    `$1${JSON.stringify(version)}`,
  );
  const before = JSON.parse(text);
  const after = JSON.parse(next);
  if (
    after.version !== version ||
    JSON.stringify({ ...before, version }) !== JSON.stringify(after)
  ) {
    throw new Error(`Cannot find the top-level version in ${file}`);
  }
  return next;
}

function workspaceMembers(root, cargo) {
  const members = cargo.match(/^members\s*=\s*\[([^\]]*)\]/m)?.[1];
  if (!members) throw new Error("Missing Cargo workspace members");
  return [...members.matchAll(/"([^"]+)"/g)].map(([, path]) => {
    const manifest = readFileSync(join(root, path, "Cargo.toml"), "utf8");
    const name = manifest.match(/^\[package\]\s*\nname\s*=\s*"([^"]+)"/m)?.[1];
    if (!name) throw new Error(`Missing package name in ${path}/Cargo.toml`);
    return name;
  });
}

// Sets one version in every file check-versions.mjs compares, plus the lockfiles' entries for
// the workspace's own packages. Nothing else in a lockfile changes, so no dependency moves.
export function setVersion(root, version) {
  parseVersion(version);
  const read = (file) => readFileSync(join(root, file), "utf8");
  const write = (file, text) => writeFileSync(join(root, file), text);

  const cargo = read("Cargo.toml");
  const cargoVersion = /(\[workspace\.package\][^[]*?^version\s*=\s*)"[^"]*"/m;
  if (!cargoVersion.test(cargo))
    throw new Error("Cannot find the Cargo workspace version");
  write("Cargo.toml", cargo.replace(cargoVersion, `$1"${version}"`));

  const members = new Set(workspaceMembers(root, cargo));
  const found = new Set();
  const lock = read("Cargo.lock").replace(
    /\[\[package\]\]\nname = "([^"]+)"\nversion = "[^"]*"\n(?!source = )/g,
    (block, name) => {
      if (!members.has(name)) return block;
      found.add(name);
      return `[[package]]\nname = "${name}"\nversion = "${version}"\n`;
    },
  );
  for (const name of members) {
    if (!found.has(name))
      throw new Error(`Cargo.lock has no workspace entry for ${name}`);
  }
  write("Cargo.lock", lock);

  for (const file of packageFiles)
    write(file, setJsonVersion(read(file), file, version));

  const npmLock = JSON.parse(read("package-lock.json"));
  const workspaces = JSON.parse(read("package.json")).workspaces ?? [];
  npmLock.version = version;
  for (const path of ["", ...workspaces]) {
    const entry = npmLock.packages?.[path];
    if (!entry) throw new Error(`package-lock.json has no entry for "${path}"`);
    entry.version = version;
  }
  write("package-lock.json", `${JSON.stringify(npmLock, null, 2)}\n`);
}

export function readAppVersion(root) {
  return JSON.parse(
    readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  ).version;
}

export function gh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// Every release of the repository, drafts included when the token can see them.
export function listReleases(repository) {
  return gh([
    "api",
    "--paginate",
    `repos/${repository}/releases?per_page=100`,
    "--jq",
    ".[] | {id, tag_name, draft, prerelease, target_commitish}",
  ])
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function main(args) {
  const [command, ...rest] = args;
  const repository = process.env.GITHUB_REPOSITORY ?? "vantoan19/ticketd";
  switch (command) {
    case "check-bump": {
      const { version, latest } = checkBump(rest[0], listReleases(repository));
      console.log(
        `${version} is newer than the latest published release${latest ? `, v${latest}` : ""}.`,
      );
      return;
    }
    case "set":
      setVersion(repositoryRoot, rest[0]);
      console.log(`Set the version to ${rest[0]}.`);
      return;
    case "tauri-config": {
      const [output, flag] = rest;
      const key =
        flag === "--updater" ? process.env.TAURI_UPDATER_PUBLIC_KEY : "";
      if (flag === "--updater" && !key?.trim())
        throw new Error("TAURI_UPDATER_PUBLIC_KEY is empty");
      const config = tauriBuildConfig(readAppVersion(repositoryRoot), key);
      writeFileSync(output, `${JSON.stringify(config)}\n`);
      return;
    }
    default:
      throw new Error(
        "Usage: node scripts/release-version.mjs check-bump <version> | set <version> | tauri-config <output> [--updater]",
      );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
