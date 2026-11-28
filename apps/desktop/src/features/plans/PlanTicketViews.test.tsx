// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "@/app/App";
import type { Ticket } from "@/lib/api/client";
import { bridgeDefault } from "@/test/bridge-defaults";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const plans = [
  { id: "p1", name: "Launch", archived: false, purpose: "" },
  { id: "p2", name: "Beta", archived: false, purpose: "" },
];
const projects = [
  { id: "web", name: "Website", path: "", paths: [] },
  { id: "api", name: "API", path: "", paths: [] },
];
const ticket = (
  reference: string,
  status: string,
  plan_id: string,
  details?: Partial<Ticket>,
): Ticket => ({
  id: reference,
  reference,
  title: `Title of ${reference}`,
  status,
  plan_id,
  body: "",
  trashed: false,
  tags: [],
  project_id: null,
  availability: null,
  prerequisites: [],
  parent: null,
  children: [],
  ...details,
});
let members: Ticket[];
const counts = (items: typeof members) => {
  const count = (status: string) =>
    items.filter((item) => item.status === status).length;
  return {
    total: items.length,
    todo: count("Todo"),
    in_progress: count("In progress"),
    in_review: count("In review"),
    done: count("Done"),
    canceled: count("Canceled"),
    duplicate: count("Duplicate"),
  };
};

beforeEach(() => {
  localStorage.clear();
  members = [
    ticket("T-KQ1", "Todo", "p1"),
    ticket("T-KQ2", "Done", "p1"),
    ticket("T-KQ3", "Done", "p2"),
  ];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  bridge.invoke.mockImplementation(
    async (
      command: string,
      args?: { id?: string; filter?: { plan?: string }; projection?: string },
    ) => {
      const plan = args?.filter?.plan;
      const tickets = members.filter((item) => !plan || item.plan_id === plan);
      switch (command) {
        case "list_plans":
          return plans;
        case "list_projects":
          return projects;
        case "show_plan": {
          const items = members.filter((item) => item.plan_id === args?.id);
          return {
            plan: plans.find((item) => item.id === args?.id),
            members: items,
            counts: counts(items),
          };
        }
        case "find_ticket_rows":
        case "find_tickets":
          return tickets;
        case "find_tickets_with_updates":
          return args?.projection
            ? { items: tickets, omitted: false }
            : tickets.map((ticket) => ({ ticket, latest_update: null }));
        case "count_tickets":
          return counts(tickets);
        default:
          return bridgeDefault(command, args);
      }
    },
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  bridge.invoke.mockReset();
});

async function openPlan(name: string, view: "List" | "Flow" = "List") {
  const sidebar = await screen.findByRole("navigation", {
    name: "Plan scopes",
  });
  fireEvent.click(await within(sidebar).findByRole("button", { name }));
  const header = await screen.findByRole("radiogroup", { name: "Plan view" });
  fireEvent.click(within(header).getByRole("radio", { name: view }));
}

test("List folds Done by default and remembers the choice for each Plan across restarts", async () => {
  const first = render(<App />);
  await openPlan("Launch");
  expect(await screen.findByText("Title of T-KQ1")).toBeTruthy();
  const done = screen.getByRole("button", { name: "Done 1 ticket" });
  expect(done.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Title of T-KQ2")).toBeNull();

  fireEvent.click(done);
  expect(await screen.findByText("Title of T-KQ2")).toBeTruthy();
  expect(done.getAttribute("aria-expanded")).toBe("true");
  first.unmount();

  render(<App />);
  await openPlan("Beta");
  const betaDone = await screen.findByRole("button", { name: /^Done 1/ });
  expect(betaDone.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Title of T-KQ3")).toBeNull();

  await openPlan("Launch");
  expect(await screen.findByText("Title of T-KQ2")).toBeTruthy();
  const launchDone = screen.getByRole("button", { name: /^Done 1/ });
  fireEvent.click(launchDone);
  expect(launchDone.getAttribute("aria-expanded")).toBe("false");
});

test.each([
  {
    relation: "parent",
    shared: {
      parent: { reference: "T-KQ4", title: "Parent A", trashed: false },
    },
    other: {
      parent: { reference: "T-KQ5", title: "Parent B", trashed: false },
    },
    expected: ["Subticket of T-KQ4", "Subticket of T-KQ5"],
  },
  {
    relation: "project",
    shared: { project_id: "web" },
    other: { project_id: "api" },
    expected: ["Website", "API"],
  },
])(
  "List hides shared $relation labels and keeps them when rows differ",
  async ({ shared, other, expected }) => {
    members = [
      ticket("T-KQ1", "Todo", "p1", shared),
      ticket("T-KQ2", "Todo", "p1", shared),
      ticket("T-KQ6", "Todo", "p2", shared),
      ticket("T-KQ7", "Todo", "p2", other),
    ];
    render(<App />);
    await openPlan("Launch");
    const launch = await screen.findByRole("region", { name: "Launch" });
    expect(await within(launch).findByText("Title of T-KQ2")).toBeTruthy();
    expect(within(launch).queryAllByText(expected[0]!)).toHaveLength(0);

    await openPlan("Beta");
    const beta = await screen.findByRole("region", { name: "Beta" });
    expect(await within(beta).findByText("Title of T-KQ7")).toBeTruthy();
    for (const label of expected)
      expect(within(beta).getByText(label)).toBeTruthy();
  },
);

test("Flow names its first two columns and shows Later only when it has work", async () => {
  const blockedBy = (reference: string): Partial<Ticket> => ({
    availability: "Blocked",
    prerequisites: [
      {
        reference,
        title: `Title of ${reference}`,
        status: "Todo",
        trashed: false,
        unresolved: true,
      },
    ],
  });
  members = [
    ticket("T-KQ1", "Todo", "p1"),
    ticket("T-KQ2", "Todo", "p1", blockedBy("T-KQ1")),
    ticket("T-KQ3", "Todo", "p2"),
    ticket("T-KQ4", "Todo", "p2", blockedBy("T-KQ3")),
    ticket("T-KQ5", "Todo", "p2", blockedBy("T-KQ4")),
  ];
  render(<App />);
  await openPlan("Launch", "Flow");
  let flow = await screen.findByRole("region", { name: "Plan Flow" });
  await within(flow).findByRole("button", { name: /T-KQ2/ });
  const headings = () =>
    within(flow)
      .getAllByRole("heading", { level: 2 })
      .map((item) => item.textContent);
  expect(headings()).toEqual(["Can start", "After one step"]);
  expect(
    within(within(flow).getByRole("region", { name: "Can start" })).getByRole(
      "button",
      { name: /T-KQ1/ },
    ),
  ).toBeTruthy();
  expect(
    within(
      within(flow).getByRole("region", { name: "After one step" }),
    ).getByRole("button", { name: /T-KQ2/ }),
  ).toBeTruthy();

  await openPlan("Beta", "Flow");
  flow = await screen.findByRole("region", { name: "Plan Flow" });
  const later = await within(flow).findByRole("region", { name: "Later" });
  expect(within(later).getByRole("button", { name: /T-KQ5/ })).toBeTruthy();
  expect(headings()).toEqual(["Can start", "After one step", "Later"]);
});
