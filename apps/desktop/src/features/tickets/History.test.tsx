// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { History, StatusControl } from "./History";
Element.prototype.scrollIntoView = () => {};
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});
test("shows a failed status save while history is closed", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "ticket_history") return [];
    throw new Error("Database busy; retry");
  });
  render(
    <>
      <StatusControl
        reference="T-1"
        status="Todo"
        trashed={false}
        onChange={async () => {}}
      />
      <History reference="T-1" status="Todo" revision={0} projects={[]} />
    </>,
  );
  fireEvent.keyDown(screen.getByLabelText("Status"), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: "Done" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Database busy; retry",
    ),
  );
  expect(screen.getByText("Activity & history").closest("details")?.open).toBe(
    false,
  );
});
