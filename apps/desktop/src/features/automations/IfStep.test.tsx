// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AutomationEditor } from "@/features/automations/AutomationEditor";
import type {
  AutomationDefinition,
  AutomationStep,
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

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_projects")
      return [
        {
          id: "project-web-app",
          name: "web-app",
          path: "C:\\code\\web-app",
          paths: ["C:\\code\\web-app"],
        },
      ];
    throw new Error(`unexpected command ${command}`);
  });
});
afterEach(cleanup);

const nothing = () => {};
/** The definition as last saved. */
let saved: AutomationDefinition | undefined;
const open = async (steps: AutomationStep[] = []) => {
  saved = undefined;
  render(
    <AutomationEditor
      automation={{
        id: "automation-1",
        name: "Verify on staging",
        trigger: { kind: "tag_added", tag: "ready-for-testing" },
        conditions: [],
        steps,
        enabled: false,
        arrived_off: false,
        problems: [],
      }}
      agents={[]}
      expanded={false}
      single={false}
      onExpand={nothing}
      onReturn={nothing}
      onClose={nothing}
      onChange={(definition) => (saved = definition)}
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
  const found = [
    ...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  ].find((element) => element.textContent.startsWith(item));
  if (!found) throw new Error(`the menu has no ${item}`);
  fireEvent.click(found);
};
const button = (within_: HTMLElement, name: string) =>
  within(within_).getByRole("button", { name });
const places = (steps: HTMLElement) =>
  within(steps)
    .getAllByRole("button", { name: /^Add a step/ })
    .map((place) => place.getAttribute("aria-label"));

const VERIFIED: AutomationStep = {
  id: "passed",
  kind: "if",
  checks: [{ kind: "tag", tag: "verified", has: true }],
  yes: [],
  no: [],
};
const TRIGGER = "When a tag is added: ready-for-testing";
const PASSED = "If: Ticket has tag verified";

test("an If is added from the + with a Yes path and a No path, each with its own +, and nothing after it", async () => {
  const steps = await open();

  await choose(button(steps, `Add a step after ${TRIGGER}`), "If");

  expect(saved?.steps).toMatchObject([
    { kind: "if", checks: [], yes: [], no: [] },
  ]);
  // The card asks for a check, and its panel opens.
  expect(button(steps, "If: Choose what to check")).toBeTruthy();
  expect(await screen.findByRole("complementary", { name: "If" })).toBeTruthy();
  // In the order the steps run: above the If, then one + ending each path.
  expect(places(steps)).toEqual([
    `Add a step after ${TRIGGER}`,
    "Add a step on the Yes path of If: Choose what to check",
    "Add a step on the No path of If: Choose what to check",
  ]);
});

test("checks on tags, status and project are rows in the If's panel and words on its card", async () => {
  const steps = await open([{ ...VERIFIED, checks: [] }]);
  fireEvent.click(button(steps, "If: Choose what to check"));
  const panel = await screen.findByRole("complementary", { name: "If" });
  const add = (item: string) => choose(button(panel, "Add check"), item);

  await add("Tags");
  fireEvent.change(within(panel).getByRole("textbox", { name: "Check tag" }), {
    target: { value: "Verified" },
  });
  await add("Status");
  await choose(button(panel, "Status is: Todo"), "In review");
  await choose(button(panel, "Status: is"), "is not");
  await add("Project");
  await choose(button(panel, "Project is: No project"), "web-app");

  expect(saved?.steps).toMatchObject([
    {
      id: "passed",
      checks: [
        { kind: "tag", tag: "verified", has: true },
        { kind: "status", status: "In review", is: false },
        { kind: "project", project_id: "project-web-app", is: true },
      ],
    },
  ]);
  expect(
    button(
      steps,
      "If: Ticket has tag verified and status is not In review and project is web-app",
    ),
  ).toBeTruthy();

  fireEvent.click(button(panel, "Remove check: Status is not In review"));
  expect(saved?.steps).toMatchObject([
    { checks: [{ kind: "tag" }, { kind: "project" }] },
  ]);
});

test("steps are added inside each path, and an If inside a path has two paths of its own", async () => {
  const steps = await open([VERIFIED]);

  await choose(
    button(steps, `Add a step on the Yes path of ${PASSED}`),
    "Notify me",
  );
  await choose(button(steps, `Add a step on the No path of ${PASSED}`), "If");
  await choose(
    button(steps, "Add a step on the Yes path of If: Choose what to check"),
    "Change ticket",
  );

  expect(saved?.steps).toMatchObject([
    {
      id: "passed",
      yes: [{ kind: "notify" }],
      no: [{ kind: "if", yes: [{ kind: "change_ticket" }], no: [] }],
    },
  ]);
  expect(saved?.steps).toHaveLength(1);
  // Paths never rejoin: each ends in its own +, and none follows an If.
  expect(places(steps)).toEqual([
    `Add a step after ${TRIGGER}`,
    `Add a step on the Yes path of ${PASSED}`,
    "Add a step after Notify me: Write a message",
    `Add a step on the No path of ${PASSED}`,
    "Add a step on the Yes path of If: Choose what to check",
    "Add a step after Change ticket: Choose a change",
    "Add a step on the No path of If: Choose what to check",
  ]);
});

test("an If added above other steps takes them as its Yes path", async () => {
  const steps = await open([
    { id: "tell", kind: "notify", text: "Verified", opens: "ticket" },
  ]);

  await choose(button(steps, `Add a step after ${TRIGGER}`), "If");

  expect(saved?.steps).toMatchObject([
    { kind: "if", yes: [{ id: "tell" }], no: [] },
  ]);
});

test("a step on a path is set up and deleted where it is, and deleting an If takes its paths with it", async () => {
  const steps = await open([
    {
      ...VERIFIED,
      yes: [
        {
          id: "send-back",
          kind: "change_ticket",
          change: { action: "add_tag", tag: "" },
        },
      ],
      no: [{ id: "tell", kind: "notify", text: "Failed", opens: "ticket" }],
    },
  ]);
  const remove = async (card: string) => {
    const actions = within(
      button(steps, card).closest<HTMLElement>(".flow-card")!,
    ).getByRole("button", { name: "Step actions" });
    await choose(actions, "Delete step");
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
  };

  fireEvent.click(button(steps, "Change ticket: Choose a change"));
  const panel = await screen.findByRole("complementary", {
    name: "Change ticket",
  });
  fireEvent.change(within(panel).getByLabelText("Tag"), {
    target: { value: "needs-fix" },
  });
  expect(saved?.steps).toMatchObject([
    {
      id: "passed",
      yes: [{ id: "send-back", change: { tag: "needs-fix" } }],
      no: [{ id: "tell" }],
    },
  ]);

  await remove("Notify me: Failed");
  expect(saved?.steps).toMatchObject([
    { id: "passed", yes: [{ id: "send-back" }], no: [] },
  ]);

  await remove(PASSED);
  expect(saved?.steps).toEqual([]);
});
