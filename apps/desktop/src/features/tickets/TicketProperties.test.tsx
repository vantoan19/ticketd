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
        reference: "T-KQ1",
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
  fireEvent.click(screen.getByRole("button", { name: /Project: No project/ }));
  const search = await screen.findByLabelText("Search projects");
  fireEvent.change(search, {
    target: { value: "Project" },
  });
  fireEvent.keyDown(search, {
    key: "Enter",
  });
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "The result couldn't be confirmed",
    ),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Project: No project/ }),
    ),
  );
});

test("a duplicate links to its canonical ticket beside the status, even in trash", () => {
  const open = vi.fn();
  render(
    <TicketProperties
      ticket={{
        id: "1",
        reference: "T-KQ1",
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
        duplicate_of: "T-KQ9",
      }}
      projects={[]}
      plans={[]}
      onSaved={() => {}}
      refresh={async () => {}}
      onOpenTicket={open}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Duplicate of T-KQ9" }));
  expect(open).toHaveBeenCalledWith("T-KQ9");
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
        reference: "T-KQ1",
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
    await screen.findByRole("heading", { name: "Mark T-KQ1 as a duplicate" }),
  ).toBeTruthy();
  expect(bridge.invoke).not.toHaveBeenCalledWith(
    "change_ticket",
    expect.anything(),
  );
});

test("a Duplicate ticket's status menu checks Duplicate, never the action", async () => {
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
        reference: "T-KQ1",
        title: "Ticket",
        body: "",
        status: "Duplicate",
        duplicate_of: "T-KQ9",
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
  fireEvent.keyDown(
    screen.getByRole("combobox", { name: "Status: Duplicate" }),
    { key: "Enter" },
  );
  const current = await screen.findByRole("option", { name: "Duplicate" });
  expect(current.getAttribute("aria-selected")).toBe("true");
  const action = screen.getByRole("option", {
    name: "Change canonical ticket…",
  });
  expect(action.getAttribute("aria-selected")).toBe("false");
  expect(
    screen.queryByRole("option", { name: "Mark as duplicate…" }),
  ).toBeNull();
});

test("changing the status of a duplicate asks before removing its link", async () => {
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
        reference: "T-KQ1",
        title: "Ticket",
        body: "",
        status: "Duplicate",
        tags: [],
        project_id: null,
        plan_id: null,
        trashed: false,
        availability: null,
        parent: null,
        children: [],
        prerequisites: [],
        duplicate_of: "T-KQ8",
      }}
      projects={[]}
      plans={[]}
      onSaved={() => {}}
      refresh={async () => {}}
    />,
  );
  fireEvent.keyDown(
    screen.getByRole("combobox", { name: "Status: Duplicate" }),
    { key: "Enter" },
  );
  fireEvent.click(await screen.findByRole("option", { name: "Todo" }));
  expect(
    await screen.findByText(/removes the duplicate link to T-KQ8/),
  ).toBeTruthy();
  expect(bridge.invoke).not.toHaveBeenCalledWith(
    "change_ticket",
    expect.anything(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Change status" }));
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith(
      "change_ticket",
      expect.objectContaining({
        patch: expect.objectContaining({ status: "Todo" }),
      }),
    ),
  );
});

test("a trashed ticket's rail stays readable and cannot be changed", () => {
  bridge.invoke.mockResolvedValue([]);
  render(
    <TicketProperties
      ticket={{
        id: "1",
        reference: "T-KQ1",
        title: "Ticket",
        body: "",
        status: "Todo",
        tags: [],
        project_id: null,
        plan_id: null,
        trashed: true,
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
  // One notice in the document says In Trash; the rail keeps its shape and
  // its values stay readable but cannot be changed.
  expect(screen.queryByRole("note")).toBeNull();
  const project = screen.getByRole("button", { name: "Project: No project" });
  expect(project).toHaveProperty("disabled", true);
  expect(project.getAttribute("data-readonly")).not.toBeNull();
});

test("focus returns to the Status trigger after a status change", async () => {
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
        reference: "T-KQ1",
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
  let savedFrom: Element | null = null;
  const trigger = screen.getByRole("combobox", { name: "Status: Todo" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  const option = await screen.findByRole("option", { name: "In progress" });
  option.focus();
  // A browser drops focus to the page once the list closes and the trigger
  // is disabled while saving; jsdom does not, so do it after Radix has settled.
  bridge.invoke.mockImplementationOnce(async () => {
    savedFrom = document.activeElement;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    return {};
  });
  fireEvent.keyDown(option, { key: "Enter" });
  await waitFor(() => expect(savedFrom).not.toBeNull());
  expect((savedFrom as HTMLElement | null)?.closest("aside")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("focus returns to the Status trigger while a closing option still holds focus", async () => {
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
        reference: "T-KQ1",
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
  let savedFrom: Element | null = null;
  const trigger = screen.getByRole("combobox", { name: "Status: Todo" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  const option = await screen.findByRole("option", { name: "In progress" });
  option.focus();
  // A browser drops focus to the page once the list closes and the trigger
  // is disabled while saving; jsdom does not, so do it after Radix has settled.
  bridge.invoke.mockImplementationOnce(async () => {
    savedFrom = document.activeElement;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Focus is still on a closing list option when the save settles.
    const list = document.body.appendChild(document.createElement("div"));
    list.setAttribute("role", "listbox");
    const closing = list.appendChild(document.createElement("div"));
    closing.tabIndex = -1;
    closing.focus();
    return {};
  });
  fireEvent.keyDown(option, { key: "Enter" });
  await waitFor(() => expect(savedFrom).not.toBeNull());
  expect((savedFrom as HTMLElement | null)?.closest("aside")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
