import tauri from "@tauri-apps/cli";
import process from "node:process";

const args = process.argv.slice(2);
if (args[0] === "build" || args[0] === "bundle") {
  // Cargo-only checks need the bridge, but don't need to build a second package
  // before they can compile the desktop crate.
  args.splice(1, 0, "--config", "src-tauri/tauri.bundled-cli.json");
}

await tauri.run(args, "npm run desktop --");
