import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { remote } from "webdriverio";

// The workflow gives this script its own XDG_DATA_HOME shared by CLI and desktop.
const cli = path.resolve(
  process.env.TICKETD_SMOKE_CLI ?? "target/debug/ticketd",
);
const application = path.resolve(
  process.env.TICKETD_SMOKE_DESKTOP ?? "target/debug/ticketd-desktop",
);
const command = (args, input) =>
  execFileSync(cli, args, { encoding: "utf8", input });
const run = (...args) => JSON.parse(command(args));
const write = (request, id) =>
  JSON.parse(
    command(["write", "-", "--request-id", id], JSON.stringify(request)),
  );
const source = run("create", "Extension source");
const target = run("create", "Extension target");
const dependent = run("create", "Extension dependent");
const project = run("project", "create", "Extension project", process.cwd());
const effort = run("effort", "create", "Extension effort");
run(
  "change",
  source.reference,
  "--body",
  `See ${target.reference} for context.`,
);
run("add-dependency", source.reference, dependent.reference);

const connect = () =>
  remote({
    hostname: "127.0.0.1",
    port: 4444,
    logLevel: "error",
    capabilities: { "tauri:options": { application } },
  });
let browser = await connect();
const detail = () =>
  browser.$(
    'section[aria-labelledby="detail-heading"] > .detail-content:not([hidden])',
  );
async function click(element) {
  await element.waitForDisplayed({ timeout: 15000 });
  await element.waitForEnabled({ timeout: 15000 });
  await element.scrollIntoView({ block: "center" });
  await element.click();
}
async function open(title) {
  await click(await (await browser.$(".ticket-list")).$(`button*=${title}`));
  await (await detail()).waitForDisplayed({ timeout: 10000 });
  await browser.waitUntil(
    async () =>
      (await (
        await (await detail()).$('textarea[aria-label="Title"]')
      ).getValue()) === title,
    { timeout: 10000 },
  );
}
async function disclosure(label) {
  const labelled = await (await detail()).$(`summary[aria-label="${label}"]`);
  const summary = (await labelled.isExisting())
    ? labelled
    : await (await detail()).$(`summary=${label}`);
  const isOpen = await browser.execute(
    (element) => element.parentElement.open,
    summary,
  );
  if (!isOpen) await click(summary);
}
const waitFor = (fn, message, timeout = 12000) =>
  browser.waitUntil(fn, { timeout, interval: 200, timeoutMsg: message });
const waitForSelectionReset = () =>
  waitFor(
    () =>
      browser.execute(
        (references) =>
          references.every((reference) => {
            const input = document.querySelector(
              `input[aria-label="Select ${reference}"]`,
            );
            return input && !input.checked && !input.disabled;
          }),
        [source.reference, target.reference],
      ),
    "Bulk selection did not reset",
  );
try {
  // Follow in desktop, observe external CLI changes and navigate to the note.
  await open(source.title);
  await click(await (await detail()).$("button=Follow"));
  run("change", source.reference, "--status", "In progress");
  run(
    "note",
    "add",
    source.reference,
    "--content",
    `Native finding referencing ${target.reference}`,
  );
  await (
    await browser.$('[aria-label="Inbox, unread"]')
  ).waitForDisplayed({ timeout: 12000 });
  await click(await browser.$('[aria-label="Inbox, unread"]'));
  await (
    await browser.$("p*=New note: Native finding")
  ).waitForDisplayed({ timeout: 12000 });
  await click(await browser.$("button=Mark displayed read"));
  await waitFor(
    () => run("inbox").every((item) => item.read),
    "Inbox entries were not marked read",
  );
  await waitFor(
    async () => !(await browser.$('[aria-label="Inbox, unread"]').isExisting()),
    "Unread indicator did not clear",
  );
  await click(
    await browser.$(
      '//li[contains(concat(" ", normalize-space(@class), " "), " inbox-entry ")][.//p[contains(., "New note: Native finding")]]//button[contains(concat(" ", normalize-space(@class), " "), " inbox-ticket ")]',
    ),
  );
  await (await detail()).waitForDisplayed({ timeout: 10000 });
  const selectedNote = await (await detail()).$('[aria-label="Selected note"]');
  await selectedNote.waitForDisplayed({ timeout: 10000 });
  assert((await selectedNote.getText()).includes("Native finding"));

  // Schedule locally through the UI and watch attention appear while Projects is open.
  const future = new Date();
  future.setSeconds(0, 0);
  future.setMinutes(future.getMinutes() + 1);
  const local = new Date(future.getTime() - future.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  await click(await (await detail()).$('button[aria-label="Manage reminder"]'));
  const input = await browser.$('input[type="datetime-local"]');
  await input.scrollIntoView();
  await browser.execute(
    (element, value) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    input,
    local,
  );
  await click(await browser.$("button=Set reminder"));
  await browser.keys("Escape");
  await click(await browser.$('[aria-label="Manage projects"]'));
  await (
    await browser.$('[aria-label="Inbox, unread"]')
  ).waitForDisplayed({ timeout: 75000, interval: 250 });
  assert.equal(
    run("inbox").filter((item) => item.kind === "reminder").length,
    1,
  );
  await click(await browser.$('[aria-label="Inbox, unread"]'));
  await (
    await browser.$("p*=Reminder due")
  ).waitForDisplayed({ timeout: 10000 });
  await click(await browser.$("button=Mark displayed read"));
  await waitFor(
    () => run("inbox").every((item) => item.read),
    "Reminder not read",
  );
  await browser.deleteSession();
  write(
    {
      operation: "set_reminder",
      reference: source.reference,
      due_at: "2020-01-01T00:00:00Z",
    },
    "reopen-reminder",
  );
  browser = await connect();
  await (
    await browser.$('[aria-label="Inbox, unread"]')
  ).waitForDisplayed({ timeout: 15000 });
  await click(await browser.$('[aria-label="Inbox, unread"]'));
  assert.equal(
    run("inbox").filter((item) => item.kind === "reminder").length,
    2,
  );
  write(
    {
      operation: "set_reminder",
      reference: source.reference,
      due_at: "2020-01-01T00:00:00Z",
    },
    "reopen-reminder",
  );
  assert.equal(
    run("inbox").filter((item) => item.kind === "reminder").length,
    2,
    "Replaying a delivered reminder created another occurrence",
  );
  await click(
    await browser.$(
      '//li[contains(concat(" ", normalize-space(@class), " "), " inbox-entry ")][.//p[contains(., "Reminder due")] and .//span[normalize-space()="Unread"]]//button[contains(concat(" ", normalize-space(@class), " "), " inbox-ticket ")]',
    ),
  );
  await (await detail()).waitForDisplayed({ timeout: 10000 });
  await click(await (await detail()).$('button[aria-label="Manage reminder"]'));
  await click(await browser.$("button=Snooze 1 hour"));
  await waitFor(() => {
    const value = command(["reminder", "show", source.reference]).match(
      /UTC: ([^)]+)/,
    )?.[1];
    const remaining = Date.parse(value ?? "") - Date.now();
    return remaining > 50 * 60000 && remaining < 70 * 60000;
  }, "One-hour snooze did not persist");
  const reschedule = await browser.$('input[type="datetime-local"]');
  await reschedule.waitForEnabled({ timeout: 10000 });
  await browser.execute(
    (element, value) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    reschedule,
    "2030-01-01T12:00",
  );
  const rescheduleButton = await browser.$("button=Reschedule reminder");
  await rescheduleButton.waitForEnabled({ timeout: 10000 });
  await click(rescheduleButton);
  await waitFor(
    () => command(["reminder", "show", source.reference]).includes("2030"),
    "Reminder was not rescheduled",
  );
  await click(await browser.$("button=Dismiss reminder"));
  await browser.keys("Escape");

  // Backlinks, contextual links and evidence cross the real bridge.
  await click(
    await (
      await (await detail()).$(".description-document")
    ).$(`button=${target.reference}`),
  );
  await waitFor(
    async () =>
      (await (
        await (await detail()).$('textarea[aria-label="Title"]')
      ).getValue()) === target.title,
    "Inline reference did not navigate",
  );
  await disclosure("Backlinks");
  await (
    await (await detail()).$(`p*=See ${target.reference} for context.`)
  ).waitForDisplayed({ timeout: 10000 });
  await click(
    await (
      await detail()
    ).$('section[aria-label="Linked work"] button=Link ticket'),
  );
  const dialog = await browser.$('[role="dialog"]');
  await (
    await dialog.$('input[id^="link-search-"]')
  ).setValue(source.reference);
  await click(await dialog.$(`button*=${source.reference}`));
  await click(await dialog.$("button=Link ticket"));
  await waitFor(
    () =>
      run(
        "context",
        target.reference,
        "--relationships",
      ).relationships.related.items.some(
        (item) => item.reference === source.reference,
      ),
    "Contextual relationship did not persist",
  );
  assert.equal(run("show", target.reference).availability, "Ready");
  const evidence = await (
    await detail()
  ).$('section[aria-label="Implementation evidence"]');
  await click(await evidence.$("button=Add evidence"));
  await (await evidence.$("input[required]")).setValue("Native check");
  await (await evidence.$("textarea")).setValue("https://example.com/pull/1");
  await click(await evidence.$("button=Add evidence"));
  await waitFor(
    () =>
      run("evidence", "list", target.reference).some(
        (item) => item.name === "Native check",
      ),
    "Evidence did not persist",
  );

  // Bulk organization and status through UI, then verify an invalid batch is atomic.
  await (await browser.$(`[aria-label="Select ${source.reference}"]`)).click();
  await (await browser.$(`[aria-label="Select ${target.reference}"]`)).click();
  await click(await browser.$('[aria-label="Change selected status"]'));
  await (
    await browser.$('[aria-label="Status for selected tickets"]')
  ).selectByVisibleText("In review");
  await click(await browser.$("button=Apply status"));
  await waitFor(
    () => run("show", target.reference).status === "In review",
    "Bulk status did not persist",
  );
  await waitForSelectionReset();
  await (await browser.$(`[aria-label="Select ${source.reference}"]`)).click();
  await (await browser.$(`[aria-label="Select ${target.reference}"]`)).click();
  await click(await browser.$('[aria-label="Change selected project"]'));
  await (
    await browser.$('[aria-label="Project for selected tickets"]')
  ).selectByVisibleText(project.name);
  await click(await browser.$("button=Apply project"));
  await waitFor(
    () =>
      run("show", source.reference).project_id === project.id &&
      run("show", target.reference).project_id === project.id,
    "Bulk project did not persist",
  );
  await waitForSelectionReset();
  await (await browser.$(`[aria-label="Select ${source.reference}"]`)).click();
  await (await browser.$(`[aria-label="Select ${target.reference}"]`)).click();
  await click(await browser.$('[aria-label="Change selected effort"]'));
  await (
    await browser.$('[aria-label="Effort for selected tickets"]')
  ).selectByVisibleText(effort.name);
  await click(await browser.$("button=Apply Effort"));
  await waitFor(
    () =>
      run("show", source.reference).effort_id === effort.id &&
      run("show", target.reference).effort_id === effort.id,
    "Bulk Effort did not persist",
  );
  await waitForSelectionReset();
  await (await browser.$(`[aria-label="Select ${source.reference}"]`)).click();
  await (await browser.$(`[aria-label="Select ${target.reference}"]`)).click();
  await click(await browser.$('[aria-label="Change selected tags"]'));
  await (
    await browser.$('[aria-label="Tag for selected tickets"]')
  ).setValue("native");
  await click(await browser.$("button=Add tag"));
  await waitFor(
    () =>
      run("show", source.reference).tags.includes("native") &&
      run("show", target.reference).tags.includes("native"),
    "Bulk tag did not persist",
  );
  await waitForSelectionReset();
  const before = run("show", source.reference).status;
  assert.throws(() =>
    command(
      ["batch", "-"],
      JSON.stringify([
        {
          operation: "change",
          ticket: source.reference,
          change: { status: "Done" },
        },
        { operation: "change", ticket: "T-99999", change: { status: "Done" } },
      ]),
    ),
  );
  assert.equal(run("show", source.reference).status, before);

  // Review the blocker replacement, then undo the duplicate designation.
  await open(source.title);
  await click(await (await detail()).$('button[aria-label="Ticket actions"]'));
  await click(await browser.$('[role="menuitem"]=Mark as duplicate…'));
  let section = await browser.$(
    '[role="dialog"] section[aria-label="Duplicates"]',
  );
  await (await section.$('input[id^="canonical-"]')).setValue(target.reference);
  await click(await section.$("button=Preview dependencies"));
  const choice = await section.$("select");
  await choice.waitForDisplayed({ timeout: 10000 });
  await choice.selectByVisibleText("Replace");
  await click(await section.$("button=Mark duplicate"));
  await waitFor(
    () => run("show", source.reference).duplicate_of === target.reference,
    "Duplicate was not marked",
  );
  assert.equal(
    run("show", dependent.reference).prerequisites[0].reference,
    target.reference,
  );
  assert.equal(run("show", dependent.reference).availability, "Blocked");
  await click(
    await (
      await detail()
    ).$(
      `button[aria-label="Remove relationship: Duplicate of ${target.reference}"]`,
    ),
  );
  await waitFor(
    () => run("show", source.reference).duplicate_of === null,
    "Duplicate undo failed",
  );
  assert.equal(
    run("show", dependent.reference).prerequisites[0].reference,
    target.reference,
  );
  await click(await (await detail()).$('button[aria-label="Ticket actions"]'));
  await click(await browser.$('[role="menuitem"]=Mark as duplicate…'));
  section = await browser.$('[role="dialog"] section[aria-label="Duplicates"]');
  await click(await section.$("button=Review separate dependency changes"));
  await (await section.$('input[id^="canonical-"]')).setValue(target.reference);
  await click(await section.$("button=Preview dependencies"));
  const separateChoice = await section.$("select");
  await separateChoice.waitForDisplayed({ timeout: 10000 });
  await separateChoice.selectByVisibleText("Replace");
  await click(await section.$("button=Apply dependency changes"));
  await waitFor(
    () =>
      run("show", dependent.reference).prerequisites[0]?.reference ===
      source.reference,
    "Separate dependency review did not persist",
  );
  await browser.saveScreenshot("native-extensions-desktop.png");
  await browser.setWindowSize(390, 840);
  await waitFor(
    () => browser.execute(() => window.innerWidth <= 767),
    "Narrow viewport not applied",
  );
  await click(await (await detail()).$('button[aria-label="Manage reminder"]'));
  const reminderRect = await browser.execute(() => {
    const field = document.querySelector(
      '[data-slot="popover-content"] input[type="datetime-local"]',
    );
    if (!field) return null;
    const rect = field.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  });
  assert(
    reminderRect && reminderRect.left >= 0 && reminderRect.right <= 390,
    "Reminder control is clipped at narrow width",
  );
  await browser.saveScreenshot("native-extensions-narrow-detail.png");
  await browser.keys("Escape");
  const menu = await browser.$('button[data-sidebar="trigger"]');
  await click(menu);
  await (
    await browser.$('[role="dialog"]')
  ).waitForDisplayed({ timeout: 10000 });
  await browser.saveScreenshot("native-extensions-narrow.png");
  await browser.keys("Escape");
  assert(
    await browser.execute(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Narrow workspace overflows horizontally",
  );
  console.log("Extension desktop/CLI workflows passed");
} catch (error) {
  try {
    writeFileSync("native-failure.html", await browser.getPageSource());
    await browser.saveScreenshot("native-failure.png");
  } catch (diagnosticError) {
    console.error("Could not capture desktop diagnostics:", diagnosticError);
  }
  throw error;
} finally {
  await browser.deleteSession().catch(() => {});
}
