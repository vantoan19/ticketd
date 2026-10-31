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
