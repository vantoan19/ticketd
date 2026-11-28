import { bridgeDefault } from "@/test/bridge-defaults";
import { revealFailureDetails } from "@/test/failure-details";
// @vitest-environment jsdom
import { addableKinds } from "@/features/tickets/linked-work";
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
import { invoke } from "@tauri-apps/api/core";
import { LinkedWork, LinkedWorkDialogs } from "@/features/tickets/LinkedWork";
import { useLinkedWork } from "@/features/tickets/useLinkedWork";
import { TestOpenTicket } from "@/features/tickets/open-ticket/testing";
import type { Ticket } from "@/lib/api/client";
import { StatusLineRegion } from "@/components/ui/status-line";
import { RailPlacement } from "./rail-placement";
import { TicketContextLine } from "./TicketContextLine";
import type { ChangeSignal } from "@/lib/workspace-reads";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The ticket picker (cmdk) needs these, which jsdom lacks.
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

const base: Ticket = {
  id: "1",
  reference: "T-KQ1",
  title: "Work",
  body: "",
  status: "Todo",
  trashed: false,
  tags: [],
  project_id: null,
  plan_id: null,
  availability: "Blocked",
  parent: null,
  children: [],
  prerequisites: [],
};
const page = { items: [], next_offset: null };
const other = (reference: string, title: string, status = "Todo") => ({
  ...base,
  id: reference,
  reference,
  title,
  status,
});
type Item = {
  reference: string;
  title: string;
  status?: string;
  trashed?: boolean;
  unresolved?: boolean;
};
const related = (item: Item) => ({
  status: "Todo",
  trashed: false,
  unresolved: true,
  ...item,
  title: { text: item.title },
});
const pageOf = (items: Item[] = [], next_offset: number | null = null) => ({
  items: items.map(related),
  next_offset,
});

function bridge(
  options: {
    prerequisites?: Item[];
    blocking?: Item[];
    related?: Item[];
    parent?: Item;
    children?: Item[];
    finishedChildren?: Item[];
    readChildren?: (offset: number) => Promise<{
      children: ReturnType<typeof pageOf>;
      children_progress: { total: number; done: number };
    }>;
    discovered?: Item[];
    nextRelated?: Item[];
    duplicate_of?: Item;
    duplicates?: Item[];
    fail?: Record<string, string>;
    never?: boolean;
  } = {},
) {
  vi.mocked(invoke).mockImplementation(async (command: string, args) => {
    const failure = options.fail?.[command];
    if (failure) throw failure;
    if (command === "contextual_relationships") {
      if (options.never) return new Promise(() => {});
      const offset = (args as { offset?: number } | undefined)?.offset ?? 0;
      const totalChildren = [
        ...(options.children ?? []),
        ...(options.finishedChildren ?? []),
      ];
      const children = (await options.readChildren?.(offset)) ?? {
        children: offset
          ? pageOf(options.finishedChildren)
          : pageOf(options.children, options.finishedChildren ? 20 : null),
        children_progress: {
          total: totalChildren.length,
          done: totalChildren.filter((item) => item.status === "Done").length,
        },
      };
      return {
        relationships: {
          parent: options.parent ? related(options.parent) : null,
          ...children,
          prerequisites: pageOf(options.prerequisites),
          blocking: pageOf(options.blocking),
          related: offset
            ? pageOf(options.nextRelated)
            : pageOf(options.related, options.nextRelated ? 20 : null),
          discovered_while: pageOf(options.discovered),
          discoveries: page,
          duplicate_of: options.duplicate_of
            ? related(options.duplicate_of)
            : null,
          duplicates: pageOf(options.duplicates),
        },
      };
    }
    if (command === "search_tickets")
      return [other("T-KQ5", "Target"), other("T-KQ1", "Itself")];
    if (
      [
        "show_ticket",
        "remove_dependency",
        "add_dependency",
        "remove_duplicate",
        "change_contextual_relationship",
      ].includes(command)
    )
      return base;
    return bridgeDefault(command, args as { reference?: string });
  });
}
function Sections() {
  const work = useLinkedWork();
  return (
    <>
      <TicketContextLine
        projects={[]}
        plans={[]}
        work={work}
        select={vi.fn()}
        onOpenSubtickets={vi.fn()}
      />
      <RailPlacement value="column">
        <LinkedWork work={work} select={vi.fn()} onMention={vi.fn()} />
      </RailPlacement>
      <LinkedWorkDialogs work={work} />
    </>
  );
}
function Section({
  ticket,
  signal,
}: {
  ticket: Ticket;
  signal?: ChangeSignal;
}) {
  return (
    <TestOpenTicket ticket={ticket} {...(signal && { signal })}>
      <StatusLineRegion>
        <Sections />
      </StatusLineRegion>
    </TestOpenTicket>
  );
}
function renderSection(ticket: Ticket, signal?: ChangeSignal) {
  return render(<Section ticket={ticket} {...(signal && { signal })} />);
}
/** How many times the relationships were read from the core. */
const relationshipReads = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "contextual_relationships")
    .length;

test("Linked prioritizes open groups and keeps finished work folded", async () => {
  bridge({
    prerequisites: [{ reference: "T-KQ2", title: "Open blocker" }],
    children: [
      { reference: "T-KQ3", title: "Completed child", status: "Done" },
    ],
    blocking: [{ reference: "T-KQ4", title: "Open dependent" }],
    related: [
      { reference: "T-KQ5", title: "Completed neighbour", status: "Done" },
    ],
  });
  renderSection(base);
  await screen.findByText("All 1 done");
  const linked = screen.getByRole("region", { name: "Linked" });
  expect(
    within(linked)
      .getAllByRole("button", {
        name: /^(Blocked by|Subtickets|Blocks|Related)/,
      })
      .map((group) => group.textContent),
  ).toEqual([
    "Blocked by 1 open1",
    "Subtickets all done1",
    "Blocks 1 open1",
    "Related all finished1",
  ]);
  expect(
    within(linked).getByRole("button", {
      name: /Blocked by 1 open/,
      expanded: true,
    }),
  ).toBeTruthy();
  expect(
    within(linked).getByRole("button", {
      name: /Subtickets all done/,
      expanded: false,
    }),
  ).toBeTruthy();
  expect(
    within(linked).getByRole("button", {
      name: /Blocks 1 open/,
      expanded: true,
    }),
  ).toBeTruthy();
  expect(
    within(linked).getByRole("button", {
      name: /Related all finished/,
      expanded: false,
    }),
  ).toBeTruthy();
  expect(within(linked).getByText("All 1 done")).toBeTruthy();
  expect(
    within(linked).getByRole("button", { name: "Open blocker" }),
  ).toBeTruthy();
  expect(
    within(linked).queryByRole("button", { name: "Completed child" }),
  ).toBeNull();
  expect(within(linked).queryByRole("button", { name: /Add / })).toBeNull();
});

test("a ticket with no links leaves the add action in the context line", async () => {
  bridge();
  renderSection(base);
  await waitFor(() =>
    expect(
      screen.queryByRole("status", { name: "Loading relationships" }),
    ).toBeNull(),
  );
  expect(screen.queryByRole("heading", { name: "Linked" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Add ticket property" }),
  ).toBeTruthy();
});
test("a trashed ticket still shows its relationships, without actions to change them", async () => {
  bridge({
    prerequisites: [
      { reference: "T-KQ2", title: "Blocker", status: "In progress" },
    ],
  });
  renderSection({ ...base, trashed: true });
  await screen.findByText("Blocker");
  expect(screen.getByText("In progress · not done")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Add ticket property" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Remove relationship/ }),
  ).toBeNull();
});

test("loading and a failed read are distinct from having no links", async () => {
  bridge({ never: true });
  const view = render(<Section ticket={base} />);
  expect(
    screen.getByRole("status", { name: "Loading relationships" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add relationship" })).toBeNull();
  view.unmount();
  bridge({ fail: { contextual_relationships: "database busy" } });
  renderSection(base);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't load relationships",
  );
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("builds every row from the one relationships read, including all dependents", async () => {
  bridge({
    related: [{ reference: "T-KQ4", title: "Sibling" }],
    blocking: [
      { reference: "T-KQ6", title: "Waiting" },
      { reference: "T-KQ7", title: "Also waiting" },
    ],
    prerequisites: [
      {
        reference: "T-KQ2",
        title: "Blocker",
        status: "In progress",
        trashed: true,
      },
    ],
    parent: { reference: "T-KQ3", title: "Epic" },
    duplicate_of: {
      reference: "T-KQ9",
      title: "Original",
      status: "Duplicate",
    },
  });
  renderSection(base);
  await screen.findByText("Sibling");
  const rows = screen.getAllByRole("listitem");
  expect(
    rows.map((row) => within(row).getAllByRole("button")[0]?.textContent),
  ).toEqual(["Blocker", "Waiting", "Also waiting", "Sibling", "Original"]);
  expect(screen.getByText("In progress · not done · in Trash")).toBeTruthy();
  const blocker = screen
    .getByRole("button", { name: "Blocker" })
    .closest("li")!;
  expect(
    within(blocker).getByRole("img", {
      name: "In progress · not done · in Trash",
    }),
  ).toBeTruthy();
  const dependent = screen
    .getByRole("button", { name: "Waiting" })
    .closest("li")!;
  expect(within(dependent).getByRole("img", { name: "Todo" })).toBeTruthy();
  const commands = vi.mocked(invoke).mock.calls.map((call) => call[0]);
  expect(commands).not.toContain("dependency_graph");
  expect(commands).not.toContain("show_ticket");
});

test("loads further pages of an open group and keeps them on refresh", async () => {
  const signal = fakeChangeSignal();
  bridge({
    related: [{ reference: "T-KQ4", title: "Sibling" }],
    nextRelated: [{ reference: "T-KQ5", title: "Cousin" }],
    discovered: [{ reference: "T-KQ6", title: "Discovered elsewhere" }],
  });
  renderSection(base, signal);
  expect(await screen.findByRole("button", { name: "Cousin" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Discovered elsewhere" }),
  ).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("contextual_relationships", {
    reference: "T-KQ1",
    offset: 20,
  });
  vi.mocked(invoke).mockClear();
  bridge({
    related: [
      { reference: "T-KQ4", title: "Sibling" },
      { reference: "T-KQ6", title: "New neighbour" },
    ],
    nextRelated: [{ reference: "T-KQ5", title: "Cousin" }],
  });
  await act(async () => signal.change());
  expect(
    await screen.findByRole("button", { name: "New neighbour" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cousin" })).toBeTruthy();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "contextual_relationships")
      .map(([, args]) => (args as { offset: number }).offset),
  ).toEqual([0, 20]);
});

test("opening a finished group reveals every subticket and remembers explicit choices", async () => {
  const children = Array.from({ length: 20 }, (_, index) => ({
    reference: `T-D${index + 1}`,
    title: `Finished task ${index + 1}`,
    status: "Done",
  }));
  bridge({
    children,
    finishedChildren: [
      { reference: "T-D21", title: "Finished task 21", status: "Done" },
    ],
    related: [{ reference: "T-KQ5", title: "Related task" }],
  });
  const view = renderSection(base);
  const linked = within(await screen.findByRole("region", { name: "Linked" }));
  const subtickets = await linked.findByRole("button", {
    name: /Subtickets all done/,
    expanded: false,
  });
  expect(linked.getByText("All 21 done")).toBeTruthy();
  expect(relationshipReads()).toBe(1);
  fireEvent.click(subtickets);
  fireEvent.click(
    linked.getByRole("button", { name: "21 done: T-D1, T-D2 +19" }),
  );
  expect(
    await linked.findByRole("button", { name: "Finished task 21" }),
  ).toBeTruthy();
  fireEvent.click(
    linked.getByRole("button", { name: /Related 1 open/, expanded: true }),
  );
  view.unmount();
  renderSection(base);
  expect(
    await screen.findByRole("button", {
      name: /Subtickets all done/,
      expanded: true,
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /Related 1 open/, expanded: false }),
  ).toBeTruthy();
});

test("subtickets show seven in review, in progress and Todo, with named folds", async () => {
  const children = [
    ...Array.from({ length: 6 }, (_, index) => ({
      reference: `T-T${index + 1}`,
      title: `Todo task ${index + 1}`,
    })),
    { reference: "T-P1", title: "In progress task", status: "In progress" },
    { reference: "T-R1", title: "Review task", status: "In review" },
    ...Array.from({ length: 3 }, (_, index) => ({
      reference: `T-D${index + 1}`,
      title: `Done task ${index + 1}`,
      status: "Done",
    })),
  ];
  bridge({ children });
  renderSection(base);
  await screen.findByText("3 of 11 done");
  const linked = within(screen.getByRole("region", { name: "Linked" }));
  expect(
    linked.getByRole("button", {
      name: /Subtickets 1 in review/,
      expanded: true,
    }),
  ).toBeTruthy();
  expect(
    linked
      .getAllByRole("listitem")
      .map((row) => within(row).getAllByRole("button")[0]?.textContent),
  ).toEqual([
    "Review task",
    "In progress task",
    "Todo task 1",
    "Todo task 2",
    "Todo task 3",
    "Todo task 4",
    "Todo task 5",
  ]);
  fireEvent.click(linked.getByRole("button", { name: "1 more open: T-T6" }));
  fireEvent.click(
    linked.getByRole("button", { name: "3 done: T-D1, T-D2 +1" }),
  );
  expect(linked.getByRole("button", { name: "Todo task 6" })).toBeTruthy();
  expect(linked.getByRole("button", { name: "Done task 3" })).toBeTruthy();
});

test("a partial list of finished subtickets does not count Canceled as open", async () => {
  const canceled = Array.from({ length: 20 }, (_, index) => ({
    reference: `T-C${index + 1}`,
    title: `Canceled task ${index + 1}`,
    status: "Canceled",
  }));
  bridge({
    readChildren: async (offset) =>
      offset
        ? new Promise(() => {})
        : {
            children: pageOf(canceled, 20),
            children_progress: { total: 24, done: 0 },
          },
  });
  renderSection(base);
  const group = await screen.findByRole("button", {
    name: /Subtickets loading links/,
    expanded: false,
  });
  fireEvent.click(group);
  expect(screen.queryByRole("button", { name: /more open/ })).toBeNull();
  expect(
    screen.getByRole("button", { name: /20 finished: T-C1, T-C2/ }),
  ).toBeTruthy();
});

test("loaded open subtickets beyond seven remain reachable before paging completes", async () => {
  const children = Array.from({ length: 20 }, (_, index) => ({
    reference: `T-S${index + 1}`,
    title: `Task ${index + 1}`,
    status: index < 7 ? "Todo" : "Done",
  }));
  bridge({
    readChildren: async (offset) => {
      if (!offset)
        return {
          children: pageOf(children, 20),
          children_progress: { total: 21, done: 14 },
        };
      if (offset === 20)
        return {
          children: pageOf(
            [{ reference: "T-S21", title: "New open subticket" }],
            40,
          ),
          children_progress: { total: 41, done: 22 },
        };
      return new Promise(() => {});
    },
  });
  renderSection(base);
  const overflow = await screen.findByRole("button", {
    name: "1 more open: T-S21",
  });
  fireEvent.click(overflow);
  expect(
    screen.getByRole("button", { name: "New open subticket" }),
  ).toBeTruthy();
});

test("a row whose removal failed comes back, with the reason", async () => {
  bridge({
    prerequisites: [{ reference: "T-KQ2", title: "Blocker" }],
    fail: { remove_dependency: "database busy" },
  });
  renderSection(base);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Remove T-KQ2 from Blocked by",
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't remove Blocked by T-KQ2",
  );
  expect(screen.getByText("Blocker")).toBeTruthy();
  expect(relationshipReads()).toBe(1);
});

test("removing a relationship offers Undo and restores it", async () => {
  const blocker = { reference: "T-KQ2", title: "Blocker" };
  bridge({ prerequisites: [blocker] });
  renderSection(base);
  const remove = await screen.findByRole("button", {
    name: "Remove T-KQ2 from Blocked by",
  });
  bridge();
  fireEvent.click(remove);
  expect(invoke).toHaveBeenCalledWith("remove_dependency", {
    blocker: "T-KQ2",
    dependent: "T-KQ1",
  });
  const undo = await screen.findByRole("button", { name: "Undo" });
  expect(screen.queryByRole("button", { name: "Blocker" })).toBeNull();
  bridge({ prerequisites: [blocker] });
  fireEvent.click(undo);
  expect(invoke).toHaveBeenCalledWith("add_dependency", {
    blocker: "T-KQ2",
    dependent: "T-KQ1",
  });
  expect(await screen.findByRole("button", { name: "Blocker" })).toBeTruthy();
});

test("removing a duplicate link explains the result before anything changes", async () => {
  bridge({
    duplicate_of: { reference: "T-KQ9", title: "Original", status: "Todo" },
  });
  renderSection({ ...base, duplicate_of: "T-KQ9" });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Remove T-KQ9 from Duplicate of",
    }),
  );
  const confirm = await screen.findByRole("dialog", {
    name: "Remove duplicate link",
  });
  expect(confirm.textContent).toContain(
    "T-KQ1 returns to the status it had before",
  );
  expect(confirm.textContent).toContain("Dependencies moved to T-KQ9 stay");
  expect(invoke).not.toHaveBeenCalledWith(
    "remove_duplicate",
    expect.anything(),
  );
  fireEvent.click(
    within(confirm).getByRole("button", { name: "Remove duplicate link" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "remove_duplicate",
      expect.objectContaining({ source: "T-KQ1" }),
    ),
  );
  await waitFor(() => expect(relationshipReads()).toBe(2));
});

test("a double-click removes one relationship, not the next row's too", async () => {
  bridge({
    related: [
      { reference: "T-KQ4", title: "First" },
      { reference: "T-KQ5", title: "Second" },
    ],
  });
  renderSection(base);
  fireEvent.click(
    await screen.findByRole("button", { name: "Remove T-KQ4 from Related to" }),
  );
  // The row collapses at once, and the next row's × arrives under the pointer.
  expect(screen.queryByText("First")).toBeNull();
  // Once the first removal is done, its × is enabled again under the pointer.
  const next = screen.getByRole("button", {
    name: "Remove T-KQ5 from Related to",
  });
  await waitFor(() => expect(next).toHaveProperty("disabled", false));
  fireEvent.click(next);
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command]) => command === "change_contextual_relationship",
        ),
    ).toHaveLength(1),
  );
  expect(screen.getByText("Second")).toBeTruthy();
});

async function chooseTarget() {
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Add ticket property" }),
    { key: "Enter" },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Link a ticket…" }),
  );
  fireEvent.change(
    await screen.findByLabelText("Search tickets by title or reference"),
    { target: { value: "target" } },
  );
  const target = await screen.findByRole("option", { name: /T-KQ5/ });
  expect(screen.queryByRole("option", { name: /Itself/ })).toBeNull();
  fireEvent.click(target);
}

async function chooseRelationship(kind: string) {
  Element.prototype.scrollIntoView = vi.fn();
  const phrase =
    addableKinds.find((item) => item.kind === kind)?.phrase ?? kind;
  fireEvent.keyDown(screen.getByRole("combobox", { name: /^Relationship: / }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("option", { name: phrase }));
}

test("Link ticket adds a relationship in the chosen direction", async () => {
  bridge();
  renderSection(base);
  await chooseTarget();
  await chooseRelationship("blocks");
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Link ticket",
    }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("add_dependency", {
      blocker: "T-KQ1",
      dependent: "T-KQ5",
    }),
  );
  await waitFor(() => expect(relationshipReads()).toBe(2));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a refused link shows the reason inline and keeps the dialog open", async () => {
  bridge({ fail: { add_dependency: "dependency would create a cycle" } });
  renderSection(base);
  await chooseTarget();
  await chooseRelationship("blocked_by");
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Link ticket",
    }),
  );
  await revealFailureDetails();
  expect(screen.getByText(/would create a cycle/)).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("choosing a new parent says it replaces the current one", async () => {
  bridge();
  renderSection({
    ...base,
    parent: { reference: "T-KQ3", title: "Epic", trashed: false },
  });
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Add ticket property" }),
    { key: "Enter" },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Link a ticket…" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByRole("status")).toBeNull();
  await chooseRelationship("parent");
  expect(within(dialog).getByRole("status").textContent).toBe(
    "This replaces the current parent T-KQ3.",
  );
});

test("a source-closed duplicate shows its external, resolved or unknown target without a remove action", async () => {
  bridge({ children: [{ reference: "T-KQ8", title: "Local work" }] });
  const target = (extra: object) => ({
    kind: "external" as const,
    identity: { provider: "github", id: "9" },
    locator: "acme/api#9",
    display: "acme/api#9",
    ...extra,
  });
  const duplicate = (duplicate_target: object) =>
    ({
      ...base,
      status: "Duplicate",
      source: {
        provider: "github",
        provider_name: "GitHub",
        place: "acme/api",
        number: "#1",
        status_choices: ["Todo", "In progress", "In review"],
        id: "1",
        locator: "acme/api#1",
        display: "acme/api#1",
        url: "",
        origin: "imported",
        ownership: "external",
        state: { category: "duplicate", name: "Closed" },
        closure_unrecognized: false,
        last_refreshed_at: null,
        last_attempt_at: null,
        last_error: null,
        content_locked: true,
        status_locked: true,
        duplicate_target,
      },
    }) as unknown as Ticket;
  const view = render(
    <Section key="external" ticket={duplicate(target({}))} />,
  );
  expect(
    await screen.findByText(
      "Subtickets stay local; publishing never includes them.",
    ),
  ).toBeTruthy();
  const row = (await screen.findByText("acme/api#9")).closest("section")!;
  expect(within(row).getByText("Duplicate of")).toBeTruthy();
  expect(within(row).getByText("Not imported into ticketd.")).toBeTruthy();
  expect(within(row).queryByRole("button")).toBeNull();
  view.rerender(
    <Section key="resolved" ticket={duplicate(target({ ticket: "T-KQ7" }))} />,
  );
  const resolved = (
    await screen.findByRole("button", { name: "T-KQ7" })
  ).closest("section")!;
  expect(within(resolved).getByText("acme/api#9")).toBeTruthy();
  view.rerender(
    <Section key="unknown" ticket={duplicate({ kind: "unknown" })} />,
  );
  expect(
    await screen.findByText("The source did not name an accessible original."),
  ).toBeTruthy();
  expect(screen.getByText("Unknown")).toBeTruthy();
});
