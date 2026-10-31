// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Reminder } from "./Reminder";

vi.mock("@tauri-apps/api/core", () => {
  let due: string | null = null;
  return {
    invoke: vi.fn(async (command: string, args: { dueAt?: string | null }) => {
      if (command === "set_reminder") due = args.dueAt ?? null;
      if (command === "reminder") return due;
    }),
  };
});

test("schedules and dismisses a ticket reminder", async () => {
  const view = render(<Reminder reference="T-1" revision={0} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage reminder" }));
  fireEvent.change(screen.getByLabelText("Local reminder date and time"), {
    target: { value: "2030-01-01T12:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
  await screen.findByText(/Scheduled:/);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss reminder" }));
  await waitFor(() => expect(screen.queryByText(/Scheduled:/)).toBeNull());
  view.unmount();
});

test("requires a choice for repeated local times and rejects skipped times", () => {
  const original = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const view = render(<Reminder reference="T-1" revision={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage reminder" }));
    const input = screen.getByLabelText("Local reminder date and time");
    fireEvent.change(input, { target: { value: "2030-03-10T02:30" } });
    expect(screen.getByRole("alert").textContent).toContain("skipped");
    expect(screen.getByRole("button", { name: "Set reminder" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.change(input, { target: { value: "2030-11-03T01:30" } });
    expect(
      screen.getByLabelText("Clock change: choose which occurrence"),
    ).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText("Clock change: choose which occurrence"),
      { target: { value: "2030-11-03T05:30:00.000Z" } },
    );
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
  const view = render(<Reminder reference="T-2" revision={0} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage reminder" }));
  await screen.findByText(/Scheduled:/);
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
  const view = render(<Reminder reference="T-3" revision={0} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage reminder" }));
  await screen.findByText(/Scheduled:/);
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
