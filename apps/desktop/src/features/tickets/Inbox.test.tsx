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
        ];
    }),
  };
});

test("opens an entry without marking it read and explicitly marks displayed entries", async () => {
  const select = vi.fn();
  render(<Inbox revision={0} select={select} />);
  fireEvent.click(await screen.findByRole("button", { name: /T-1.*First/ }));
  expect(select).toHaveBeenCalledWith("T-1");
  expect(screen.getByText("Unread")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Mark displayed read" }));
  await waitFor(() => expect(screen.getByText("Read")).toBeTruthy());
});
