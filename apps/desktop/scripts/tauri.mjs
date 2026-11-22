import tauri from "@tauri-apps/cli";
import process from "node:process";

const args = process.argv.slice(2);
// Tauri's global flags (such as `--verbose`) may come before the subcommand.
const command = args.findIndex((arg) => !arg.startsWith("-"));
if (args[command] === "build" || args[command] === "bundle") {
  // Cargo-only checks need the bridge, but don't need to build a second package
  // before they can compile the desktop crate.
  args.splice(command + 1, 0, "--config", "src-tauri/tauri.bundled-cli.json");
}

await tauri.run(args, "npm run desktop --");
