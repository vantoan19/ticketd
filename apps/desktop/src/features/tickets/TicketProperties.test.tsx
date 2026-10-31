// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TicketProperties } from "./TicketProperties";
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});
test("keeps the saved project and reports a failed change", async () => {
  bridge.invoke.mockRejectedValue(new Error("Database busy; retry"));
  render(
    <TicketProperties
      ticket={{
        id: "1",
        reference: "T-1",
        title: "Ticket",
        body: "",
        status: "Todo",
        tags: [],
        project_id: null,
        effort_id: null,
        trashed: false,
        availability: null,
        parent: null,
        children: [],
        prerequisites: [],
      }}
      projects={[{ id: "p", name: "Project", path: "/p", paths: [] }]}
      efforts={[]}
      onSaved={() => {}}
      refresh={async () => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Project: Unlinked/ }));
  const search = await screen.findByLabelText("Search Project");
  fireEvent.change(search, {
    target: { value: "Project" },
  });
  fireEvent.keyDown(search, {
    key: "Enter",
  });
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Database busy; retry",
    ),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Project: Unlinked/ }),
    ),
  );
});
