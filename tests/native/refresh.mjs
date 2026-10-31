import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { remote } from "webdriverio";

const cli = path.resolve("target/debug/ticketd");
const runCli = (...args) =>
  JSON.parse(execFileSync(cli, args, { encoding: "utf8" }));
const browser = await remote({
  hostname: "127.0.0.1",
  port: 4444,
  logLevel: "error",
  capabilities: {
    "tauri:options": {
      application: path.resolve("target/debug/ticketd-desktop"),
    },
  },
});

try {
  const empty = await browser.$("p=No tickets match the active filters.");
  await empty.waitForDisplayed({ timeout: 15000 });
  const started = Date.now();
  const ticket = runCli("create", "Created by CLI");
  const row = await browser.$("button*=Created by CLI");
  await row.waitForDisplayed({ timeout: 10000, interval: 100 });
  console.log(`CLI creation appeared after ${Date.now() - started} ms`);
  await row.click();
  const title = await browser.$("label=Title").$("input");
  await title.waitForDisplayed();
  runCli("change", ticket.reference, "--title", "Changed by CLI");
  const changed = Date.now();
  await browser.waitUntil(
    async () => (await title.getValue()) === "Changed by CLI",
    {
      timeout: 10000,
      interval: 100,
      timeoutMsg: "Clean editor did not refresh after CLI change",
    },
  );
  console.log(`CLI update appeared after ${Date.now() - changed} ms`);

  // Commit first, then edit and request refresh before the debounce can save.
  runCli("change", ticket.reference, "--title", "External content");
  await title.setValue("My unsaved draft");
  await (await browser.$("button=Refresh")).click();
  const notice = await browser.$("button=Reload saved content");
  await notice.waitForDisplayed({ timeout: 10000 });
  assert.equal(await title.getValue(), "My unsaved draft");
  await notice.click();
  assert.equal(await title.getValue(), "External content");
  console.log("Dirty draft preserved; reload adopted external content");
} finally {
  await browser.deleteSession();
}
