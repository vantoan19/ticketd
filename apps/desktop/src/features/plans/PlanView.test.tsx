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
    { id: "1", reference: "T-1", status: "Todo", plan: "e1" },
    { id: "2", reference: "T-2", status: "Done", plan: "e1" },
    { id: "3", reference: "T-3", status: "Todo", plan: "" },
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

async function openLaunch() {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
  return screen.findByRole("heading", { name: "Launch" });
}
test("shows status counts and members for the Plan, and updates both when a member is removed", async () => {
  tickets.push({
    id: "4",
    reference: "T-4",
    status: "Duplicate",
    plan: "e1",
  });
  await openLaunch();
  const group = await screen.findByLabelText("Tickets by status");
  await waitFor(() => expect(group.textContent).toContain("Done1"));
  expect(group.textContent).toContain("Todo1");
  expect(group.textContent).toContain("Duplicate1");
  expect(screen.getByText(/^Plan · 3 tickets/)).toBeTruthy();
  expect(screen.getByText("Active")).toBeTruthy();

  fireEvent.click(
    screen.getByRole("button", { name: "Remove T-1 from Launch" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /^T-1/ })).toBeNull(),
  );
  await waitFor(() =>
    expect(screen.getByText(/^Plan · 2 tickets/)).toBeTruthy(),
  );
  expect(calls).toContainEqual(["set_plan", { reference: "T-1", plan: null }]);
  expect(screen.getByLabelText("Tickets by status").textContent).toContain(
    "Todo0",
  );
});

test("progress leaves out Canceled and Duplicate tickets and says when none are in a project", async () => {
  tickets = [
    { id: "1", reference: "T-1", status: "Done", plan: "e1" },
    { id: "2", reference: "T-2", status: "Canceled", plan: "e1" },
    { id: "3", reference: "T-3", status: "Duplicate", plan: "e1" },
  ];
  await openLaunch();
  expect(
    await screen.findByText(
      "Plan · 3 tickets, not in a project · 1 of 1 done · 1 canceled · 1 duplicate",
    ),
  ).toBeTruthy();
});

test("an empty name shows an inline error and changes nothing", async () => {
  await openLaunch();
  fireEvent.click(screen.getByRole("button", { name: "Rename Plan" }));
  fireEvent.change(screen.getByLabelText("Plan name"), {
    target: { value: "   " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Enter a name",
  );
  expect(calls.some(([command]) => command === "change_plan")).toBe(false);
  expect(screen.getByRole("heading", { name: "Launch" })).toBeTruthy();
});

test("renames the Plan", async () => {
  await openLaunch();
  fireEvent.click(screen.getByRole("button", { name: "Rename Plan" }));
  fireEvent.change(screen.getByLabelText("Plan name"), {
    target: { value: "Release" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await screen.findByRole("heading", { name: "Release" });
  expect(calls).toContainEqual([
    "change_plan",
    { id: "e1", name: "Release", archived: null },
  ]);
});

test("archiving moves the Plan to Archived, where it can be reactivated", async () => {
  await openLaunch();
  fireEvent.click(screen.getByRole("button", { name: "Archive Plan" }));
  expect(screen.getByText(/Archiving hides this Plan/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  await screen.findByText("Archived", { selector: ".plan-state" });
  // An archived Plan is read-only; Reactivate is its one action.
  expect(screen.getByRole("button", { name: "Reactivate" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add tickets" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add purpose" })).toBeNull();
  // Neither the row removal nor the per-group Add survive in an archived Plan.
  expect(screen.queryByRole("button", { name: /^Remove T-1 from/ })).toBeNull();
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
  fireEvent.click(
    await screen.findByRole("button", { name: "Add T-3 to Launch" }),
  );
  await waitFor(() =>
    expect(calls).toContainEqual([
      "set_plan",
      { reference: "T-3", plan: "e1" },
    ]),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Add T-3 to Launch" }),
    ).toBeNull(),
  );
});

test("edits a Plan purpose", async () => {
  await openLaunch();
  fireEvent.click(screen.getByRole("button", { name: "Add purpose" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Purpose" }), {
    target: { value: "Ship safely" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save purpose" }));
  await waitFor(() => expect(screen.getByText("Ship safely")).toBeTruthy());
});

test("an open purpose draft does not carry over to another Plan", async () => {
  plans.push({ id: "e2", name: "Beta", archived: false, purpose: "" });
  await openLaunch();
  fireEvent.click(screen.getByRole("button", { name: "Add purpose" }));
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
