// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { EditorUnderTest } from "@/features/automations/testing";
import type {
  Automation,
  AutomationDefinition,
} from "@/features/automations/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.DOMMatrixReadOnly = class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;

const PROJECTS = ["web-app", "api"].map((name) => ({
  id: `project-${name}`,
  name,
  path: `C:\\code\\${name}`,
  paths: [`C:\\code\\${name}`],
}));
beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_projects") return PROJECTS;
    throw new Error(`unexpected command ${command}`);
  });
});
afterEach(cleanup);

const nothing = () => {};
/** The definition as last saved. */
let saved: AutomationDefinition | undefined;
const open = async (patch: Partial<Automation> = {}) => {
  saved = undefined;
  render(
    <EditorUnderTest
      automation={{
        id: "automation-1",
        name: "Triage",
        trigger: null,
        conditions: [],
        steps: [],
        enabled: false,
        arrived_off: false,
        problems: [],
        has_ticket: true,
        ...patch,
      }}
      agents={[]}
      expanded={false}
      single={false}
      onExpand={nothing}
      onReturn={nothing}
      onClose={nothing}
      onSaved={(definition) => (saved = definition)}
      onSetEnabled={nothing}
      onStopAndTurnOff={nothing}
      onDelete={nothing}
      onDuplicate={nothing}
      onCreateAgent={async () => undefined}
      onSaveAgent={nothing}
      onDeleteAgent={nothing}
      onFail={nothing}
      openRun={null}
      onOpenRun={nothing}
    />,
  );
  return screen.findByRole("application", { name: "Steps" });
};
/** Opens the menu a button carries and chooses an item from it. */
const choose = async (button: HTMLElement, item: string) => {
  fireEvent.keyDown(button, { key: "Enter" });
  const menu = await screen.findByRole("menu");
  // Plain items and ticked ones alike.
  const found = [
    ...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  ].find((element) => element.textContent.startsWith(item));
  if (!found) throw new Error(`the menu has no ${item}`);
  fireEvent.click(found);
};
const triggerCard = (steps: HTMLElement) =>
  within(steps).getByRole("button", { name: /^(Trigger|When)/ });
/** Chooses what starts it and answers with the panel that opens. */
const start = async (steps: HTMLElement, item: string, panel: string) => {
  // A card with a trigger carries the menu on its own button.
  const menu = within(steps).queryByRole("button", {
    name: "Change what starts it",
  });
  await choose(menu ?? triggerCard(steps), item);
  return screen.findByRole("complementary", { name: panel });
};
const TAGGED = {
  trigger: { kind: "tag_added" as const, tag: "ready-for-triage" },
};
const openPanel = async (patch: Partial<Automation>) => {
  const steps = await open(patch);
  fireEvent.click(triggerCard(steps));
  return { steps, panel: await screen.findByRole("complementary") };
};

test("the trigger menu offers the six ticket triggers under A ticket changes", async () => {
  const steps = await open();
  fireEvent.keyDown(triggerCard(steps), { key: "Enter" });
  const menu = await screen.findByRole("menu");

  expect(within(menu).getByText("A ticket changes")).toBeTruthy();
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .slice(0, 6)
      .map(
        (item) =>
          item.querySelector(".flow-menu-item-text")?.firstChild?.nodeValue,
      ),
  ).toEqual([
    "Ticket created",
    "Ticket updated",
    "Status changed",
    "Tag added",
    "Tag removed",
    "Update added",
  ]);
});

test("a trigger that needs nothing more is saved as chosen, and its panel holds only conditions", async () => {
  const steps = await open();

  for (const [item, kind, title] of [
    ["Ticket created", "ticket_created", "When a ticket is created"],
    ["Ticket updated", "ticket_updated", "When a ticket is updated"],
    ["Update added", "activity_created", "When an update is added"],
  ] as const) {
    const panel = await start(steps, item, title);
    expect(saved?.trigger).toEqual({ kind });
    expect(triggerCard(steps).getAttribute("aria-label")).toBe(
      `Trigger: ${title}`,
    );
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(
      within(panel).getByRole("button", { name: "Add condition" }),
    ).toBeTruthy();
  }
});

test("Tag removed names a tag, as Tag added does", async () => {
  const steps = await open();
  const panel = await start(steps, "Tag removed", "When a tag is removed");

  fireEvent.change(within(panel).getByRole("textbox", { name: "Tag" }), {
    target: { value: "Blocked" },
  });

  expect(saved?.trigger).toEqual({ kind: "tag_removed", tag: "blocked" });
  expect(triggerCard(steps).getAttribute("aria-label")).toBe(
    "When a tag is removed: blocked",
  );
});

test("Status changed takes a To status and an optional From status", async () => {
  const steps = await open();
  const panel = await start(steps, "Status changed", "When the status changes");
  expect(saved?.trigger).toEqual({
    kind: "status_changed",
    to: null,
    from: null,
  });
  expect(triggerCard(steps).getAttribute("aria-label")).toBe(
    "When the status changes: Choose a status",
  );

  await choose(within(panel).getByRole("button", { name: "To" }), "In review");
  expect(saved?.trigger).toEqual({
    kind: "status_changed",
    to: "In review",
    from: null,
  });
  expect(triggerCard(steps).getAttribute("aria-label")).toBe(
    "When the status changes: To In review",
  );

  await choose(
    within(panel).getByRole("button", { name: "From: Any status" }),
    "In progress",
  );
  expect(saved?.trigger).toEqual({
    kind: "status_changed",
    to: "In review",
    from: "In progress",
  });
  expect(triggerCard(steps).getAttribute("aria-label")).toBe(
    "When the status changes: From In progress to In review",
  );

  await choose(
    within(panel).getByRole("button", { name: "From: In progress" }),
    "Any status",
  );
  expect(saved?.trigger).toMatchObject({ from: null });
});

test("conditions on project, source and tags are rows in the trigger's panel and a line on its card", async () => {
  const { steps, panel } = await openPanel(TAGGED);
  const add = (item: string) =>
    choose(within(panel).getByRole("button", { name: "Add condition" }), item);
  expect(within(panel).queryByText("All conditions must match.")).toBeNull();

  await add("Project");
  expect(saved?.conditions).toEqual([{ kind: "project", any_of: [] }]);
  await choose(
    within(panel).getByRole("button", { name: "Project is" }),
    "web-app",
  );
  await choose(
    within(panel).getByRole("button", { name: "Project is: web-app" }),
    "api",
  );

  await add("Source");
  await choose(
    within(panel).getByRole("button", { name: "Source is" }),
    "GitHub",
  );

  await add("Tags");
  fireEvent.change(
    within(panel).getByRole("textbox", { name: "Condition tag" }),
    { target: { value: "WontFix" } },
  );
  await choose(
    within(panel).getByRole("button", { name: "Tag: has" }),
    "does not have",
  );

  expect(saved?.conditions).toEqual([
    { kind: "project", any_of: ["project-web-app", "project-api"] },
    { kind: "source", any_of: ["github"] },
    { kind: "tag", tag: "wontfix", has: false },
  ]);
  expect(within(panel).getByText("All conditions must match.")).toBeTruthy();
  // A line on the trigger's card, not a card of their own.
  expect(triggerCard(steps).textContent).toContain(
    "Only in web-app or api, from GitHub, without wontfix",
  );
  expect(within(steps).getAllByRole("button", { name: /^When/ })).toHaveLength(
    1,
  );
});

test("a ticket has one project and one source, so each is offered as a condition once; tags are offered again", async () => {
  const { panel } = await openPanel({
    ...TAGGED,
    conditions: [
      { kind: "project", any_of: ["project-api"] },
      { kind: "source", any_of: ["local"] },
      { kind: "tag", tag: "bug", has: true },
    ],
  });

  fireEvent.keyDown(
    within(panel).getByRole("button", { name: "Add condition" }),
    { key: "Enter" },
  );
  const menu = await screen.findByRole("menu", { name: "Add condition" });
  const disabled = (name: RegExp) =>
    within(menu).getByRole("menuitem", { name }).getAttribute("aria-disabled");
  expect([
    disabled(/^Project/),
    disabled(/^Source/),
    disabled(/^Tags/),
  ]).toEqual(["true", "true", null]);
});

test("a condition is removed from its row", async () => {
  const { steps, panel } = await openPanel({
    ...TAGGED,
    conditions: [
      { kind: "project", any_of: ["project-api"] },
      { kind: "source", any_of: ["local"] },
      { kind: "tag", tag: "bug", has: true },
    ],
  });
  // The project's name arrives with the list of projects.
  await waitFor(() =>
    expect(triggerCard(steps).textContent).toContain(
      "Only in api, local tickets, with bug",
    ),
  );

  fireEvent.click(
    within(panel).getByRole("button", {
      name: "Remove condition: Source is Local",
    }),
  );

  expect(saved?.conditions).toEqual([
    { kind: "project", any_of: ["project-api"] },
    { kind: "tag", tag: "bug", has: true },
  ]);
  expect(triggerCard(steps).textContent).toContain("Only in api, with bug");
});

test("a source condition names more than one source", async () => {
  const { panel } = await openPanel({
    ...TAGGED,
    conditions: [{ kind: "source", any_of: ["github"] }],
  });

  await choose(
    within(panel).getByRole("button", { name: "Source is: GitHub" }),
    "Local",
  );
  expect(saved?.conditions).toEqual([
    { kind: "source", any_of: ["github", "local"] },
  ]);

  // Unticking one leaves the other.
  await choose(
    within(panel).getByRole("button", { name: "Source is: GitHub or Local" }),
    "GitHub",
  );
  expect(saved?.conditions).toEqual([{ kind: "source", any_of: ["local"] }]);
});
