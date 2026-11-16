// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "@/app/App";
import { bridgeDefault } from "@/test/bridge-defaults";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub;
Element.prototype.scrollIntoView = () => {};
Object.defineProperty(window, "matchMedia", {
  value: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
});

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => {
    if (command === "find_tickets_with_updates") {
      const tickets: unknown[] = await bridge.invoke("find_tickets", args);
      return tickets.map((ticket) => ({ ticket, latest_update: null }));
    }
    return bridge.invoke(command, args);
  },
}));

type Fake = { id: string; reference: string; status: string; plan: string };
let plans: { id: string; name: string; archived: boolean; purpose: string }[] =
  [];
let tickets: Fake[] = [];
const calls: [string, unknown][] = [];

const ticket = (item: Fake) => ({
  id: item.id,
  reference: item.reference,
  title: `Title of ${item.reference}`,
  body: "",
  status: item.status,
  trashed: false,
  tags: [] as string[],
  project_id: null,
  plan_id: item.plan || null,
  availability: null,
  prerequisites: [],
  parent: null,
  children: [],
});

beforeEach(() => {
  plans = [{ id: "e1", name: "Launch", archived: false, purpose: "" }];
  tickets = [
    { id: "1", reference: "T-KQ1", status: "Todo", plan: "e1" },
    { id: "2", reference: "T-KQ2", status: "Done", plan: "e1" },
    { id: "3", reference: "T-KQ3", status: "Todo", plan: "" },
  ];
  calls.length = 0;
  bridge.invoke.mockImplementation(async (command: string, args: never) => {
    const input = args as Record<string, never> | undefined;
    calls.push([command, input]);
    switch (command) {
      case "list_plans":
        return plans;
      case "show_plan": {
        const members = tickets.filter((item) => item.plan === input?.id);
        const count = (status: string) =>
          members.filter((item) => item.status === status).length;
        return {
          plan: plans.find((item) => item.id === input?.id),
          members: members.map(ticket),
          counts: {
            todo: count("Todo"),
            in_progress: count("In progress"),
            in_review: count("In review"),
            done: count("Done"),
            canceled: count("Canceled"),
            duplicate: count("Duplicate"),
          },
        };
      }
      case "search_tickets":
        return tickets
          .filter((item) =>
            `${item.reference} Title of ${item.reference}`
              .toLowerCase()
              .includes(String(input?.query ?? "").toLowerCase()),
          )
          .map(ticket);
      case "find_tickets": {
        const plan = (input?.filter as unknown as { plan: string | null }).plan;
        return tickets
          .filter((item) => !plan || item.plan === plan)
          .map(ticket);
      }
      case "set_plan_purpose": {
        const target = plans.find((item) => item.id === input?.id);
        if (target) target.purpose = input?.purpose ?? "";
        return target;
      }
      case "bulk_change": {
        const change = input as unknown as {
          references: string[];
          change: { plan_id: string | null };
        };
        const selected = tickets.filter((item) =>
          change.references.includes(item.reference),
        );
        for (const item of selected) item.plan = change.change.plan_id ?? "";
        return selected.map(ticket);
      }
      case "set_plan": {
        const target = tickets.find(
          (item) => item.reference === input?.reference,
        );
        if (target)
          target.plan = (input?.plan as unknown as string | null) ?? "";
        return target ? ticket(target) : null;
      }
      case "change_plan": {
        const target = plans.find((item) => item.id === input?.id);
        if (target) {
          if (input?.name) target.name = input.name;
          if (input?.archived !== null && input?.archived !== undefined)
            target.archived = input.archived;
        }
        return target;
      }
      case "list_projects":
        return [];
      case "count_tickets":
        return bridgeDefault(command);
      default:
        return [];
    }
  });
});
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

async function chooseAction(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: "Plan actions" }), {
    key: "Enter",
  });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: new RegExp(`^${name}`) }),
  );
}
async function openLaunch() {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
  const heading = await screen.findByRole("heading", { name: "Launch" });
  await screen.findByRole("img", { name: /Launch, .* done/ });
  return heading;
}
const context = () => screen.getByRole("group", { name: "Plan context" });

test("the header counts the Plan's tickets and its progress, and Remove from Plan offers Undo", async () => {
  tickets.push({
    id: "4",
    reference: "T-KQ4",
    status: "Duplicate",
    plan: "e1",
  });
  const heading = await openLaunch();
  // The count sits beside the name; per-status counts live in the groups.
  expect(heading.parentElement!.textContent).toContain("3");
  expect(within(context()).getByText("1 of 2 done")).toBeTruthy();
  expect(
    screen.getByRole("img", { name: "Launch, 1 of 2 done, 0 moving" }),
  ).toBeTruthy();
  // An active Plan shows no state chip (plans PL-05).
  expect(screen.queryByText("Active Plan")).toBeNull();

  fireEvent.click(
    screen.getByRole("button", { name: "Remove T-KQ1 from Launch" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /^T-KQ1/ })).toBeNull(),
  );
  await waitFor(() => expect(screen.getByText("1 of 1 done")).toBeTruthy());
  expect(calls).toContainEqual([
    "set_plan",
    { reference: "T-KQ1", plan: null },
  ]);
  expect(await screen.findByText("Removed T-KQ1 from Launch")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(calls).toContainEqual([
      "set_plan",
      { reference: "T-KQ1", plan: "e1" },
    ]),
  );
});

test("progress leaves out Canceled and Duplicate tickets", async () => {
  tickets = [
    { id: "1", reference: "T-KQ1", status: "Done", plan: "e1" },
    { id: "2", reference: "T-KQ2", status: "Canceled", plan: "e1" },
    { id: "3", reference: "T-KQ3", status: "Duplicate", plan: "e1" },
  ];
  await openLaunch();
  expect(await screen.findByText("1 of 1 done")).toBeTruthy();
});

test("an empty name says so in the context line and changes nothing", async () => {
  await openLaunch();
  await chooseAction("Rename");
  const field = screen.getByRole("textbox", { name: "Plan name" });
  fireEvent.change(field, { target: { value: "   " } });
  fireEvent.keyDown(field, { key: "Enter" });
  const error = await within(context()).findByRole("alert");
  expect(error.textContent).toBe("A Plan needs a name.");
  expect(calls.some(([command]) => command === "change_plan")).toBe(false);
  expect((field as HTMLInputElement).value).toBe("   ");
});

test("renames the Plan", async () => {
  await openLaunch();
  await chooseAction("Rename");
  const field = screen.getByRole("textbox", { name: "Plan name" });
  fireEvent.change(field, { target: { value: "Release" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await screen.findByRole("heading", { name: "Release" });
  expect(calls).toContainEqual([
    "change_plan",
    { id: "e1", name: "Release", archived: null },
  ]);
});

test("Escape cancels an in-place rename and keeps the name", async () => {
  await openLaunch();
  await chooseAction("Rename");
  const field = screen.getByRole("textbox", { name: "Plan name" });
  fireEvent.change(field, { target: { value: "Other" } });
  fireEvent.keyDown(field, { key: "Escape" });
  expect(screen.getByRole("heading", { name: "Launch" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Plan name" })).toBeNull();
  expect(calls.some(([command]) => command === "change_plan")).toBe(false);
});

test("a failed archive says why on the status line and changes nothing", async () => {
  // Plans PL-12 and PL-13: a plain failure with Retry, never a raw banner.
  const answer = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command: string, args: never) => {
    if (command === "change_plan") throw new Error("The workspace is locked");
    return answer(command, args);
  });
  await openLaunch();
  await chooseAction("Archive Plan");
  const failure = await screen.findByRole("alert");
  expect(failure.textContent).toContain("Couldn't archive Launch.");
  expect(plans[0]?.archived).toBe(false);
  expect(
    screen.queryByText("Archived", { selector: '[data-slot="badge"]' }),
  ).toBeNull();
});

test("archiving acts at once with Undo; an archived Plan reactivates from the Plans page", async () => {
  await openLaunch();
  await chooseAction("Archive Plan");
  await screen.findByText("Archived", { selector: '[data-slot="badge"]' });
  expect(await screen.findByText("Archived Launch")).toBeTruthy();
  // An archived Plan is read-only; Reactivate is its one action.
  expect(screen.getByRole("button", { name: "Reactivate" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add tickets" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add purpose" })).toBeNull();
  // Neither the row removal nor the per-group Add survive in an archived Plan.
  expect(
    screen.queryByRole("button", { name: /^Remove T-KQ1 from/ }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: /^Add .* ticket$/ })).toBeNull();
  await waitFor(() =>
    expect(
      within(
        screen.getByRole("navigation", { name: "Plan scopes" }),
      ).queryByRole("button", { name: "Launch" }),
    ).toBeNull(),
  );
  expect(tickets.map((item) => item.status)).toEqual(["Todo", "Done", "Todo"]);

  fireEvent.click(screen.getByRole("button", { name: "Plans" }));
  fireEvent.click(await screen.findByRole("radio", { name: "Archived" }));
  await screen.findByRole("heading", { name: "Plans" });
  expect(
    screen
      .getByRole("radio", { name: "Archived" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Reactivate Launch" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("navigation", { name: "Plan scopes" })).getByRole(
        "button",
        { name: "Launch" },
      ),
    ).toBeTruthy(),
  );
});

test("Undo after archiving makes the Plan active again", async () => {
  await openLaunch();
  await chooseAction("Archive Plan");
  await screen.findByText("Archived Launch");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(plans[0]?.archived).toBe(false));
  await waitFor(() =>
    expect(
      screen.queryByText("Archived", { selector: '[data-slot="badge"]' }),
    ).toBeNull(),
  );
});

test("adds an existing ticket from search, with Undo", async () => {
  await openLaunch();
  fireEvent.click(screen.getByRole("button", { name: "Add tickets" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Add tickets to Launch",
  });
  fireEvent.change(
    within(dialog).getByLabelText("Search tickets by title or reference"),
    { target: { value: "title" } },
  );
  // Members of this Plan are not offered; one pick, then the primary adds it.
  const row = await within(dialog).findByRole("option", { name: /T-KQ3/ });
  expect(within(dialog).queryByRole("option", { name: /T-KQ1/ })).toBeNull();
  fireEvent.click(row);
  expect(within(dialog).getByText("1 selected.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Add tickets" }));
  await waitFor(() =>
    expect(calls).toContainEqual([
      "bulk_change",
      expect.objectContaining({
        references: ["T-KQ3"],
        change: { plan_id: "e1" },
      }),
    ]),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByText("Added T-KQ3 to Launch")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  // Undo puts it back where it was: in no Plan.
  await waitFor(() =>
    expect(calls).toContainEqual([
      "bulk_change",
      expect.objectContaining({
        references: ["T-KQ3"],
        change: { plan_id: null },
      }),
    ]),
  );
});

test("edits the purpose in place in the context line", async () => {
  await openLaunch();
  const line = context();
  fireEvent.click(within(line).getByRole("button", { name: "Add purpose" }));
  const field = within(line).getByRole("textbox", { name: "Purpose" });
  fireEvent.change(field, { target: { value: "Ship safely" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() =>
    expect(
      within(context()).getByRole("button", {
        name: /^Edit purpose: ?Ship safely$/,
      }),
    ).toBeTruthy(),
  );
  expect(calls).toContainEqual([
    "set_plan_purpose",
    { id: "e1", purpose: "Ship safely" },
  ]);
});

test("an open purpose draft does not carry over to another Plan", async () => {
  plans.push({ id: "e2", name: "Beta", archived: false, purpose: "" });
  await openLaunch();
  fireEvent.click(
    within(context()).getByRole("button", { name: "Add purpose" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Purpose" }), {
    target: { value: "Launch draft" },
  });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Purpose" }), {
    key: "Escape",
  });
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Plan scopes" })).getByRole(
      "button",
      { name: "Beta" },
    ),
  );
  await screen.findByRole("heading", { name: "Beta" });
  expect(screen.queryByRole("textbox", { name: "Purpose" })).toBeNull();
  expect(calls.some(([command]) => command === "set_plan_purpose")).toBe(false);
});

test("one header across both panes holds the view switch and More opens the list controls", async () => {
  await openLaunch();
  const toggle = screen.getByRole("radiogroup", { name: "Plan view" });
  expect(within(toggle).getByText("Flow")).toBeTruthy();
  // The header spans both panes: the toggle is not inside the list section,
  // and the list has no second header of its own (list H-06, plans PL-08).
  const list = screen.getByRole("region", { name: "Launch" });
  expect(list.contains(toggle)).toBe(false);
  const header = toggle.closest('[data-slot="pane-header"]')!;
  expect(
    within(header as HTMLElement).queryByRole("button", { name: "Filters" }),
  ).toBeNull();
  await chooseAction("Filter and display");
  expect(await screen.findByRole("button", { name: "Filters" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Display" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Plan list options" }), {
    key: "Escape",
  });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Plan actions" }),
    ),
  );
  expect(list.querySelector('[data-slot="pane-header"]')).toBeNull();
});

test("renaming focuses the title, shows its hint in the context line, and F2 starts it", async () => {
  await openLaunch();
  await chooseAction("Rename");
  const field = screen.getByRole("textbox", { name: "Plan name" });
  await waitFor(() => expect(document.activeElement).toBe(field));
  expect(within(context()).getByText("Enter saves · Esc cancels")).toBeTruthy();
  fireEvent.keyDown(field, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Plan name" })).toBeNull();
  // F2 in the ticket list is about the ticket, not the Plan.
  const list = screen.getByRole("region", { name: "Launch" });
  fireEvent.keyDown(within(list).getByText("Title of T-KQ1"), { key: "F2" });
  expect(screen.queryByRole("textbox", { name: "Plan name" })).toBeNull();
  fireEvent.keyDown(document.body, { key: "F2" });
  expect(
    await screen.findByRole("textbox", { name: "Plan name" }),
  ).toBeTruthy();
});

test("an empty Plan detail teaches the keys and hides its toolbar band", async () => {
  await openLaunch();
  const hint = screen.getByText("Enter").closest("p")!;
  expect(hint.textContent).toBe("↑↓ move Enter open");
  const detail = screen.getByRole("region", { name: "Ticket details" });
  expect(detail.hasAttribute("data-empty")).toBe(true);
});
