// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";
import { StatusLineRegion } from "@/components/ui/status-line";
import { PlanList } from "./PlanList";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

const counts = {
  total: 6,
  todo: 2,
  in_progress: 0,
  in_review: 0,
  done: 3,
  canceled: 1,
  duplicate: 0,
};

function plansPage(
  archived: boolean,
  plans: {
    id: string;
    name: string;
    archived: boolean;
    purpose: string;
  }[] = [],
  props: Partial<Parameters<typeof PlanList>[0]> = {},
  revision = 0,
) {
  return (
    <WorkspaceChangeProvider value={revision}>
      <StatusLineRegion>
        <PlanList
          plans={plans}
          archived={archived}
          onOpen={() => {}}
          onArchivedChange={() => {}}
          refresh={async () => {}}
          {...props}
        />
      </StatusLineRegion>
    </WorkspaceChangeProvider>
  );
}

function list(...args: Parameters<typeof plansPage>) {
  return render(plansPage(...args));
}

test("an empty Plans list explains itself and leaves New Plan to the header", () => {
  list(false);
  expect(screen.getByText("No Plans yet")).toBeTruthy();
  expect(
    screen.getByText("A Plan groups the tickets that ship together."),
  ).toBeTruthy();
  // P9 action rule: the header already holds the one way to fill the page.
  expect(screen.getAllByRole("button", { name: /New Plan/ })).toHaveLength(1);
});

test("an empty archive says what lands there", () => {
  list(true);
  expect(screen.getByText("No archived Plans")).toBeTruthy();
  expect(screen.getByText("Plans you archive wait here.")).toBeTruthy();
});

test("Active and Archived are one segmented choice on the Plans page", () => {
  const change = vi.fn();
  list(false, [], { onArchivedChange: change });
  fireEvent.click(screen.getByRole("radio", { name: "Archived" }));
  expect(change).toHaveBeenCalledWith(true);
});

const launch = {
  id: "p",
  name: "Launch",
  archived: false,
  purpose: "Ship on time",
};

function member(
  reference: string,
  status: string,
  availability: string | null = null,
) {
  return {
    id: reference,
    reference,
    title: `Ticket ${reference}`,
    status,
    availability,
    trashed: false,
    project_id: null,
    plan_id: launch.id,
    prerequisites: [],
    updated_at: "2026-02-01T00:00:00Z",
  };
}

test("a Plan row shows progress and nonzero status words instead of its purpose", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "show_plan")
      return {
        plan: launch,
        counts: { ...counts, todo: 1, in_review: 1 },
        members: [],
      };
    if (command === "find_tickets_with_updates")
      return {
        items: [
          member("T-1", "In review"),
          member("T-2", "Todo", "Ready"),
          member("T-3", "Done"),
          member("T-4", "Done"),
          member("T-5", "Done"),
          member("T-6", "Canceled"),
        ],
        omitted: false,
      };
    return null;
  });
  const open = vi.fn();
  list(false, [launch], { onOpen: open });
  const rows = await screen.findByRole("list", { name: "Active Plans" });
  expect(await within(rows).findByText("3 of 5")).toBeTruthy();
  expect(within(rows).getByText("1 in review · 1 ready")).toBeTruthy();
  expect(within(rows).queryByText(launch.purpose)).toBeNull();
  const row = within(rows).getByRole("button", {
    name: "Open Plan Launch",
    description: /Needs attention.*1 in review · 1 ready/i,
  });
  fireEvent.click(row);
  expect(open).toHaveBeenCalledWith(launch.id);
});

test("New Plan names the Plan in a dialog, then opens it", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "create_plan"
      ? { id: "new", name: "Docs", archived: false, purpose: "" }
      : null,
  );
  const open = vi.fn();
  list(false, [], { onOpen: open });
  fireEvent.click(screen.getByRole("button", { name: /New Plan/ }));
  const dialog = await screen.findByRole("dialog", { name: "New Plan" });
  const create = within(dialog).getByRole("button", { name: "Create Plan" });
  expect((create as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Docs" },
  });
  fireEvent.click(create);
  await waitFor(() => expect(open).toHaveBeenCalledWith("new"));
  expect(bridge.invoke).toHaveBeenCalledWith("create_plan", { name: "Docs" });
});

test("reactivating an archived Plan says so and offers Undo", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "show_plan")
      return {
        plan: { ...launch, archived: true },
        members: [],
        counts: { ...counts, done: 0, todo: 2, canceled: 0 },
      };
    if (command === "find_tickets_with_updates")
      return {
        items: [member("T-1", "Todo", "Ready"), member("T-2", "Todo", "Ready")],
        omitted: false,
      };
    return null;
  });
  list(true, [{ ...launch, archived: true }]);
  const archived = await screen.findByRole("list", { name: "Archived Plans" });
  expect(within(archived).getByText("2 left open")).toBeTruthy();
  const open = within(archived).getByRole("button", {
    name: "Open Plan Launch",
  });
  open.focus();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reactivate Launch" }));
  });
  expect(screen.getByRole("status").textContent).toContain(
    "Reactivated Launch",
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  });
  expect(bridge.invoke).toHaveBeenCalledWith("change_plan", {
    id: "p",
    name: null,
    archived: false,
  });
  expect(bridge.invoke).toHaveBeenCalledWith("change_plan", {
    id: "p",
    name: null,
    archived: true,
  });
});

const emptyCounts = {
  todo: 0,
  in_review: 0,
  in_progress: 0,
  done: 0,
  canceled: 0,
  duplicate: 0,
};
const outside = {
  reference: "T-outside",
  title: "Outside work",
  status: "Todo",
  trashed: false,
  unresolved: true,
};

for (const example of [
  {
    rule: "external",
    state: "Ready to wrap up",
    attention: true,
    prerequisites: [outside],
  },
  {
    rule: "internal",
    state: "1 blocked",
    attention: false,
    prerequisites: [{ ...outside, reference: "T-closed", status: "Canceled" }],
  },
  {
    rule: "trashed",
    state: "1 blocked",
    attention: false,
    prerequisites: [{ ...outside, trashed: true }],
  },
  {
    rule: "omitted",
    state: "1 to do",
    attention: false,
    prerequisites: [outside],
  },
]) {
  test(`the Plan row handles ${example.rule} blockers when deciding whether to show wrap-up`, async () => {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === "show_plan")
        return {
          plan: launch,
          counts: { ...emptyCounts, todo: 1, canceled: 1 },
          members: [],
        };
      if (command === "find_tickets_with_updates")
        return {
          items: [
            {
              ...member("T-blocked", "Todo", "Blocked"),
              prerequisites: example.prerequisites,
            },
            member("T-closed", "Canceled"),
          ],
          omitted: example.rule === "omitted",
        };
      return null;
    });
    list(false, [launch]);
    const rows = await screen.findByRole("list", { name: "Active Plans" });
    expect(within(rows).getByText(example.state)).toBeTruthy();
    expect(
      within(rows).getByRole("button", {
        name: "Open Plan Launch",
        description: example.attention
          ? `Needs attention. ${example.state}. 0 of 1 done`
          : `${example.state}. 0 of 1 done`,
      }),
    ).toBeTruthy();
  });
}

test.each([false, true])(
  "a completed Plan has the archive copy appropriate to its current view (archived=%s)",
  async (archived) => {
    const plan = { ...launch, archived };
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === "show_plan")
        return { plan, counts: { ...emptyCounts, done: 1 }, members: [] };
      if (command === "find_tickets_with_updates")
        return { items: [member("T-1", "Done")], omitted: false };
      return null;
    });
    list(archived, [plan]);
    const rows = await screen.findByRole("list", {
      name: archived ? "Archived Plans" : "Active Plans",
    });
    expect(
      within(rows).getByText(
        archived ? "All done" : "All done · ready to archive",
      ),
    ).toBeTruthy();
    expect(
      within(rows).getByRole("button", {
        name: "Open Plan Launch",
        description: archived
          ? "All done. 1 of 1 done"
          : "Needs attention. All done · ready to archive. 1 of 1 done",
      }),
    ).toBeTruthy();
  },
);

test("Plans first sort reviews then the newest change, and keep their positions until reopened", async () => {
  const plans = [
    launch,
    { ...launch, id: "recent", name: "Recent" },
    { ...launch, id: "review", name: "Review" },
  ];
  let updated = false;
  function planMember(id: string) {
    const review = updated ? id === launch.id : id === "review";
    return {
      ...member(
        `T-${id}`,
        review ? "In review" : "Todo",
        review ? null : "Ready",
      ),
      updated_at:
        id === "recent" ? "2026-02-03T00:00:00Z" : "2026-02-01T00:00:00Z",
    };
  }
  bridge.invoke.mockImplementation(
    async (
      command: string,
      args: { id?: string; filter?: { plan: string } },
    ) => {
      if (command === "show_plan") {
        const id = args.id ?? "";
        const review = planMember(id).status === "In review";
        return {
          plan: plans.find((plan) => plan.id === id),
          counts: {
            ...emptyCounts,
            in_review: review ? 1 : 0,
            todo: review ? 0 : 1,
          },
          members: [],
        };
      }
      if (command === "find_tickets_with_updates")
        return { items: [planMember(args.filter?.plan ?? "")], omitted: false };
      return null;
    },
  );
  const page = list(false, plans);
  const rows = await screen.findByRole("list", { name: "Active Plans" });
  function order(group: HTMLElement) {
    return within(group)
      .getAllByRole("listitem")
      .map((item) => within(item).getByRole("button"));
  }
  const firstOrder = ["Review", "Recent", "Launch"].map((name) =>
    within(rows).getByRole("button", { name: `Open Plan ${name}` }),
  );
  expect(order(rows)).toEqual(firstOrder);
  updated = true;
  page.rerender(plansPage(false, plans, {}, 1));
  await within(rows).findByRole("button", {
    name: "Open Plan Launch",
    description: /1 in review/,
  });
  expect(order(rows)).toEqual(firstOrder);
  page.unmount();
  list(false, plans);
  const reopened = await screen.findByRole("list", { name: "Active Plans" });
  expect(order(reopened)).toEqual(
    ["Launch", "Recent", "Review"].map((name) =>
      within(reopened).getByRole("button", { name: `Open Plan ${name}` }),
    ),
  );
});

test("Plan row loading shows progress once ready and a failed refresh keeps the last read", async () => {
  let fail = false;
  let resolveMembers: (value: unknown) => void = () => {};
  const members = new Promise((resolve) => {
    resolveMembers = resolve;
  });
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "show_plan")
      return {
        plan: launch,
        counts: { ...emptyCounts, in_review: 1 },
        members: [],
      };
    if (command === "find_tickets_with_updates") {
      if (fail)
        throw { code: "failed", message: "Plan member read unavailable" };
      return members;
    }
    return null;
  });
  const plans = [launch];
  const page = list(false, plans);
  expect(screen.getByRole("status", { name: "Loading Plans" })).toBeTruthy();
  resolveMembers({ items: [member("T-1", "In review")], omitted: false });
  await screen.findByText("1 in review");
  fail = true;
  page.rerender(plansPage(false, plans, {}, 1));
  await screen.findByText("Couldn't load Plan details.");
  expect(screen.getByText("1 in review")).toBeTruthy();
  expect(screen.getByText("0 of 1")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.queryByText("Couldn't load Plan details.")).toBeNull(),
  );
});
