// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AutomationsPage } from "@/features/settings/pages/AutomationsPage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/** The device's settings and Automations, changed by the same commands the page sends. */
let startsAtLogin = false;
let refuse = "";
let automations: unknown[] = [];

const automation = (
  id: string,
  trigger: unknown,
  enabled: boolean,
): Record<string, unknown> => ({
  id,
  name: id,
  trigger,
  conditions: [],
  steps: [],
  enabled,
  arrived_off: false,
  problems: [],
  has_ticket: false,
});
const onSchedule = {
  kind: "schedule",
  schedule: { kind: "every_hours", hours: 4 },
};
const onTicket = { kind: "ticket_created" };

beforeEach(() => {
  startsAtLogin = false;
  refuse = "";
  automations = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { enabled } = (args ?? {}) as { enabled?: boolean };
    if (command === refuse) throw new Error("not allowed here");
    switch (command) {
      case "start_at_login":
        return startsAtLogin;
      case "set_start_at_login":
        startsAtLogin = enabled ?? false;
        return null;
      case "automation_list":
        return automations;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
});
afterEach(cleanup);

const loginSwitch = () =>
  screen.getByRole("switch", { name: "Start ticketd when you sign in" });
const page = () => render(<AutomationsPage onOpenAutomations={() => {}} />);

test("the page is the sign-in switch, off, and the way to Automations; nothing sets runs at once", async () => {
  page();
  await waitFor(() => expect(loginSwitch()).toHaveProperty("disabled", false));
  expect(loginSwitch().getAttribute("aria-checked")).toBe("false");
  expect(
    screen.getByText(
      "Scheduled Automations run only while ticketd is running.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Open Automations")).toBeTruthy();
  expect(
    screen.getByText("Build them, and choose which ones run on this computer."),
  ).toBeTruthy();
  // Runs at once and the tray footer are gone; the default of 2 stays in the core.
  expect(screen.queryByText("Runs at once")).toBeNull();
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.queryByText(/closing the window keeps ticketd/i)).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("automation_runs_at_once");
});

test("the Open Automations row opens the Automations view, from the row or its chevron", async () => {
  const open = vi.fn();
  render(<AutomationsPage onOpenAutomations={open} />);
  await waitFor(() => expect(loginSwitch()).toHaveProperty("disabled", false));

  fireEvent.click(screen.getByRole("button", { name: "Open Automations" }));
  fireEvent.click(
    screen.getByText("Build them, and choose which ones run on this computer."),
  );
  expect(open).toHaveBeenCalledTimes(2);
});

test("with scheduled Automations on and the switch off, the row says so as a fact", async () => {
  automations = [
    automation("a", onSchedule, true),
    automation("b", onSchedule, true),
    // Off for this computer, or not scheduled: not counted.
    automation("c", onSchedule, false),
    automation("d", onTicket, true),
  ];
  page();
  expect(
    await screen.findByText("2 Automations run on a schedule."),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();

  // Switched on, ticketd starts at sign-in and the line has nothing to say.
  fireEvent.click(loginSwitch());
  await waitFor(() =>
    expect(loginSwitch().getAttribute("aria-checked")).toBe("true"),
  );
  expect(screen.queryByText(/run on a schedule/)).toBeNull();
});

test("one scheduled Automation is said in the singular, none is not said", async () => {
  automations = [automation("a", onSchedule, true)];
  const { unmount } = page();
  expect(
    await screen.findByText("1 Automation runs on a schedule."),
  ).toBeTruthy();
  unmount();

  automations = [automation("d", onTicket, true)];
  page();
  await waitFor(() => expect(loginSwitch()).toHaveProperty("disabled", false));
  expect(invoke).toHaveBeenCalledWith("automation_list");
  expect(screen.queryByText(/on a schedule/)).toBeNull();
});

test("the switch starts ticketd at sign-in and says so when the system refuses", async () => {
  page();
  await waitFor(() => expect(loginSwitch()).toHaveProperty("disabled", false));

  fireEvent.click(loginSwitch());
  await waitFor(() =>
    expect(loginSwitch().getAttribute("aria-checked")).toBe("true"),
  );
  expect(startsAtLogin).toBe(true);

  refuse = "set_start_at_login";
  fireEvent.click(loginSwitch());
  expect((await screen.findByRole("alert")).textContent).not.toContain(
    "not allowed here",
  );
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText("not allowed here")).toBeTruthy();
  expect(loginSwitch().getAttribute("aria-checked")).toBe("true");
});
