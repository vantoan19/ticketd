// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Evidence } from "./Evidence";

vi.mock("@tauri-apps/api/core", () => {
  let items: unknown[] = [];
  return {
    invoke: vi.fn(
      async (command: string, args: { input?: object; id?: string }) => {
        if (command === "list_evidence") return items;
        if (command === "add_evidence") {
          const item = {
            ...args.input,
            id: "1",
            created_at: "now",
            updated_at: "now",
          };
          items = [item];
          return item;
        }
        if (command === "delete_evidence") {
          items = [];
          return;
        }
      },
    ),
  };
});
test("adds and removes a verification result", async () => {
  render(
    <Evidence
      reference="T-1"
      revision={0}
      trashed={false}
      refresh={async () => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("Type"), {
    target: { value: "verification" },
  });
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Tests" },
  });
  fireEvent.change(screen.getByLabelText("What was checked and its outcome"), {
    target: { value: "Unit tests passed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
  expect(await screen.findByText("Unit tests passed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(screen.queryByText("Unit tests passed")).toBeNull(),
  );
});
