import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { once } from "node:events";

const target = process.env.TAURI_ENV_TARGET_TRIPLE;
if (!target) throw new Error("Tauri did not provide a target triple");
const host = execFileSync("rustc", ["--print", "host-tuple"], {
  encoding: "utf8",
}).trim();
const cargo = spawn(
  "cargo",
  [
    "build",
    "--locked",
    "-p",
    "ticketd-cli",
    "--message-format=json-render-diagnostics",
    ...(target === host ? [] : ["--target", target]),
    ...(process.env.TAURI_ENV_DEBUG === "true" ? [] : ["--release"]),
  ],
  { stdio: ["ignore", "pipe", "inherit"] },
);
const exit = once(cargo, "close");
let executable;
for await (const line of readline.createInterface({ input: cargo.stdout })) {
  const event = JSON.parse(line);
  if (event.reason === "compiler-artifact" && event.target.name === "ticketd") {
    executable = event.executable;
  } else if (event.reason === "compiler-message" && event.message.rendered) {
    process.stderr.write(event.message.rendered);
  }
}
const [code] = await exit;
if (code !== 0 || !executable) {
  throw new Error("Cargo did not produce the ticketd CLI");
}

const destination = path.resolve(
  import.meta.dirname,
  "../../../crates/ticketd-cli/dist",
);
mkdirSync(destination, { recursive: true });
copyFileSync(
  executable,
  path.join(destination, `ticketd-${target}${path.extname(executable)}`),
);
