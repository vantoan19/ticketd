// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PlanDependencies } from "./PlanDependencies";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@/features/tickets/DependencyGraph", () => ({
  Canvas: ({
    graph,
    onSelect,
  }: {
    graph: { nodes: { reference: string; title: string }[] };
    onSelect: (ref: string) => void;
  }) => (
    <div>
      {graph.nodes.map((node) => (
        <button key={node.reference} onClick={() => onSelect(node.reference)}>
          {node.title}
        </button>
      ))}
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
test("shows outside blockers and edits dependencies through the shared workflow", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "plan_dependency_graph"
      ? {
          nodes: [
            {
              id: "1",
              reference: "T-1",
              title: "Member",
              status: "Todo",
              availability: "Blocked",
              trashed: false,
              boundary: false,
            },
            {
              id: "2",
              reference: "T-2",
              title: "Outside",
              status: "Todo",
              availability: "Ready",
              trashed: false,
              boundary: true,
            },
          ],
          edges: [{ blocker: "T-2", dependent: "T-1" }],
          max_nodes: 50,
          max_depth: 1,
          max_edges: 300,
          max_work: 3000,
          omitted_neighbors: false,
          omitted_edges: false,
          truncated: false,
        }
      : undefined,
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
  fireEvent.click(
    await screen.findByRole("button", { name: /^T-1: 1 open blocker/ }),
  );
  expect(screen.getByText(/Todo, so it blocks until it is Done/)).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove blocker T-2 from T-1" }),
  );
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("remove_dependency", {
      blocker: "T-2",
      dependent: "T-1",
    }),
  );
});

test("a rejected blocker is explained next to the form", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "plan_dependency_graph")
      return {
        nodes: [
          {
            id: "1",
            reference: "T-1",
            title: "Member",
            status: "Todo",
            availability: "Ready",
            trashed: false,
            boundary: false,
          },
        ],
        edges: [],
        max_nodes: 50,
        max_depth: 1,
        max_edges: 300,
        max_work: 3000,
        omitted_neighbors: false,
        omitted_edges: false,
        truncated: false,
      };
    if (command === "search_tickets")
      return [
        {
          id: "3",
          reference: "T-3",
          title: "Other",
          status: "Todo",
          body: "",
          trashed: false,
          tags: [],
          plan_id: null,
          project_id: null,
          availability: "Ready",
          prerequisites: [],
          parent: null,
          children: [],
        },
      ];
    if (command === "add_dependency")
      throw "dependency would create a cycle or self-link";
    return undefined;
  });
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
  fireEvent.click(
    await screen.findByRole("button", { name: /^T-1: Add blocker/ }),
  );
  fireEvent.change(screen.getByLabelText("Add a blocker"), {
    target: { value: "Other" },
  });
  fireEvent.click(await screen.findByRole("button", { name: /T-3/ }));
  fireEvent.click(screen.getByRole("button", { name: "Add blocker" }));
  expect((await screen.findByText(/already blocks T-3/)).textContent).toContain(
    "T-1",
  );
});

test("an archived Plan shows its blockers without add or remove controls", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "plan_dependency_graph"
      ? {
          nodes: [
            {
              id: "1",
              reference: "T-1",
              title: "Member",
              status: "Todo",
              availability: "Blocked",
              trashed: false,
              boundary: false,
            },
            {
              id: "2",
              reference: "T-2",
              title: "Other",
              status: "Todo",
              availability: "Ready",
              trashed: false,
              boundary: false,
            },
          ],
          edges: [{ blocker: "T-2", dependent: "T-1" }],
          max_nodes: 50,
          max_depth: 1,
          max_edges: 300,
          max_work: 3000,
          omitted_neighbors: false,
          omitted_edges: false,
          truncated: false,
        }
      : [],
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
    await screen.findByRole("button", { name: /^T-1: 1 open blocker/ }),
  );
  expect(screen.getByLabelText("Blockers of T-1")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Remove blocker/ })).toBeNull();
  expect(screen.queryByLabelText("Add a blocker")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^T-2: No blockers/ }));
  expect(screen.queryByLabelText("Add a blocker")).toBeNull();
});
