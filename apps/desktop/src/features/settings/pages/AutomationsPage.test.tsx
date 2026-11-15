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

/** The device's settings, changed by the same commands the page sends. */
let runsAtOnce = 2;
let startsAtLogin = false;
let refuse = "";
beforeEach(() => {
  runsAtOnce = 2;
  startsAtLogin = false;
  refuse = "";
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { runs, enabled } = (args ?? {}) as {
      runs?: number;
      enabled?: boolean;
    };
    if (command === refuse) throw new Error("not allowed here");
    switch (command) {
      case "automation_runs_at_once":
        return { runs: runsAtOnce, default: 2, most: 10 };
      case "set_automation_runs_at_once":
        runsAtOnce = runs ?? 0;
        return null;
      case "start_at_login":
        return startsAtLogin;
      case "set_start_at_login":
        startsAtLogin = enabled ?? false;
        return null;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
});
afterEach(cleanup);

const runsField = () =>
  screen.findByRole<HTMLInputElement>("spinbutton", { name: "Runs at once" });
const loginSwitch = () =>
  screen.getByRole("switch", { name: "Start ticketd when you sign in" });

test("the page shows two runs at once by default, start at sign-in off, and what closing the window does", async () => {
  render(<AutomationsPage />);

  await waitFor(async () => expect((await runsField()).value).toBe("2"));
  expect(screen.getByText("Default")).toBeTruthy();
  await waitFor(() => expect(loginSwitch()).toHaveProperty("disabled", false));
  expect(loginSwitch().getAttribute("aria-checked")).toBe("false");
  expect(
    screen.getByText(
      "While an Automation is on, closing the window keeps ticketd running in the tray, as it does for a working Chat. Quit from the tray icon to stop everything.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Changes apply right away")).toBeTruthy();
});

test("a new runs-at-once value is saved when the field is left, and the default can be put back", async () => {
  render(<AutomationsPage />);
  const field = await runsField();
  await waitFor(() => expect(field.value).toBe("2"));

  fireEvent.change(field, { target: { value: "4" } });
  fireEvent.blur(field);

  await screen.findByText("Saved");
  expect(runsAtOnce).toBe(4);
  fireEvent.click(screen.getByRole("button", { name: "Use the default, 2" }));
  await waitFor(() => expect(runsAtOnce).toBe(2));
  expect(field.value).toBe("2");
});

test("a runs-at-once value outside 1 to 10 is refused without saving", async () => {
  render(<AutomationsPage />);
  const field = await runsField();
  await waitFor(() => expect(field.value).toBe("2"));

  for (const value of ["0", "11", "1.5", ""]) {
    fireEvent.change(field, { target: { value } });
    fireEvent.blur(field);
    expect(screen.getByRole("alert").textContent).toBe(
      "Enter a whole number from 1 to 10.",
    );
  }

  expect(runsAtOnce).toBe(2);
  expect(invoke).not.toHaveBeenCalledWith(
    "set_automation_runs_at_once",
    expect.anything(),
  );
});

test("the switch starts ticketd at sign-in and says so when the system refuses", async () => {
  render(<AutomationsPage />);
  await waitFor(() => expect(loginSwitch()).toHaveProperty("disabled", false));

  fireEvent.click(loginSwitch());
  await waitFor(() =>
    expect(loginSwitch().getAttribute("aria-checked")).toBe("true"),
  );
  expect(startsAtLogin).toBe(true);

  refuse = "set_start_at_login";
  fireEvent.click(loginSwitch());
  expect((await screen.findByRole("alert")).textContent).toContain(
    "not allowed here",
  );
  expect(loginSwitch().getAttribute("aria-checked")).toBe("true");
});
