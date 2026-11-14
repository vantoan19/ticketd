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
import { scheduleText } from "@/features/automations/automation-text";
import { AutomationsView } from "@/features/automations/AutomationsView";
import type {
  Automation,
  AutomationDefinition,
} from "@/features/automations/client";
import { fakeStored } from "@/features/automations/fake-core";
import { ChatClientContext } from "@/features/chats/client";
import { createMockChatClient } from "@/features/chats/mock-client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.DOMMatrixReadOnly = class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;

/** The fake Workspace: one Automation, changed by the commands the page sends. */
let stored: Automation;
/** The Automations Run now was pressed on. */
let ranNow: unknown[];
beforeEach(() => {
  ranNow = [];
  stored = {
    id: "automation-1",
    name: "Weekly summary",
    trigger: null,
    conditions: [],
    steps: [],
    enabled: false,
    arrived_off: false,
    problems: [],
    has_ticket: true,
  };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { definition, id } = (args ?? {}) as {
      definition?: AutomationDefinition;
      id?: string;
    };
    switch (command) {
      case "automation_list":
        return [stored];
      case "automation_run_list_all":
      case "automation_agent_list":
      case "automation_run_list":
      case "list_projects":
        return [];
      case "automation_update":
        stored = fakeStored(stored, definition ?? {});
        return stored;
      case "automation_run_now":
        ranNow.push(id);
        return {};
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
});
afterEach(cleanup);

const open = async (patch: Partial<Automation> = {}) => {
  stored = fakeStored(stored, patch);
  render(
    <ChatClientContext value={createMockChatClient()}>
      <AutomationsView />
    </ChatClientContext>,
  );
  const rows = await screen.findByRole("list", { name: "Automations" });
  fireEvent.click(within(rows).getAllByRole("button")[0]!);
  return screen.findByRole("application", { name: "Steps" });
};
const triggerCard = (steps: HTMLElement) =>
  within(steps).getByRole("button", {
    name: /^(Trigger|On a schedule|By hand)/,
  });
/** Opens the trigger menu and chooses an item from it. */
const start = async (steps: HTMLElement, item: string) => {
  fireEvent.keyDown(triggerCard(steps), { key: "Enter" });
  const menu = await screen.findByRole("menu");
  const found = within(menu)
    .getAllByRole("menuitem")
    .find((element) => element.textContent.startsWith(item));
  if (!found) throw new Error(`the menu has no ${item}`);
  fireEvent.click(found);
  return screen.findByRole("complementary");
};
const addMenu = async (steps: HTMLElement) => {
  fireEvent.keyDown(
    within(steps).getByRole("button", { name: /^Add a step/ }),
    { key: "Enter" },
  );
  return screen.findByRole("menu");
};

test("a schedule reads as a person would say it", () => {
  const weekly = (weekdays: string[], time = "09:00", hour12 = false) =>
    scheduleText({ kind: "weekly", time, weekdays } as never, hour12);
  expect(weekly(["mon"])).toBe("Mondays at 9:00");
  // On a 12-hour clock the card reads as the time field beside it does.
  expect(weekly(["mon"], "17:30", true)).toBe("Mondays at 5:30 PM");
  expect(weekly(["mon"], "00:05", true)).toBe("Mondays at 12:05 AM");
  expect(weekly(["mon", "wed", "fri"], "17:30")).toBe(
    "Mon, Wed, and Fri at 17:30",
  );
  expect(weekly(["mon", "tue", "wed", "thu", "fri"])).toBe("Weekdays at 9:00");
  expect(weekly(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).toBe(
    "Every day at 9:00",
  );
  expect(weekly([])).toBe("Choose days");
  expect(scheduleText({ kind: "every_hours", hours: 6 })).toBe("Every 6 hours");
  expect(scheduleText({ kind: "every_hours", hours: 1 })).toBe("Every hour");
  expect(scheduleText({ kind: "every_hours", hours: 0 })).toBe(
    "Choose how often",
  );
});

test("the trigger menu offers On a schedule and When I run it after the ticket triggers", async () => {
  const steps = await open();
  fireEvent.keyDown(triggerCard(steps), { key: "Enter" });
  const menu = await screen.findByRole("menu");

  expect(
    within(menu)
      .getAllByRole("menuitem")
      .slice(-2)
      .map(
        (item) =>
          item.querySelector(".flow-menu-item-text")?.firstChild?.nodeValue,
      ),
  ).toEqual(["On a schedule", "When I run it"]);
});

test("a schedule is a time on chosen weekdays, or every few hours", async () => {
  const steps = await open({
    conditions: [{ kind: "tag", tag: "bug", has: true }],
  });

  const panel = await start(steps, "On a schedule");
  expect(stored.trigger).toEqual({
    kind: "schedule",
    schedule: { kind: "weekly", time: "09:00", weekdays: ["mon"] },
  });
  // Conditions are about a ticket, and nothing here starts from one: they are
  // kept for when a ticket trigger is chosen back, and neither asked nor shown.
  expect(stored.conditions).toEqual([{ kind: "tag", tag: "bug", has: true }]);
  expect(within(panel).queryByRole("button", { name: "Add condition" })).toBe(
    null,
  );
  expect(panel.textContent).toContain(
    "If ticketd is closed then, it runs once when ticketd next starts.",
  );
  // The clock, 12-hour or 24, is the computer's.
  expect(triggerCard(steps).getAttribute("aria-label")).toMatch(
    /^On a schedule: Mondays at 9:00( AM)?$/,
  );

  // Days are kept in the order of the week, whatever order they are chosen in.
  fireEvent.click(within(panel).getByRole("button", { name: "Friday" }));
  fireEvent.click(within(panel).getByRole("button", { name: "Wednesday" }));
  fireEvent.click(within(panel).getByRole("button", { name: "Monday" }));
  fireEvent.change(within(panel).getByLabelText("Time"), {
    target: { value: "17:30" },
  });
  expect(stored.trigger).toEqual({
    kind: "schedule",
    schedule: { kind: "weekly", time: "17:30", weekdays: ["wed", "fri"] },
  });
  expect(
    within(panel)
      .getByRole("button", { name: "Wednesday" })
      .getAttribute("aria-pressed"),
  ).toBe("true");

  fireEvent.click(
    within(panel).getByRole("radio", { name: "Every few hours" }),
  );
  expect(stored.trigger).toEqual({
    kind: "schedule",
    schedule: { kind: "every_hours", hours: 6 },
  });
  fireEvent.change(within(panel).getByRole("spinbutton", { name: "Hours" }), {
    target: { value: "2" },
  });
  expect(stored.trigger).toEqual({
    kind: "schedule",
    schedule: { kind: "every_hours", hours: 2 },
  });
  expect(triggerCard(steps).getAttribute("aria-label")).toBe(
    "On a schedule: Every 2 hours",
  );
  // A schedule is switched on like any Automation.
  expect(
    screen.getByRole("switch", { name: "On for this desktop" }),
  ).toBeTruthy();
});

test("a by-hand Automation has Run now in place of the On switch, and is not listed as off", async () => {
  const steps = await open({ trigger: { kind: "by_hand" } });

  expect(triggerCard(steps).getAttribute("aria-label")).toBe(
    "By hand: When you run it",
  );
  expect(screen.queryByRole("switch")).toBeNull();
  const row = within(
    screen.getByRole("list", { name: "Automations" }),
  ).getAllByRole("button")[0]!;
  expect(row.textContent).toContain("By hand");
  expect(row.textContent).not.toMatch(/Off|On/);
  expect(row.getAttribute("data-off")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Run now" }));

  await waitFor(() => expect(ranNow).toEqual(["automation-1"]));
  // The run it started is where the person looks next.
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Weekly summary" }))
        .getByRole("radio", { name: "Runs" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

test("Run now waits until every step is finished", async () => {
  await open({
    trigger: { kind: "by_hand" },
    steps: [
      { id: "run", kind: "run_agent", agent_id: null, execution_folder: null },
    ],
    problems: [{ step_id: "run", message: "Needs an agent and a folder" }],
  });

  const button = screen.getByRole<HTMLButtonElement>("button", {
    name: "Run now",
  });
  expect(button.disabled).toBe(true);
  expect(
    document.getElementById(button.getAttribute("aria-describedby") ?? "")
      ?.textContent,
  ).toBe("1 step left");
});

test.each([
  [
    "a schedule",
    { kind: "schedule", schedule: { kind: "every_hours", hours: 6 } },
  ],
  ["by hand", { kind: "by_hand" }],
] as const)(
  "Change ticket and If stay in the + menu, disabled with the reason, when it starts on %s",
  async (_name, trigger) => {
    const menu = await addMenu(await open({ trigger }));

    for (const name of [/^Change ticket/, /^If/]) {
      const item = within(menu).getByRole("menuitem", { name });
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.textContent).toContain(
        "Needs a ticket, and this Automation does not start from one",
      );
    }
    for (const name of [/^Run agent/, /^Notify me/])
      expect(
        within(menu)
          .getByRole("menuitem", { name })
          .getAttribute("aria-disabled"),
      ).toBeNull();
  },
);

test("a notification added where there is no ticket opens the run", async () => {
  const steps = await open({ trigger: { kind: "by_hand" } });
  const menu = await addMenu(steps);

  fireEvent.click(within(menu).getByRole("menuitem", { name: /^Notify me/ }));

  await waitFor(() =>
    expect(stored.steps[0]).toMatchObject({ kind: "notify", opens: "run" }),
  );
});

test("a message without a ticket is previewed with empty ticket fields, and no field can be inserted", async () => {
  const steps = await open({
    trigger: { kind: "by_hand" },
    steps: [
      {
        id: "tell",
        kind: "notify",
        text: "The week is up",
        opens: "run",
        on_failure: null,
      },
    ],
  });
  fireEvent.click(within(steps).getByRole("button", { name: /^Notify me/ }));
  const panel = await screen.findByRole("complementary", {
    name: "Notify me",
  });

  // The core is asked for the text as a run without a ticket fills it in.
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("automation_text_preview", {
      text: "The week is up",
      tag: null,
      hasTicket: false,
    }),
  );
  expect(panel.textContent).toContain(
    "This Automation runs without a ticket, so ticket fields stay empty.",
  );
  fireEvent.keyDown(
    within(panel).getByRole("button", { name: "Insert field" }),
    { key: "Enter" },
  );
  const menu = await screen.findByRole("menu");
  for (const item of within(menu).getAllByRole("menuitem")) {
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("Needs a ticket");
  }
});
