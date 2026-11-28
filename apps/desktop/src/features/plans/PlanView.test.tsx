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
import { StrictMode } from "react";
import { loadPreferences, setPreference } from "@/lib/preferences";
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
      if (args && typeof args === "object" && "projection" in args)
        return { items: tickets, omitted: false };
      return tickets.map((ticket) => ({ ticket, latest_update: null }));
    }
    return bridge.invoke(command, args);
  },
}));

type Fake = { id: string; reference: string; status: string; plan: string };
let plans: { id: string; name: string; archived: boolean; purpose: string }[] =
  [];
let tickets: Fake[] = [];
let documents: { id: string; heading: string; trashed: boolean }[] = [];
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
  localStorage.clear();
  plans = [{ id: "e1", name: "Launch", archived: false, purpose: "" }];
  tickets = [
    { id: "1", reference: "T-KQ1", status: "Todo", plan: "e1" },
    { id: "2", reference: "T-KQ2", status: "Done", plan: "e1" },
    { id: "3", reference: "T-KQ3", status: "Todo", plan: "" },
  ];
  calls.length = 0;
  documents = [];
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
          plan: {
            ...plans.find((item) => item.id === input?.id),
            spec_document_id: documents[0]?.id ?? null,
          },
          documents,
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
      case "show_ticket": {
        const member = tickets.find(
          (item) => item.reference === input?.reference,
        );
        return member ? ticket(member) : null;
      }
      case "show_document":
        return {
          id: "spec",
          title: "Release specification",
          body: "Release checklist",
          heading: "Release specification",
          updated_at: "2026-11-28T01:00:00Z",
          created_at: "2026-11-28T01:00:00Z",
          trashed: false,
        };
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
  const overview = await screen.findByRole("region", { name: "Launch" });
  await within(overview).findByText(/^[0-9]+ of [0-9]+ done$/);
  return within(overview).getByRole("heading", { name: "Launch" });
}
const context = () => screen.getByRole("region", { name: "Launch" });

test("the header counts the Plan's tickets and its progress, and Remove from Plan offers Undo", async () => {
  tickets.push({
    id: "4",
    reference: "T-KQ4",
    status: "Duplicate",
    plan: "e1",
  });
  await openLaunch();
  expect(within(context()).getByText("1 of 2 done")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  // An active Plan shows no state chip (plans PL-05).
  expect(screen.queryByText("Active Plan")).toBeNull();

  fireEvent.click(
    screen.getByRole("button", { name: "Remove T-KQ1 from Launch" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /^T-KQ1/ })).toBeNull(),
  );
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
  const error = await screen.findByRole("alert");
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
  expect(screen.getByText("Enter saves · Esc cancels")).toBeTruthy();
  fireEvent.keyDown(field, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Plan name" })).toBeNull();
  // F2 in the ticket list is about the ticket, not the Plan.
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
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
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  const hint = screen.getByText("Enter").closest("p")!;
  expect(hint.textContent).toBe("↑↓ move Enter open");
  const detail = screen.getByRole("region", { name: "Ticket details" });
  expect(detail.hasAttribute("data-empty")).toBe(true);
});

test("every visit to a Plan starts on Overview and its ticket views have no summary", async () => {
  plans[0]!.purpose = "Prepare the release";
  render(<App />);
  const launch = () =>
    within(screen.getByRole("navigation", { name: "Plan scopes" })).getByRole(
      "button",
      { name: "Launch" },
    );
  fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
  const switchView = (name: string) =>
    fireEvent.click(screen.getByRole("radio", { name }));
  expect(
    screen
      .getByRole("radio", { name: "Overview" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  const overview = await screen.findByRole("region", { name: "Launch" });
  expect(within(overview).getByText("Prepare the release")).toBeTruthy();
  expect(await within(overview).findByText("1 of 2 done")).toBeTruthy();
  for (const name of ["List", "Board", "Flow"]) {
    switchView(name);
    expect(screen.queryByText("Prepare the release")).toBeNull();
    expect(screen.queryByText("1 of 2 done")).toBeNull();
  }
  fireEvent.click(launch());
  expect(
    screen
      .getByRole("radio", { name: "Overview" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.getByText("Prepare the release")).toBeTruthy();
});

test("keeps the Overview head while the Plan loads and retries in the pane", async () => {
  const respond = bridge.invoke.getMockImplementation()!;
  let finish: (() => void) | undefined;
  let first = true;
  bridge.invoke.mockImplementation(async (command: string, args: never) => {
    const input = args as Record<string, unknown> | undefined;
    if (
      command === "show_plan" &&
      !input?.limit &&
      input?.includeMembers !== false &&
      first
    ) {
      first = false;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw new Error("The workspace is busy");
    }
    return respond(command, args);
  });

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
  const overview = screen.getByRole("region", { name: "Launch" });
  expect(
    within(overview).getByRole("heading", { name: "Launch" }),
  ).toBeTruthy();
  expect(
    within(overview).getByRole("status", { name: "Loading Plan" }),
  ).toBeTruthy();
  await waitFor(() => expect(finish).toBeDefined());
  finish?.();
  fireEvent.click(
    await within(overview).findByRole("button", { name: "Retry" }),
  );
  expect(await within(overview).findByText("1 of 2 done")).toBeTruthy();
});

test("a long purpose expands and the spec opens with a route back to its Plan", async () => {
  plans[0]!.purpose = "Make the launch safe and easy to verify. ".repeat(4);
  documents = [
    { id: "spec", heading: "Release specification", trashed: false },
  ];
  await openLaunch();
  const more = within(context()).getByRole("button", { name: "Show more" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(more);
  const less = within(context()).getByRole("button", { name: "Show less" });
  expect(less.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(
    within(context()).getByRole("button", {
      name: "Spec: Release specification",
    }),
  );
  const back = await screen.findByRole("button", { name: "Back to Launch" });
  fireEvent.click(back);
  expect(await screen.findByRole("region", { name: "Launch" })).toBeTruthy();
});

test("a first visit records a last look only after leaving the Plan", async () => {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
  await within(context()).findByText("1 of 2 done");
  expect(loadPreferences().planLastLook.e1).toBeUndefined();
  expect(
    screen.queryByRole("region", { name: "Since you last looked" }),
  ).toBeNull();
  expect(calls.some(([name]) => name === "plan_activity")).toBe(false);

  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  fireEvent.click(screen.getByRole("radio", { name: "Overview" }));
  await within(context()).findByText("1 of 2 done");
  expect(loadPreferences().planLastLook.e1).toBeUndefined();
  const beforeLeaving = Date.now();
  fireEvent.click(screen.getByRole("button", { name: "Plans" }));
  await screen.findByRole("heading", { name: "Plans" });
  expect(
    Date.parse(loadPreferences().planLastLook.e1 ?? ""),
  ).toBeGreaterThanOrEqual(beforeLeaving);
});

test("the Overview shows new changes, opens their ticket, and clears on return", async () => {
  const lastLook = "2026-02-01T00:00:00.000Z";
  setPreference("planLastLook", { e1: lastLook });
  const timestamp = "2026-02-02T00:00:00.000Z";
  tickets.push(
    ...[4, 5, 6, 7, 8].map((id) => ({
      id: String(id),
      reference: `T-KQ${id}`,
      status: "Todo",
      plan: "e1",
    })),
  );
  const base = { timestamp, editing_agent: "agent" };
  const changes = [
    {
      ...base,
      reference: "T-KQ1",
      title: "Release work",
      kind: "update",
      brief: "**Verified the release.** Another sentence.",
    },
    {
      ...base,
      reference: "T-KQ2",
      title: "Release build",
      kind: "status",
      from: "In review",
      to: "Done",
    },
    ...[4, 5, 6, 7].map((id) => ({
      ...base,
      reference: `T-KQ${id}`,
      title: `Member ${id}`,
      kind: "joined",
    })),
  ];
  const feed = [...changes.slice(0, 5), { ...changes[5], timestamp: lastLook }];
  const answer = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command: string, args: never) =>
    command === "plan_activity"
      ? feed.slice(0, (args as { limit: number }).limit)
      : answer(command, args),
  );

  await openLaunch();
  const updates = await screen.findByRole("region", {
    name: "Since you last looked",
  });
  expect(within(updates).getAllByRole("button")).toHaveLength(5);
  expect(
    within(updates).getByRole("button", { name: /Release build.*Done/ }),
  ).toBeTruthy();
  expect(
    within(updates).getByRole("button", { name: /Joined · Member 4/ }),
  ).toBeTruthy();
  expect(within(updates).queryByText("Joined · Member 7")).toBeNull();
  expect(within(updates).queryByText("Another sentence.")).toBeNull();

  const update = within(updates).getByRole("button", {
    name: /Verified the release\./,
  });
  fireEvent.click(update);
  const close = await screen.findByRole("button", {
    name: "Close ticket details",
  });
  expect(bridge.invoke).toHaveBeenCalledWith("show_ticket", {
    reference: "T-KQ1",
  });
  expect(loadPreferences().planLastLook.e1).toBe(lastLook);
  expect(
    screen.getByRole("region", { name: "Since you last looked" }),
  ).toBeTruthy();

  fireEvent.click(close);
  await waitFor(() => expect(document.activeElement).toBe(update));
  fireEvent.click(screen.getByRole("button", { name: "Plans" }));
  await screen.findByRole("heading", { name: "Plans" });
  fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
  await within(context()).findByText("1 of 7 done");
  expect(
    screen.queryByRole("region", { name: "Since you last looked" }),
  ).toBeNull();
  expect(bridge.invoke).toHaveBeenCalledWith("plan_activity", {
    id: "e1",
    limit: 5,
  });
});

test("the Overview excludes changes at the last look and hides the feed after archive", async () => {
  const lastLook = "2026-02-01T00:00:00.000Z";
  setPreference("planLastLook", { e1: lastLook });
  const answer = bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async (command: string, args: never) =>
    command === "plan_activity"
      ? [
          {
            reference: "T-KQ1",
            title: "New member",
            timestamp: "2026-02-02T00:00:00.000Z",
            editing_agent: null,
            kind: "joined",
          },
          {
            reference: "T-KQ2",
            title: "Previously seen",
            timestamp: lastLook,
            editing_agent: null,
            kind: "joined",
          },
        ]
      : answer(command, args),
  );
  await openLaunch();
  const updates = await screen.findByRole("region", {
    name: "Since you last looked",
  });
  expect(
    within(updates).getByRole("button", { name: /Joined · New member/ }),
  ).toBeTruthy();
  expect(
    within(updates).queryByRole("button", { name: /Joined · Previously seen/ }),
  ).toBeNull();
  await chooseAction("Archive Plan");
  await screen.findByRole("button", { name: "Reactivate" });
  expect(
    screen.queryByRole("region", { name: "Since you last looked" }),
  ).toBeNull();
});
