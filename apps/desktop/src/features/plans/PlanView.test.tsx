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
  await screen.findByLabelText("Tickets by status");
  return heading;
}
test("shows status counts and members for the Plan, and updates both when a member is removed", async () => {
  tickets.push({
    id: "4",
    reference: "T-KQ4",
    status: "Duplicate",
    plan: "e1",
  });
  await openLaunch();
  const group = await screen.findByLabelText("Tickets by status");
  await waitFor(() => expect(group.textContent).toContain("Done1"));
  expect(group.textContent).toContain("Todo1");
  expect(group.textContent).toContain("Duplicate1");
  expect(screen.getByText("1 of 2 done")).toBeTruthy();
  const progress = screen.getByRole("progressbar", { name: "Plan progress" });
  expect(progress.getAttribute("aria-valuenow")).toBe("1");
  expect(progress.getAttribute("aria-valuemax")).toBe("2");
  expect(screen.getByText("Active Plan")).toBeTruthy();

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
  expect(screen.getByLabelText("Tickets by status").textContent).toContain(
    "Todo0",
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

test("an empty name shows an inline error and changes nothing", async () => {
  await openLaunch();
  await chooseAction("Rename");
  const field = screen.getByRole("textbox", { name: "Plan name" });
  fireEvent.change(field, { target: { value: "   " } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Enter a name",
  );
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

test("a failed archive keeps the dialog open with its cause", async () => {
  // Plans PL-12: the dialog used to close even when archiving failed.
  const answer = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command: string, args: never) => {
    if (command === "change_plan") throw new Error("The workspace is locked");
    return answer(command, args);
  });
  await openLaunch();
  await chooseAction("Archive Plan…");
  fireEvent.click(screen.getByRole("button", { name: "Archive Plan" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Archive Launch?",
  });
  const failure = await within(dialog).findByRole("alert");
  expect(failure.textContent).toContain("Couldn't archive Launch.");
  expect(failure.textContent).toContain("The workspace is locked.");
  // Archive Plan is the retry; nothing changed.
  expect(
    within(dialog).getByRole("button", { name: "Archive Plan" }),
  ).toBeTruthy();
  expect(plans[0]?.archived).toBe(false);
});

test("archiving moves the Plan to Archived, where it can be reactivated", async () => {
  await openLaunch();
  await chooseAction("Archive Plan…");
  expect(screen.getByText(/Archiving hides this Plan/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Archive Plan" }));
  await screen.findByText("Archived Plan", { selector: ".plan-state" });
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

  fireEvent.click(screen.getByRole("button", { name: /^Archived/ }));
  await screen.findByRole("heading", { name: "Archived Plans" });
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

test("adds an existing ticket from search", async () => {
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
      "set_plan",
      { reference: "T-KQ3", plan: "e1" },
    ]),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("edits a Plan purpose", async () => {
  await openLaunch();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Add a purpose: the outcome this Plan pursues",
    }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Purpose" }), {
    target: { value: "Ship safely" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save purpose" }));
  await waitFor(() => expect(screen.getByText("Ship safely")).toBeTruthy());
});

test("an open purpose draft does not carry over to another Plan", async () => {
  plans.push({ id: "e2", name: "Beta", archived: false, purpose: "" });
  await openLaunch();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Add a purpose: the outcome this Plan pursues",
    }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Purpose" }), {
    target: { value: "Launch draft" },
  });
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Plan scopes" })).getByRole(
      "button",
      { name: "Beta" },
    ),
  );
  await screen.findByRole("heading", { name: "Beta" });
  expect(screen.queryByRole("textbox", { name: "Purpose" })).toBeNull();
});

test("the title row carries the labeled view toggle, and a summary line sits above the list", async () => {
  await openLaunch();
  const toggle = screen.getByRole("radiogroup", { name: "Plan view" });
  expect(within(toggle).getByText("Dependencies")).toBeTruthy();
  // The header spans both panes: the toggle is not inside the list section.
  const list = screen.getByRole("region", { name: "Launch" });
  expect(list.contains(toggle)).toBe(false);
  // The summary sits in the list header, left of the filters.
  const summary = await screen.findByText("2 tickets · no project");
  expect(list.contains(summary)).toBe(true);

  expect(screen.getByRole("button", { name: "Filters" }).textContent).toContain(
    "Filter",
  );
});

test("renaming focuses the title, shows its hint, and F2 starts it", async () => {
  await openLaunch();
  await chooseAction("Rename");
  const field = screen.getByRole("textbox", { name: "Plan name" });
  await waitFor(() => expect(document.activeElement).toBe(field));
  expect(screen.getByText("saves", { exact: false })).toBeTruthy();
  // The hint sits in the title row and the state stays visible.
  const row = field.parentElement!;
  expect(row.contains(screen.getByText("saves", { exact: false }))).toBe(true);
  expect(within(row).getByText("Active Plan")).toBeTruthy();
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
