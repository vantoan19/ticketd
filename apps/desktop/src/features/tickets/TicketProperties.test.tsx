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
        plan_id: null,
        trashed: false,
        availability: null,
        parent: null,
        children: [],
        prerequisites: [],
      }}
      projects={[{ id: "p", name: "Project", path: "/p", paths: [] }]}
      plans={[]}
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

test("a duplicate links to its canonical ticket beside the status, even in trash", () => {
  const open = vi.fn();
  render(
    <TicketProperties
      ticket={{
        id: "1",
        reference: "T-1",
        title: "Ticket",
        body: "",
        status: "Duplicate",
        tags: [],
        project_id: null,
        plan_id: null,
        trashed: true,
        availability: null,
        parent: null,
        children: [],
        prerequisites: [],
        duplicate_of: "T-9",
      }}
      projects={[]}
      plans={[]}
      onSaved={() => {}}
      refresh={async () => {}}
      onOpenTicket={open}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Duplicate of T-9" }));
  expect(open).toHaveBeenCalledWith("T-9");
});

test("choosing Duplicate from the status menu opens the duplicate review instead of saving", async () => {
  Object.assign(Element.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  });
  bridge.invoke.mockResolvedValue({});
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
        plan_id: null,
        trashed: false,
        availability: null,
        parent: null,
        children: [],
        prerequisites: [],
      }}
      projects={[]}
      plans={[]}
      onSaved={() => {}}
      refresh={async () => {}}
    />,
  );
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Status: Todo" }), {
    key: "Enter",
  });
  fireEvent.click(
    await screen.findByRole("option", { name: "Mark as duplicate…" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Mark as duplicate" }),
  ).toBeTruthy();
  expect(bridge.invoke).not.toHaveBeenCalledWith(
    "change_ticket",
    expect.anything(),
  );
});
