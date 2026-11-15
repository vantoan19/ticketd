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
  AutomationDefinition,
  AutomationStep,
  AutomationTrigger,
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
    if (command === "list_projects") return [];
    throw new Error(`unexpected command ${command}`);
  });
});
afterEach(cleanup);

const nothing = () => {};
/** The definition as last saved. */
let saved: AutomationDefinition | undefined;
const open = async (
  steps: AutomationStep[],
  trigger: AutomationTrigger = { kind: "tag_added", tag: "ready-for-testing" },
) => {
  saved = undefined;
  render(
    <EditorUnderTest
      automation={{
        id: "automation-1",
        name: "Verify on staging",
        trigger,
        conditions: [],
        steps,
        enabled: false,
        arrived_off: false,
        problems: [],
        has_ticket: true,
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
      onSaveAgent={() => new Promise(() => {})}
      onDeleteAgent={nothing}
      onFail={nothing}
      onRead={nothing}
      openRun={null}
      onOpenRun={nothing}
    />,
  );
  return screen.findByRole("application", { name: "Steps" });
};
/** A button by its name. A card's name goes on to say where it is on its path. */
const button = (within_: HTMLElement, name: string) =>
  within(within_).getByRole("button", {
    name: (accessible) =>
      accessible === name || accessible.startsWith(`${name}, `),
  });
/** What the menu a button carries offers: each item's first line. */
const offered = async (opener: HTMLElement) => {
  fireEvent.keyDown(opener, { key: "Enter" });
  const menu = await screen.findByRole("menu");
  const items = [...menu.querySelectorAll('[role^="menuitem"]')].map(
    (item) =>
      (item.querySelector("small")?.previousSibling ?? item).textContent,
  );
  fireEvent.keyDown(menu, { key: "Escape" });
  return items;
};
/** Opens the menu a button carries and chooses an item from it. */
const choose = async (opener: HTMLElement, item: string) => {
  fireEvent.keyDown(opener, { key: "Enter" });
  const menu = await screen.findByRole("menu");
  const found = [
    ...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  ].find((element) => element.textContent.startsWith(item));
  if (!found) throw new Error(`the menu has no ${item}`);
  fireEvent.click(found);
};
/** The menu on a step's card. */
const actions = (steps: HTMLElement, card: string) =>
  within(button(steps, card).closest<HTMLElement>(".flow-card")!).getByRole(
    "button",
    { name: /^Actions for / },
  );
const places = (steps: HTMLElement) =>
  within(steps)
    .getAllByRole("button", { name: /^Add a step/ })
    .map((place) => place.getAttribute("aria-label"));

const AGENT: AutomationStep = {
  id: "verify",
  kind: "run_agent",
  agent_id: null,
  execution_folder: null,
  on_failure: null,
};
const CLOSE: AutomationStep = {
  id: "close",
  kind: "change_ticket",
  change: { action: "set_status", status: "Done" },
  on_failure: null,
};
const TELL: AutomationStep = {
  id: "tell",
  kind: "notify",
  text: "Verified",
  opens: "ticket",
  on_failure: null,
};
const CHECK: AutomationStep = {
  id: "check",
  kind: "if",
  checks: [{ kind: "tag", tag: "verified", has: true }],
  yes: [],
  no: [],
};
const TRIGGER_CARD = "When a tag is added: ready-for-testing";
const AGENT_CARD = "Run agent: Choose an agent";
const CLOSE_CARD = "Change ticket: Set status to Done";
const TELL_CARD = "Notify me: Verified";
const CHECK_CARD = "If: Ticket has tag verified";

test("Add failure path is in the menu of the steps that can fail and nowhere else, and no failure path is shown until it is added", async () => {
  const steps = await open([AGENT, CLOSE, TELL, CHECK]);

  for (const card of [AGENT_CARD, CLOSE_CARD, TELL_CARD])
    expect(await offered(actions(steps, card))).toEqual([
      "Add failure path",
      "Delete step…",
    ]);
  expect(await offered(actions(steps, CHECK_CARD))).toEqual(["Delete step…"]);
  expect(await offered(button(steps, "Change what starts it"))).not.toContain(
    "Add failure path",
  );
  expect(places(steps).filter((name) => name?.includes("failure"))).toEqual([]);
});

test("a failure path is added from the step's menu as a path of its own beside the step, and the next step stays after the step", async () => {
  const steps = await open([CLOSE, TELL]);

  await choose(actions(steps, CLOSE_CARD), "Add failure path");

  expect(saved?.steps).toMatchObject([
    { id: "close", on_failure: [] },
    { id: "tell", on_failure: null },
  ]);
  // In the order the steps run: the failure path follows its step.
  expect(places(steps)).toEqual([
    `Add a step after ${TRIGGER_CARD}`,
    `Add a step on the failure path of ${CLOSE_CARD}`,
    `Add a step after ${CLOSE_CARD}`,
    `Add a step after ${TELL_CARD}`,
  ]);
});

test("a failure path holds any steps: an If, and steps with failure paths of their own", async () => {
  const steps = await open([{ ...CLOSE, on_failure: [] }, TELL]);
  const onPath = `Add a step on the failure path of ${CLOSE_CARD}`;

  await choose(button(steps, onPath), "Run agent");
  await choose(button(steps, `Add a step after ${AGENT_CARD}`), "If");
  await choose(actions(steps, AGENT_CARD), "Add failure path");
  await choose(
    button(steps, `Add a step on the failure path of ${AGENT_CARD}`),
    "Notify me",
  );

  expect(saved?.steps).toMatchObject([
    {
      id: "close",
      on_failure: [
        { kind: "run_agent", on_failure: [{ kind: "notify" }] },
        { kind: "if", yes: [], no: [] },
      ],
    },
    { id: "tell" },
  ]);
  expect(saved?.steps).toHaveLength(2);
});

test("a step that needs a ticket cannot be added on a failure path of an Automation that starts without one", async () => {
  const steps = await open([{ ...AGENT, on_failure: [] }], { kind: "by_hand" });

  fireEvent.keyDown(
    button(steps, `Add a step on the failure path of ${AGENT_CARD}`),
    { key: "Enter" },
  );
  const menu = await screen.findByRole("menu");

  expect(
    [...menu.querySelectorAll('[role^="menuitem"]')].map((item) =>
      item.hasAttribute("data-disabled"),
    ),
    // Run agent, Change ticket, Notify me, If.
  ).toEqual([false, true, false, true]);
  // Still reached by the arrow keys, so its reason is heard; choosing it does nothing.
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  await waitFor(() =>
    expect(document.activeElement?.textContent).toContain("Needs a ticket"),
  );
  fireEvent.click(document.activeElement!);
  expect(saved).toBeUndefined();
});

test("an empty failure path is removed from the step's menu at once", async () => {
  const steps = await open([{ ...CLOSE, on_failure: [] }, TELL]);

  expect(await offered(actions(steps, CLOSE_CARD))).toEqual([
    "Remove failure path",
    "Delete step…",
  ]);
  await choose(actions(steps, CLOSE_CARD), "Remove failure path");

  expect(saved?.steps).toMatchObject([
    { id: "close", on_failure: null },
    { id: "tell" },
  ]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(places(steps).filter((name) => name?.includes("failure"))).toEqual([]);
});

test("removing a failure path that has steps asks first, and takes the steps and an open panel of one with it", async () => {
  const steps = await open([
    {
      ...CLOSE,
      on_failure: [
        { ...TELL, id: "failed", text: "Could not close" },
        { ...AGENT, id: "retry", on_failure: [{ ...TELL, id: "gave-up" }] },
      ],
    },
    TELL,
  ]);
  fireEvent.click(button(steps, "Notify me: Could not close"));
  await screen.findByRole("complementary", { name: "Notify me" });

  await choose(actions(steps, CLOSE_CARD), "Remove failure path…");
  const dialog = await screen.findByRole("dialog", {
    name: "Remove failure path?",
  });
  // Nothing is removed until the person says so.
  expect(saved).toBeUndefined();
  // Every step that goes, the one on the agent's own failure path too.
  expect(dialog.textContent).toContain("The 3 steps on it are removed");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

  expect(saved?.steps).toMatchObject([
    { id: "close", on_failure: null },
    { id: "tell" },
  ]);
  expect(screen.queryByRole("complementary", { name: "Notify me" })).toBeNull();
  expect(within(steps).queryByRole("button", { name: AGENT_CARD })).toBeNull();
  // Focus goes back to the step whose path went, not to the page.
  await waitFor(() =>
    expect(document.activeElement).toBe(button(steps, CLOSE_CARD)),
  );
});

test("focus stays on the flow: after a step is deleted it is on the step before, after Cancel on the step, and after one is added in its panel", async () => {
  const steps = await open([CLOSE, TELL]);

  fireEvent.keyDown(button(steps, TELL_CARD), { key: "Delete" });
  let dialog = await screen.findByRole("dialog", { name: "Delete step?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(button(steps, TELL_CARD)),
  );

  fireEvent.keyDown(button(steps, TELL_CARD), { key: "Delete" });
  dialog = await screen.findByRole("dialog", { name: "Delete step?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(button(steps, CLOSE_CARD)),
  );

  await choose(button(steps, `Add a step after ${CLOSE_CARD}`), "Notify me");
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("complementary", { name: "Notify me" }),
    ),
  );
});
