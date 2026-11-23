import { readFileSync } from "node:fs";

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const cargo = readFileSync("Cargo.toml", "utf8");
const version = cargo.match(
  /\[workspace\.package\]\s*version\s*=\s*"([^"]+)"/,
)?.[1];
if (!version) throw new Error("Missing Cargo workspace version");
// The root package, every npm workspace, and the desktop's Tauri configuration, as
// scripts/release-version.mjs sets them.
for (const file of [
  "package.json",
  ...(json("package.json").workspaces ?? []).map(
    (path) => `${path}/package.json`,
  ),
  "apps/desktop/src-tauri/tauri.conf.json",
]) {
  if (json(file).version !== version) {
    throw new Error(
      `${file} version must match Cargo workspace version ${version}`,
    );
  }
}
console.log(`Package versions agree: ${version}`);
