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

  const project = runCli(
    "project",
    "create",
    "Benchmark project",
    process.cwd(),
  );
  let tickets;
  for (let batch = 0; batch < 10; batch++) {
    const operations = Array.from({ length: 100 }, (_, i) => ({
      operation: "create",
      name: `ticket${i}`,
      title: `Benchmark ticket ${batch * 100 + i}`,
      project_id: project.id,
    }));
    tickets = JSON.parse(
      execFileSync(cli, ["batch", "-"], {
        input: JSON.stringify(operations),
        encoding: "utf8",
      }),
    );
  }
  const root = tickets.at(-1);
  execFileSync(cli, ["batch", "-"], {
    input: JSON.stringify([
      {
        operation: "change",
        ticket: root.reference,
        change: {
          add_blockers: tickets.slice(0, 49).map((item) => item.reference),
        },
      },
    ]),
  });
  await (await browser.$("button=Refresh")).click();
  const projectButton = await browser.$("button=Benchmark project");
  await projectButton.waitForDisplayed({ timeout: 10000 });
  let clock = Date.now();
  await projectButton.click();
  await browser.waitUntil(
    async () => (await projectButton.getAttribute("aria-pressed")) === "true",
  );
  await (
    await browser.$("button*=Benchmark ticket 999")
  ).waitForDisplayed({ timeout: 10000 });
  console.log(`Project selection: ${Date.now() - clock} ms`);
  const search = await browser.$("label=Search tickets").$("input");
  clock = Date.now();
  await search.setValue("Benchmark ticket 999");
  await browser.waitUntil(
    async () =>
      (await browser.$$("button*=Benchmark ticket 998")).length === 0 &&
      (await browser.$$("button*=Benchmark ticket 999")).length === 1,
  );
  console.log(`Search: ${Date.now() - clock} ms`);
  clock = Date.now();
  await (await browser.$("button*=Benchmark ticket 999")).click();
  await browser.waitUntil(
    async () =>
      (await (await browser.$("label=Title").$("input")).getValue()) ===
      "Benchmark ticket 999",
  );
  console.log(`Editor opening: ${Date.now() - clock} ms`);
  await browser.waitUntil(
    async () =>
      (await browser.$$("[aria-label='Graph tickets'] li")).length === 50,
    { timeout: 15000 },
  );
  console.log(`50-node graph loading and layout: ${Date.now() - clock} ms`);
  const pane = await browser.$(".react-flow__pane");
  const viewport = await browser.$(".react-flow__viewport");
  const beforePan = await viewport.getCSSProperty("transform");
  clock = Date.now();
  const paneSize = await pane.getSize();
  // The center can be covered by a graph node; start on empty pane background.
  await pane.moveTo({
    xOffset: -Math.floor(paneSize.width / 2) + 10,
    yOffset: -Math.floor(paneSize.height / 2) + 10,
  });
  await browser
    .action("pointer")
    .down()
    .move({ duration: 300, x: 70, y: 30, origin: "pointer" })
    .up()
    .perform();
  assert.notEqual(
    (await viewport.getCSSProperty("transform")).value,
    beforePan.value,
  );
  console.log(
    `Graph pan gesture: ${Date.now() - clock} ms (includes 300 ms gesture)`,
  );
} finally {
  await browser.deleteSession();
}
