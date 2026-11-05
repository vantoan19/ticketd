// @vitest-environment jsdom
import {
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
import { Subtickets } from "@/features/tickets/Subtickets";
import { useLinkedWork } from "@/features/tickets/useLinkedWork";
import type { Ticket } from "@/lib/api/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const base: Ticket = {
  id: "1",
  reference: "T-1",
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
    duplicate_of?: Item;
    duplicates?: Item[];
    more?: number;
    fail?: Record<string, string>;
    never?: boolean;
  } = {},
) {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    const failure = options.fail?.[command];
    if (failure) throw failure;
    if (command === "contextual_relationships") {
      if (options.never) return new Promise(() => {});
      return {
        relationships: {
          parent: options.parent ? related(options.parent) : null,
          children: pageOf(options.children),
          children_progress: {
            total: options.children?.length ?? 0,
            done:
              options.children?.filter((item) => item.status === "Done")
                .length ?? 0,
          },
          prerequisites: pageOf(options.prerequisites),
          blocking: pageOf(options.blocking),
          related: pageOf(options.related, options.more ?? null),
          discovered_while: page,
          discoveries: page,
          duplicate_of: options.duplicate_of
            ? related(options.duplicate_of)
            : null,
          duplicates: pageOf(options.duplicates),
        },
      };
    }
    if (command === "search_tickets")
      return [other("T-5", "Target"), other("T-1", "Itself")];
    return base;
  });
}
/** The rail's Relationships and the Subtickets section share one read. */
function Section({
  ticket,
  refresh,
  onOpenGraph,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
  onOpenGraph: () => void;
}) {
  const work = useLinkedWork(ticket, 0, refresh);
  return (
    <>
      <Subtickets work={work} select={vi.fn()} />
      <LinkedWork work={work} select={vi.fn()} onOpenGraph={onOpenGraph} />
      <LinkedWorkDialogs work={work} />
    </>
  );
}
function renderSection(
  ticket: Ticket,
  refresh = vi.fn(async () => {}),
  onOpenGraph = vi.fn(),
) {
  render(
    <Section ticket={ticket} refresh={refresh} onOpenGraph={onOpenGraph} />,
  );
  return refresh;
}

test("a ticket with no links shows only Add relationship once the read succeeds", async () => {
  bridge();
  renderSection(base);
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(screen.getByRole("button", { name: "Add relationship" })).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Relationships" }).textContent,
  ).toBe("Relationships");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Dependencies" })).toBeNull();
});

test("loading and a failed read are distinct from having no links", async () => {
  bridge({ never: true });
  const view = render(
    <Section ticket={base} refresh={async () => {}} onOpenGraph={() => {}} />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Loading relationships",
  );
  view.unmount();
  bridge({ fail: { contextual_relationships: "database busy" } });
  renderSection(base);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Could not load relationships: database busy",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("builds every row from the one relationships read, including all dependents", async () => {
  bridge({
    related: [{ reference: "T-4", title: "Sibling" }],
    blocking: [
      { reference: "T-6", title: "Waiting" },
      { reference: "T-7", title: "Also waiting" },
    ],
    prerequisites: [
      {
        reference: "T-2",
        title: "Blocker",
        status: "In progress",
        trashed: true,
      },
    ],
    parent: { reference: "T-3", title: "Epic" },
    duplicate_of: { reference: "T-9", title: "Original", status: "Duplicate" },
  });
  renderSection(base);
  await screen.findByText("Sibling");
  const rows = screen.getAllByRole("listitem");
  expect(rows.map((row) => row.getAttribute("data-kind"))).toEqual([
    "parent",
    "blocked_by",
    "blocks",
    "blocks",
    "related",
    "duplicate_of",
  ]);
  expect(screen.getByText("In progress · not done · in trash")).toBeTruthy();
  const blocker = screen
    .getByRole("button", { name: "Blocker" })
    .closest("li")!;
  expect(
    within(blocker).getByRole("img", {
      name: "In progress · not done · in trash",
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

test("shows n+ and loads the next page when more links exist", async () => {
  bridge({ related: [{ reference: "T-4", title: "Sibling" }], more: 20 });
  renderSection(base);
  await screen.findByText("Sibling");
  expect(screen.getByRole("button", { name: "Show more links" })).toBeTruthy();
});

test("the Dependencies action opens the dependency graph", async () => {
  bridge({ prerequisites: [{ reference: "T-2", title: "Blocker" }] });
  const onOpenGraph = vi.fn();
  renderSection(base, undefined, onOpenGraph);
  fireEvent.click(await screen.findByRole("button", { name: "Dependencies" }));
  expect(onOpenGraph).toHaveBeenCalled();
});

test("Remove relationship takes the link off the ticket", async () => {
  bridge({ prerequisites: [{ reference: "T-2", title: "Blocker" }] });
  const refresh = renderSection(base);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Remove relationship: Blocked by T-2",
    }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("remove_dependency", {
      blocker: "T-2",
      dependent: "T-1",
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

test("removing a duplicate link explains the result before anything changes", async () => {
  bridge({
    duplicate_of: { reference: "T-9", title: "Original", status: "Todo" },
  });
  const refresh = renderSection({ ...base, duplicate_of: "T-9" });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Remove relationship: Duplicate of T-9",
    }),
  );
  const confirm = await screen.findByRole("dialog", {
    name: "Remove duplicate link",
  });
  expect(confirm.textContent).toContain("T-1 stops being a duplicate of T-9");
  expect(confirm.textContent).toContain("review them separately");
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
      expect.objectContaining({ source: "T-1" }),
    ),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

async function chooseTarget() {
  fireEvent.click(screen.getByRole("button", { name: "Add relationship" }));
  fireEvent.change(await screen.findByLabelText("Ticket"), {
    target: { value: "target" },
  });
  const matches = await screen.findByRole("list", { name: "Matches" });
  expect(within(matches).queryByText("Itself")).toBeNull();
  fireEvent.click(within(matches).getByRole("button", { name: /T-5/ }));
}

test("Link ticket adds a relationship in the chosen direction", async () => {
  bridge();
  const refresh = renderSection(base);
  await chooseTarget();
  fireEvent.change(screen.getByLabelText("Relationship"), {
    target: { value: "blocks" },
  });
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Link ticket",
    }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("add_dependency", {
      blocker: "T-1",
      dependent: "T-5",
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a refused link shows the reason inline and keeps the dialog open", async () => {
  bridge({ fail: { add_dependency: "dependency would create a cycle" } });
  renderSection(base);
  await chooseTarget();
  fireEvent.change(screen.getByLabelText("Relationship"), {
    target: { value: "blocked_by" },
  });
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Link ticket",
    }),
  );
  expect(await screen.findByText(/would create a cycle/)).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("choosing a new parent says it replaces the current one", async () => {
  bridge();
  renderSection({
    ...base,
    parent: { reference: "T-3", title: "Epic", trashed: false },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add relationship" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByRole("status")).toBeNull();
  fireEvent.change(within(dialog).getByLabelText("Relationship"), {
    target: { value: "parent" },
  });
  expect(within(dialog).getByRole("status").textContent).toBe(
    "This replaces the current parent T-3.",
  );
});

test("subtickets read under the description with local progress, not in the rail", async () => {
  bridge({
    children: [
      { reference: "T-8", title: "Finished part", status: "Done" },
      { reference: "T-9", title: "Open part", status: "In progress" },
    ],
  });
  renderSection(base);
  expect(await screen.findByText("1 of 2 done")).toBeTruthy();
  const progress = screen.getByRole("progressbar", {
    name: "Subticket progress",
  });
  expect(progress.getAttribute("max")).toBe("2");
  expect(progress.getAttribute("value")).toBe("1");
  // The rail's Relationships holds no subtickets, so it collapses to its action.
  expect(screen.getByRole("button", { name: "Add relationship" })).toBeTruthy();
  expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual(
    [expect.stringContaining("T-8"), expect.stringContaining("T-9")],
  );
});

test("Link subticket opens the link dialog already saying this ticket is the parent", async () => {
  bridge({
    children: [{ reference: "T-8", title: "Part", status: "Todo" }],
  });
  renderSection(base);
  fireEvent.click(
    await screen.findByRole("button", { name: "Link subticket" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(
    (within(dialog).getByLabelText("Relationship") as HTMLSelectElement).value,
  ).toBe("subticket");
});

test("a source-closed duplicate shows its external, resolved or unknown target without a remove action", async () => {
  bridge();
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
        state: { state: "closed", reason: "duplicate" },
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
    <Section
      ticket={duplicate(target({}))}
      refresh={async () => {}}
      onOpenGraph={() => {}}
    />,
  );
  const row = (await screen.findByText("acme/api#9")).closest("li")!;
  expect(within(row).getByText("Duplicate of")).toBeTruthy();
  expect(within(row).getByText("Not imported into ticketd.")).toBeTruthy();
  expect(within(row).queryByRole("button")).toBeNull();
  view.rerender(
    <Section
      ticket={duplicate(target({ ticket: "T-7" }))}
      refresh={async () => {}}
      onOpenGraph={() => {}}
    />,
  );
  const resolved = (await screen.findByRole("button", { name: "T-7" })).closest(
    "li",
  )!;
  expect(within(resolved).getByText("acme/api#9")).toBeTruthy();
  view.rerender(
    <Section
      ticket={duplicate({ kind: "unknown" })}
      refresh={async () => {}}
      onOpenGraph={() => {}}
    />,
  );
  expect(
    await screen.findByText("The source did not name an accessible original."),
  ).toBeTruthy();
  expect(screen.getByText("Unknown")).toBeTruthy();
});
