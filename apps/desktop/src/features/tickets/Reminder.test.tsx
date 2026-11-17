// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { TestOpenTicket } from "./open-ticket/testing";
import { Reminder } from "./Reminder";
import { reminderPresets } from "./reminder-presets";

vi.mock("@tauri-apps/api/core", () => {
  let due: string | null = null;
  return {
    invoke: vi.fn(
      async (
        command: string,
        args: { dueAt?: string | null; reference?: string },
      ) => {
        if (command === "show_ticket")
          return {
            id: args.reference,
            reference: args.reference,
            trashed: false,
          };
        if (command === "set_reminder") due = args.dueAt ?? null;
        if (command === "reminder") return due;
      },
    ),
  };
});
// The preset list (cmdk) and the clock-change select need these.
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

/** The reminder of an open ticket, as the Open Ticket serves it. */
function reminderOf(reference: string) {
  const ticket = { id: reference, reference, trashed: false } as Ticket;
  return (
    <TestOpenTicket ticket={ticket}>
      <Reminder />
    </TestOpenTicket>
  );
}

/** Opens the popover and reveals the date and time field. */
async function openCustom() {
  fireEvent.click(screen.getByRole("button", { name: "Manage reminder" }));
  fireEvent.click(await screen.findByRole("option", { name: "Custom…" }));
  return screen.getByLabelText("Date and time");
}

test("schedules and dismisses a ticket reminder", async () => {
  const view = render(reminderOf("T-KQ1"));
  const field = await openCustom();
  // Prefilled, so it never looks filled while being empty.
  expect((field as HTMLInputElement).value).not.toBe("");
  fireEvent.change(field, { target: { value: "2030-01-01T12:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
  await screen.findByText(/Scheduled for/);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss reminder" }));
  await waitFor(() => expect(screen.queryByText(/Scheduled for/)).toBeNull());
  view.unmount();
});

test("a change to the reminder is reported, so what is on screen is current", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const view = render(reminderOf("T-KQ5"));
  fireEvent.click(screen.getByRole("button", { name: "Manage reminder" }));
  vi.mocked(invoke).mockClear();
  fireEvent.click(await screen.findByRole("option", { name: /^Tomorrow/ }));
  await screen.findByText(/Scheduled for/);
  // The write report re-reads what is visible, here the Ticket itself.
  expect(invoke).toHaveBeenCalledWith("show_ticket", { reference: "T-KQ5" });
  fireEvent.click(
    await screen.findByRole("button", { name: "Dismiss reminder" }),
  );
  await waitFor(() => expect(screen.queryByText(/Scheduled for/)).toBeNull());
  view.unmount();
});

test("a preset schedules at once at its resolved time", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const view = render(reminderOf("T-KQ4"));
  fireEvent.click(screen.getByRole("button", { name: "Manage reminder" }));
  fireEvent.click(await screen.findByRole("option", { name: /^Tomorrow/ }));
  const tomorrow = reminderPresets(new Date()).find(
    (preset) => preset.key === "tomorrow",
  )!.at;
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "set_reminder",
      expect.objectContaining({ dueAt: tomorrow.toISOString() }),
    ),
  );
  expect(tomorrow.getHours()).toBe(9);
  fireEvent.click(
    await screen.findByRole("button", { name: "Dismiss reminder" }),
  );
  await waitFor(() => expect(screen.queryByText(/Scheduled for/)).toBeNull());
  view.unmount();
});

test("requires a choice for repeated local times and rejects skipped times", async () => {
  const original = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const view = render(reminderOf("T-KQ1"));
    const input = await openCustom();
    fireEvent.change(input, { target: { value: "2030-03-10T02:30" } });
    expect(screen.getByRole("alert").textContent).toContain("skips this time");
    expect(screen.getByRole("button", { name: "Set reminder" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.change(input, { target: { value: "2030-11-03T01:30" } });
    const choice = screen.getByRole("combobox", { name: /^Clock change/ });
    expect(screen.getByRole("button", { name: "Set reminder" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.keyDown(choice, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /UTC−04:00/ }));
    expect(screen.getByRole("button", { name: "Set reminder" })).toHaveProperty(
      "disabled",
      false,
    );
    view.unmount();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("a year still being typed is not blamed on a clock change", async () => {
  const view = render(reminderOf("T-KQ1"));
  fireEvent.change(await openCustom(), {
    target: { value: "0006-01-01T12:00" },
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Set reminder" })).toHaveProperty(
    "disabled",
    true,
  );
  view.unmount();
});

test("retries a lost snooze response with the original request and instant", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const bridge = vi.mocked(invoke);
  bridge.mockReset();
  const saved = new Map<string, string | null>();
  let due: string | null = "2020-01-01T00:00:00Z";
  let loseResponse = true;
  vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  bridge.mockImplementation(async (command, args) => {
    if (command === "reminder") return due;
    if (command === "set_reminder") {
      const { requestId, dueAt } = args as {
        requestId: string;
        dueAt: string | null;
      };
      if (!saved.has(requestId)) {
        saved.set(requestId, dueAt);
        due = dueAt;
      }
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost");
      }
    }
  });
  const view = render(reminderOf("T-KQ2"));
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage reminder, due" }),
  );
  await screen.findByText(/Due since/);
  fireEvent.click(screen.getByRole("button", { name: "Snooze 1 hour" }));
  await screen.findByRole("alert");
  vi.spyOn(Date, "now").mockReturnValue(1_900_000_060_000);
  fireEvent.click(screen.getByRole("button", { name: "Snooze 1 hour" }));
  await waitFor(() =>
    expect(
      bridge.mock.calls.filter(([cmd]) => cmd === "set_reminder"),
    ).toHaveLength(2),
  );
  const calls = bridge.mock.calls.filter(([cmd]) => cmd === "set_reminder");
  expect(calls[0]?.[1]).toEqual(calls[1]?.[1]);
  expect(saved.size).toBe(1);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Snooze 1 hour" }));
  await waitFor(() => expect(saved.size).toBe(2));
  view.unmount();
  vi.restoreAllMocks();
});

test("prevents a second reminder change while a write is pending", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const bridge = vi.mocked(invoke);
  bridge.mockReset();
  let complete: () => void = () => {};
  bridge.mockImplementation(async (command) => {
    if (command === "reminder") return "2030-01-01T00:00:00Z";
    if (command === "set_reminder")
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
  });
  const view = render(reminderOf("T-KQ3"));
  fireEvent.click(
    await screen.findByRole("button", { name: /^Manage reminder, scheduled/ }),
  );
  await screen.findByText(/Scheduled for/);
  const snooze = screen.getByRole("button", { name: "Snooze 1 hour" });
  fireEvent.click(snooze);
  expect(snooze).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: "Dismiss reminder" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(snooze);
  expect(
    bridge.mock.calls.filter(([cmd]) => cmd === "set_reminder"),
  ).toHaveLength(1);
  complete();
  await waitFor(() => expect(snooze).toHaveProperty("disabled", false));
  view.unmount();
});

test("legacy custom reminder refuses a past time and rechecks expiry before saving", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValue(new Date(2030, 0, 1, 10).getTime());
  const view = render(reminderOf("T-KQ9"));
  try {
    const field = await openCustom();
    fireEvent.change(field, { target: { value: "2030-01-01T09:00" } });
    expect(
      screen.getByText("This time has passed. Choose a future time."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Set reminder|Reschedule/ }),
    ).toHaveProperty("disabled", true);
    fireEvent.change(field, { target: { value: "2030-01-01T11:00" } });
    const submit = screen.getByRole("button", {
      name: /Set reminder|Reschedule/,
    });
    expect(submit).toHaveProperty("disabled", false);
    vi.mocked(invoke).mockClear();
    now.mockReturnValue(new Date(2030, 0, 1, 12).getTime());
    fireEvent.click(submit);
    expect(
      screen.getByText("This time has passed. Choose a future time."),
    ).toBeTruthy();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "set_reminder"),
    ).toBe(false);
  } finally {
    now.mockRestore();
    view.unmount();
  }
});
