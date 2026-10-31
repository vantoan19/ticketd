import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { remote } from "webdriverio";

const cli = process.env.TICKETD_SMOKE_CLI;
const application = process.env.TICKETD_SMOKE_DESKTOP;
const checkout = process.env.TICKETD_SMOKE_CHECKOUT;
if (!cli || !application || !checkout) throw new Error("Missing smoke paths");
const run = (...args) =>
  JSON.parse(execFileSync(cli, args, { cwd: checkout, encoding: "utf8" }));
const open = () =>
  remote({
    hostname: "127.0.0.1",
    port: 4444,
    logLevel: "error",
    capabilities: { "tauri:options": { application } },
  });

let browser = await open();
try {
  await (
    await browser.$("p=No tickets yet.")
  ).waitForDisplayed({ timeout: 15000 });
} finally {
  await browser.deleteSession();
}
const project = run("project", "create", "Smoke project", checkout);
const ticket = run("create", "Created while desktop was closed");
assert.equal(ticket.project_id, project.id);
browser = await open();
try {
  await (
    await browser.$("button*=Created while desktop was closed")
  ).waitForDisplayed({
    timeout: 15000,
  });
} finally {
  await browser.deleteSession();
}
console.log(
  "Installed desktop reopened the CLI ticket with registered project context",
);
