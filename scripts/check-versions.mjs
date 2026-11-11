import { readFileSync } from "node:fs";

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const cargo = readFileSync("Cargo.toml", "utf8");
const version = cargo.match(
  /\[workspace\.package\]\s*version\s*=\s*"([^"]+)"/,
)?.[1];
if (!version) throw new Error("Missing Cargo workspace version");
for (const file of [
  "package.json",
  "apps/desktop/package.json",
  "apps/chat-bridge-claude/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
]) {
  if (json(file).version !== version) {
    throw new Error(
      `${file} version must match Cargo workspace version ${version}`,
    );
  }
}
console.log(`Package versions agree: ${version}`);
