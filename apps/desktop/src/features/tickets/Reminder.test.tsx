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
  render(<Reminder reference="T-1" revision={0} />);
  fireEvent.change(screen.getByLabelText("Reminder time with offset"), {
    target: { value: "2030-01-01T12:00:00Z" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
  await screen.findByText(/Scheduled:/);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss reminder" }));
  await waitFor(() => expect(screen.queryByText(/Scheduled:/)).toBeNull());
});
