import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { remote } from "webdriverio";

const cli = path.resolve(
  process.env.TICKETD_SMOKE_CLI ?? "target/debug/ticketd",
);
const runCli = (...args) =>
  JSON.parse(execFileSync(cli, args, { encoding: "utf8" }));
const browser = await remote({
  hostname: "127.0.0.1",
  port: 4444,
  logLevel: "error",
  capabilities: {
    "tauri:options": {
      application: path.resolve(
        process.env.TICKETD_SMOKE_DESKTOP ?? "target/debug/ticketd-desktop",
      ),
    },
  },
});

const detail = () =>
  browser.$(
    'section[aria-labelledby="detail-heading"] > .detail-content:not([hidden])',
  );
try {
  const empty = await browser.$("button=Create your first ticket");
  await empty.waitForDisplayed({ timeout: 15000 });
  const started = Date.now();
  const ticket = runCli("create", "Created by CLI");
  const row = await browser.$("button*=Created by CLI");
  await row.waitForDisplayed({ timeout: 10000, interval: 100 });
  console.log(`CLI creation appeared after ${Date.now() - started} ms`);
  await row.click();
  await (await detail()).waitForDisplayed({ timeout: 10000 });
  const title = await (await detail()).$('textarea[aria-label="Title"]');
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
  await (await browser.$('[aria-label="Refresh"]')).click();
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
  await (await browser.$('[aria-label="Refresh"]')).click();
  const projectButton = await (
    await browser.$('nav[aria-label="Project scopes"]')
  ).$("button=Benchmark project");
  await projectButton.waitForDisplayed({ timeout: 10000 });
  let clock = Date.now();
  await projectButton.click();
  await browser.waitUntil(
    async () => (await projectButton.getAttribute("aria-current")) === "page",
  );
  await (
    await browser.$("button*=Benchmark ticket 999")
  ).waitForDisplayed({ timeout: 10000 });
  console.log(`Project selection: ${Date.now() - clock} ms`);
  const search = await browser.$('input[aria-label="Search tickets"]');
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
      (await (
        await (await detail()).$('textarea[aria-label="Title"]')
      ).getValue()) === "Benchmark ticket 999",
  );
  console.log(`Editor opening: ${Date.now() - clock} ms`);
  await (await (await detail()).$("button=Graph")).click();
  const graphView = await browser.$('section[aria-label="Dependency graph"]');
  await browser.waitUntil(
    async () => (await graphView.$$(".react-flow__node")).length === 50,
    { timeout: 15000 },
  );
  console.log(`50-node graph loading and layout: ${Date.now() - clock} ms`);
  const pane = await graphView.$(".react-flow__pane");
  const viewport = await graphView.$(".react-flow__viewport");
  const beforePan = await viewport.getCSSProperty("transform");
  clock = Date.now();
  await pane.scrollIntoView({ block: "center", inline: "center" });
  const gesture = await browser.execute((element) => {
    const box = element.getBoundingClientRect();
    const left = Math.max(0, box.left);
    const top = Math.max(0, box.top);
    const right = Math.min(window.innerWidth, box.right);
    const bottom = Math.min(window.innerHeight, box.bottom);
    const events = [];
    window.__graphPanEvents = events;
    for (const type of [
      "pointerdown",
      "pointermove",
      "pointerup",
      "mousedown",
      "mousemove",
      "mouseup",
    ]) {
      document.addEventListener(
        type,
        (event) => {
          events.push({
            type,
            x: event.clientX,
            y: event.clientY,
            target: event.target?.className?.toString(),
          });
        },
        { capture: true, once: type.endsWith("down") || type.endsWith("up") },
      );
    }
    // Leave room for the entire drag and verify the actual hit target, including
    // overlays and clipping, rather than assuming the pane's corner is clear.
    for (let y = Math.ceil(top + 10); y < bottom - 40; y += 10) {
      for (let x = Math.ceil(left + 10); x < right - 80; x += 10) {
        if (document.elementFromPoint(x, y) === element) {
          return { x, y, box: { left, top, right, bottom } };
        }
      }
    }
    throw new Error(
      `No unobstructed graph background: ${JSON.stringify({ left, top, right, bottom })}`,
    );
  }, pane);
  await browser
    .action("pointer")
    .move({ origin: "viewport", x: gesture.x, y: gesture.y })
    .down()
    .move({ duration: 300, x: 70, y: 30, origin: "pointer" })
    .up()
    .perform();
  const afterPan = (await viewport.getCSSProperty("transform")).value;
  if (afterPan === beforePan.value) {
    const events = await browser.execute(() => window.__graphPanEvents);
    console.error(
      "Graph pan diagnostics:",
      JSON.stringify({
        gesture,
        events,
        before: beforePan.value,
        after: afterPan,
      }),
    );
  }
  assert.notEqual(afterPan, beforePan.value);
  console.log(
    `Graph pan gesture: ${Date.now() - clock} ms (includes 300 ms gesture)`,
  );
} catch (error) {
  try {
    writeFileSync("native-failure.html", await browser.getPageSource());
    await browser.saveScreenshot("native-failure.png");
  } catch (diagnosticError) {
    console.error(
      "Could not capture native failure diagnostics",
      diagnosticError,
    );
  }
  throw error;
} finally {
  await browser.deleteSession();
}
