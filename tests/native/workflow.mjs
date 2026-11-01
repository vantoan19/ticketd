import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { remote } from "webdriverio";

const {
  TICKETD_SMOKE_CLI: cli,
  TICKETD_SMOKE_DESKTOP: application,
  TICKETD_SMOKE_CHECKOUT: checkout,
  XDG_DATA_HOME: data,
} = process.env;
if (!cli || !application || !checkout || !data)
  throw new Error("Missing workflow paths");
const command = (args, input) =>
  execFileSync(cli, args, { cwd: checkout, encoding: "utf8", input });
const run = (...args) => JSON.parse(command(args));
const project = run("project", "create", "ticketd", checkout);
const effort = run("effort", "create", "Validate native workflow");
// This plan describes the real repository change that adds this workflow harness.
const plan = [
  {
    operation: "create",
    name: "outcome",
    title: "Validate installed project workflow",
    project_id: project.id,
  },
  {
    operation: "create",
    name: "harness",
    title: "Exercise installed desktop and CLI together",
    project_id: project.id,
  },
  {
    operation: "create",
    name: "evidence",
    title: "Record native workflow evidence",
    project_id: project.id,
  },
  {
    operation: "change",
    ticket: "$harness",
    change: {
      parent: "$outcome",
      body: "Implement a focused installed-app workflow for ticketd.\n\n- [ ] Verify shared workspace",
      add_tags: ["validation"],
    },
  },
  {
    operation: "change",
    ticket: "$evidence",
    change: { parent: "$outcome", add_blockers: ["$harness"] },
  },
];
const results = JSON.parse(command(["batch", "-"], JSON.stringify(plan)));
const [outcome, harness, evidence] = results;
run("effort", "add", effort.id, harness.reference);
run("effort", "add", effort.id, evidence.reference);
assert.equal(run("show", evidence.reference).availability, "Blocked");
assert(
  run("list", "--availability", "ready").some(
    (ticket) => ticket.reference === harness.reference,
  ),
);
const context = run(
  "context",
  harness.reference,
  "--project",
  "--effort",
  "--relationships",
  "--notes",
);
assert.equal(context.relationships.parent.reference, outcome.reference);
assert.equal(context.project.id, project.id);
assert.equal(context.effort.id, effort.id);
console.log(
  `Bounded context: ${Buffer.byteLength(JSON.stringify(context))} bytes in one CLI call`,
);

const browser = await remote({
  hostname: "127.0.0.1",
  port: 4444,
  logLevel: "error",
  capabilities: { "tauri:options": { application } },
});
const detail = () =>
  browser.$(
    'section[aria-labelledby="detail-heading"] > .detail-content:not([hidden])',
  );
// A ticket row is a button in the list. Its status icon is named by the status,
// and its text carries the status, or Ready/Blocked for a Todo ticket.
const ticketRow = async (title) =>
  (await browser.$(".ticket-rows")).$(`button*=${title}`);
const rowReports = (title, text) => async () =>
  (await (await ticketRow(title)).getText()).includes(text);
const header = () =>
  browser.$('section[aria-labelledby="detail-heading"] > .detail-header');
try {
  const newTicket = await browser.$('button[aria-label="New ticket"]');
  await newTicket.waitForDisplayed({ timeout: 15000 });
  await newTicket.click();
  const creation = await browser.$('.create-panel[role="dialog"]');
  await (
    await creation.$('[aria-label="Description rich text"]')
  ).waitForDisplayed({ timeout: 15000 });
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const dialog = document.querySelector('.create-panel[role="dialog"]');
        if (!dialog) return false;
        const bounds = dialog.getBoundingClientRect();
        return (
          bounds.left >= 0 &&
          bounds.top >= 0 &&
          bounds.right <= window.innerWidth &&
          bounds.bottom <= window.innerHeight &&
          Math.abs(bounds.x + bounds.width / 2 - window.innerWidth / 2) < 2 &&
          Math.abs(bounds.y + bounds.height / 2 - window.innerHeight / 2) < 2
        );
      }),
    {
      timeout: 5000,
      timeoutMsg: "New ticket dialog is off-center or outside the app window",
    },
  );
  await (await creation.$('[aria-label="Close new ticket"]')).click();
  await creation.waitForDisplayed({ reverse: true });

  const row = await browser.$(
    "button*=Exercise installed desktop and CLI together",
  );
  await row.waitForDisplayed({ timeout: 15000 });
  await row.click();
  await (await detail()).waitForDisplayed({ timeout: 10000 });
  const title = await (await detail()).$('textarea[aria-label="Title"]');
  await title.waitForDisplayed();
  await title.setValue(`${harness.title} (reviewed)`);
  await browser.waitUntil(
    () => run("show", harness.reference).title.endsWith(" (reviewed)"),
    { timeout: 10000, timeoutMsg: "Desktop edit did not save" },
  );
  await (await (await detail()).$("button=Edit description")).click();
  const editor = await (
    await detail()
  ).$('[role="textbox"][aria-label="Description rich text"]');
  await editor.click();
  await browser.keys(["End"]);
  await browser.keys(" Reviewed in desktop.");
  await browser.waitUntil(
    () => run("show", harness.reference).body.includes("Reviewed in desktop."),
    { timeout: 10000, timeoutMsg: "Markdown edit did not save" },
  );
  await (await (await detail()).$("button=Add a note")).click();
  const noteEditor = await (
    await detail()
  ).$('[role="textbox"][aria-label="New note rich text"]');
  await noteEditor.click();
  await browser.keys("Reviewed rich notes in the installed desktop.");
  assert.equal(run("note", "list", harness.reference).length, 0);
  await (await (await detail()).$("button=Add note")).click();
  await browser.waitUntil(
    () =>
      run("note", "list", harness.reference).some((note) =>
        note.content.includes("Reviewed rich notes in the installed desktop."),
      ),
    { timeout: 10000, timeoutMsg: "Explicit desktop note did not save" },
  );
  const search = await browser.$('input[aria-label="Search tickets"]');
  await search.setValue("Exercise installed desktop");
  await browser.waitUntil(
    async () =>
      (
        await (
          await browser.$(".ticket-list")
        ).$$("button*=Record native workflow evidence")
      ).length === 0,
  );
  await search.clearValue();
  await (
    await (await header()).$('button[aria-label="Ticket actions"]')
  ).click();
  await (
    await browser.$('//*[@role="menuitem" and text()="Open dependency graph"]')
  ).click();
  const graphView = await browser.$('section[aria-label="Dependency graph"]');
  await graphView.waitForDisplayed({ timeout: 10000 });
  const graphNode = await graphView.$(`button*=${evidence.reference}`);
  await graphNode.waitForDisplayed({ timeout: 10000 });
  await graphNode.click();
  await (await graphView.$(`button*=Open ${evidence.reference}`)).click();
  await browser.waitUntil(
    async () =>
      (await (
        await (await detail()).$('textarea[aria-label="Title"]')
      ).getValue()) === evidence.title,
  );
  console.log(
    "Desktop review: keyboard title and Markdown edits, search, mouse graph navigation",
  );
  run(
    "change",
    harness.reference,
    "--status",
    "In progress",
    "--agent",
    "workflow-validation",
  );
  run(
    "note",
    "add",
    harness.reference,
    "--content",
    "Implemented the installed desktop workflow harness and exercised shared workspace operations.",
    "--agent",
    "workflow-validation",
  );
  run(
    "change",
    harness.reference,
    "--status",
    "In review",
    "--agent",
    "workflow-validation",
  );
  assert.equal(run("show", evidence.reference).availability, "Blocked");
  await browser.waitUntil(rowReports(harness.title, "In review"), {
    timeout: 10000,
    timeoutMsg: "External status change did not refresh the ticket row",
  });
  await (
    await (
      await ticketRow(harness.title)
    ).$('[role="img"][aria-label="In review"]')
  ).waitForExist({ timeout: 10000 });
  await browser.waitUntil(
    rowReports(evidence.title, `Blocked by ${harness.reference}`),
    {
      timeout: 10000,
      timeoutMsg: "External blocked state did not refresh in the ticket row",
    },
  );
  run(
    "change",
    harness.reference,
    "--status",
    "Done",
    "--agent",
    "workflow-validation",
  );
  assert.equal(run("show", evidence.reference).availability, "Ready");
  await browser.waitUntil(rowReports(evidence.title, "Ready"), {
    timeout: 10000,
    timeoutMsg: "External readiness change did not refresh",
  });
  await (
    await (await header()).$('button[aria-label="Ticket actions"]')
  ).click();
  await (await $('//*[@role="menuitem" and text()="Move to trash"]')).click();
  await (
    await (
      await browser.$('nav[aria-label="Trash and settings"]')
    ).$("button=Trash")
  ).click();
  await (await ticketRow(evidence.title)).click();
  await (
    await (await header()).$('button[aria-label="Ticket actions"]')
  ).click();
  await (await $('//*[@role="menuitem" and text()="Restore"]')).click();
  assert.equal(run("show", evidence.reference).trashed, false);
  assert.equal(
    run("show", evidence.reference).parent.reference,
    outcome.reference,
  );
  console.log(
    "External status and note updates refreshed; trash/restore retained hierarchy",
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
const backup = path.join(data, "workflow-backup.sqlite");
const exported = path.join(data, "workflow-export.json");
command(["export", "--file", exported]);
assert(readFileSync(exported, "utf8").includes(harness.reference));
command(["backup", backup]);
run("change", evidence.reference, "--status", "Done");
command(["restore-workspace", backup]);
assert.equal(run("show", evidence.reference).availability, "Ready");
assert.equal(
  run("show", evidence.reference).parent.reference,
  outcome.reference,
);
assert.equal(run("show", harness.reference).status, "Done");
console.log(
  "Export and backup recovery retained tickets, status, and relationships",
);
