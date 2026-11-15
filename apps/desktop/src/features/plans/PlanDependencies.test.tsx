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
import { PlanDependencies } from "./PlanDependencies";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@/features/tickets/DependencyGraph", async (original) => ({
  ...(await original<typeof import("@/features/tickets/DependencyGraph")>()),
  // The canvas is React Flow; the panel and rows are what these tests read.
  Canvas: ({
    graph,
    onSelect,
    footnote,
  }: {
    graph: { nodes: { reference: string; title: string }[] };
    onSelect: (ref: string) => void;
    footnote?: import("react").ReactNode;
  }) => (
    <div>
      {graph.nodes.map((node) => (
        <button key={node.reference} onClick={() => onSelect(node.reference)}>
          {node.title}
        </button>
      ))}
      <p>{footnote}</p>
    </div>
  ),
}));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const node = (
  reference: string,
  title: string,
  availability: string,
  boundary = false,
) => ({
  id: reference,
  reference,
  title,
  status: "Todo",
  availability,
  trashed: false,
  boundary,
});
const graphWith = (
  nodes: ReturnType<typeof node>[],
  edges: { blocker: string; dependent: string }[],
) => ({
  nodes,
  edges,
  max_nodes: 50,
  max_depth: 1,
  max_edges: 300,
  max_work: 3000,
  omitted_neighbors: false,
  omitted_edges: false,
  truncated: false,
});
const empty = { items: [], next_offset: null };
function answer(graph: ReturnType<typeof graphWith>) {
  return async (command: string) => {
    if (command === "plan_dependency_graph") return graph;
    if (command === "show_ticket")
      return {
        ...node("T-KQ1", "Member", "Blocked"),
        body: "",
        tags: [],
        project_id: null,
        plan_id: "plan",
        parent: null,
        children: [],
        prerequisites: [
          {
            reference: "T-KQ2",
            title: "Outside",
            status: "Todo",
            trashed: false,
            unresolved: true,
          },
        ],
      };
    if (command === "contextual_relationships")
      return {
        relationships: {
          parent: null,
          children: empty,
          children_progress: { total: 0, done: 0 },
          prerequisites: empty,
          blocking: empty,
          related: empty,
          discovered_while: empty,
          discoveries: empty,
          duplicate_of: null,
          duplicates: empty,
        },
      };
    return undefined;
  };
}

test("the panel lists the Plan's tickets; a ticket shows its blockers, removed with Undo", async () => {
  bridge.invoke.mockImplementation(
    answer(
      graphWith(
        [
          node("T-KQ1", "Member", "Blocked"),
          node("T-KQ2", "Outside", "Ready", true),
        ],
        [{ blocker: "T-KQ2", dependent: "T-KQ1" }],
      ),
    ),
  );
  const refresh = vi.fn(async () => {});
  render(
    <PlanDependencies
      id="plan"
      revision={1}
      projects={[]}
      refresh={refresh}
      onOpen={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  // One panel, one row per member with its open blockers; outside tickets are a caption.
  const tickets = await screen.findByRole("list", { name: "Plan tickets" });
  expect(within(tickets).getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByText(/Dashed: 1 ticket outside this Plan/)).toBeTruthy();
  fireEvent.click(
    within(tickets).getByRole("button", { name: /T-KQ1 Member, 1 open/ }),
  );
  const panel = screen.getByRole("complementary", { name: "Selected ticket" });
  fireEvent.click(
    await within(panel).findByRole("button", {
      name: "Remove blocker T-KQ2 from T-KQ1",
    }),
  );
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("remove_dependency", {
      blocker: "T-KQ2",
      dependent: "T-KQ1",
    }),
  );
  expect(
    await screen.findByText("Removed T-KQ2 as a blocker of T-KQ1"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("add_dependency", {
      blocker: "T-KQ2",
      dependent: "T-KQ1",
    }),
  );
  // Back to the Plan's tickets from the panel.
  fireEvent.click(within(panel).getByRole("button", { name: "Plan tickets" }));
  expect(screen.getByRole("list", { name: "Plan tickets" })).toBeTruthy();
});

test("with nothing to draw, Add blocker… opens the Link ticket dialog on Blocked by", async () => {
  bridge.invoke.mockImplementation(
    answer(graphWith([node("T-KQ1", "Member", "Ready")], [])),
  );
  render(
    <PlanDependencies
      id="plan"
      revision={1}
      projects={[]}
      refresh={vi.fn(async () => {})}
      onOpen={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(
    await screen.findByText("Nothing blocks anything in this Plan yet"),
  ).toBeTruthy();
  // The empty state's action selects the ticket, so its panel shows the way to add.
  fireEvent.click(screen.getByRole("button", { name: "Add blocker…" }));
  const panel = screen.getByRole("complementary", { name: "Selected ticket" });
  fireEvent.click(
    await within(panel).findByRole("button", { name: "Add blocker…" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("is blocked by")).toBeTruthy();
});

test("an archived Plan reads its blockers without add or remove controls", async () => {
  bridge.invoke.mockImplementation(
    answer(
      graphWith(
        [node("T-KQ1", "Member", "Blocked"), node("T-KQ2", "Outside", "Ready")],
        [{ blocker: "T-KQ2", dependent: "T-KQ1" }],
      ),
    ),
  );
  render(
    <PlanDependencies
      id="plan"
      revision={1}
      projects={[]}
      refresh={vi.fn(async () => {})}
      onOpen={vi.fn()}
      onClose={vi.fn()}
      archived
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /T-KQ1 Member, 1 open/ }),
  );
  const panel = screen.getByRole("complementary", { name: "Selected ticket" });
  expect(
    await within(panel).findByText("Read-only while archived."),
  ).toBeTruthy();
  expect(within(panel).getByText("Outside")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Remove blocker/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add blocker…" })).toBeNull();
});
