// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, test, expect } from "vitest";
import { Inbox } from "./Inbox";

vi.mock("@tauri-apps/api/core", () => {
  let read = false;
  return {
    invoke: vi.fn(async (command: string) => {
      if (command === "set_inbox_read") read = true;
      if (command === "inbox")
        return [
          {
            id: 1,
            reference: "T-1",
            title: "First",
            kind: "status",
            from_value: "Todo",
            to_value: "Done",
            timestamp: "now",
            read,
          },
          {
            id: 2,
            reference: "T-2",
            title: "Finding",
            kind: "note",
            from_value: "note-id",
            to_value: "Original note",
            timestamp: "now",
            read: false,
            editing_agent: "agent",
          },
        ];
    }),
  };
});

test("opens an entry without marking it read and explicitly marks displayed entries", async () => {
  const select = vi.fn();
  const view = render(<Inbox revision={0} select={select} />);
  fireEvent.click(await screen.findByRole("button", { name: /T-1.*First/ }));
  expect(select).toHaveBeenCalledWith("T-1");
  expect(screen.getAllByText("Unread")[0]).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Mark displayed read" }));
  await waitFor(() => expect(screen.getAllByText("Read")[0]).toBeTruthy());
  view.unmount();
});

test("opens the note identified by an inbox entry and shows its original text", async () => {
  const select = vi.fn();
  render(<Inbox revision={0} select={select} />);
  fireEvent.click(await screen.findByRole("button", { name: /T-2.*Finding/ }));
  expect(select).toHaveBeenCalledWith("T-2", "note-id");
  expect(screen.getByText(/New note: Original note/)).toBeTruthy();
});
