import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const source = process.argv[2];
if (!source) throw new Error("Provide the CLI executable path");
const root = mkdtempSync(path.join(tmpdir(), "ticketd-install-"));
try {
  const bin = path.join(root, "bin");
  const checkout = path.join(root, "checkout");
  mkdirSync(bin);
  mkdirSync(checkout);
  const cli = path.join(bin, path.basename(source));
  copyFileSync(source, cli);
  const env = {
    ...process.env,
    HOME: root,
    APPDATA: path.join(root, "appdata"),
    XDG_DATA_HOME: path.join(root, "data"),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const run = (...args) =>
    execFileSync(path.basename(cli), args, {
      cwd: checkout,
      env,
      encoding: "utf8",
    });
  assert.match(run("--version"), /^ticketd \d+\.\d+\.\d+/);
  const project = JSON.parse(
    run("project", "create", "Smoke project", checkout),
  );
  const ticket = JSON.parse(run("create", "Installed CLI ticket"));
  assert.equal(ticket.project_id, project.id);
  assert.equal(
    JSON.parse(run("show", ticket.reference)).title,
    "Installed CLI ticket",
  );
  console.log(
    "Installed CLI is discoverable and uses registered project context",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
