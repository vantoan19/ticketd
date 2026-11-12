// Compiles the bridge into one self-contained executable with Bun, so users
// need neither Node nor Bun. Usage:
//   node scripts/build-executable.mjs [bun-target]
// Targets shipped: bun-windows-x64, bun-darwin-arm64, bun-linux-x64. Without an
// argument the current platform is built. Output: dist/<tauri sidecar name>.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Bun target -> the Rust target triple Tauri appends to sidecar file names.
const TARGETS = {
  "bun-windows-x64": "x86_64-pc-windows-msvc",
  "bun-darwin-arm64": "aarch64-apple-darwin",
  "bun-linux-x64": "x86_64-unknown-linux-gnu",
};
const HOST_TARGETS = {
  "win32-x64": "bun-windows-x64",
  "darwin-arm64": "bun-darwin-arm64",
  "linux-x64": "bun-linux-x64",
};

const target =
  process.argv[2] ?? HOST_TARGETS[`${process.platform}-${process.arch}`];
const triple = TARGETS[target];
if (!triple) {
  throw new Error(
    `Unsupported target ${target}; expected ${Object.keys(TARGETS).join(", ")}`,
  );
}

const root = path.resolve(import.meta.dirname, "..");
const extension = target.includes("windows") ? ".exe" : "";
const outfile = path.join(
  root,
  "dist",
  `ticketd-chat-bridge-claude-${triple}${extension}`,
);
// The pinned Bun from devDependencies, not whichever Bun is on PATH. The npm
// package installs its native binary as bin/bun.exe on every platform.
const bun = path.join(
  path.dirname(createRequire(import.meta.url).resolve("bun/package.json")),
  "bin",
  "bun.exe",
);

execFileSync(
  bun,
  [
    "build",
    "--compile",
    `--target=${target}`,
    "--minify-syntax",
    `--outfile=${outfile}`,
    path.join(root, "src", "main.ts"),
  ],
  { cwd: root, stdio: "inherit" },
);

// The bridge always runs the user's installed Claude Code. The SDK locates its
// own copy at run time through optional per-platform packages, which a compiled
// executable does not contain; fail the build if that ever changes.
const binary = readFileSync(outfile);
const sizeMiB = statSync(outfile).size / 1024 / 1024;
if (binary.includes("manifestSignatureEnforcement") || sizeMiB > 200) {
  throw new Error(
    `${outfile} (${sizeMiB.toFixed(0)} MiB) appears to contain a bundled Claude Code`,
  );
}
console.log(`${outfile} ${sizeMiB.toFixed(1)} MiB`);
