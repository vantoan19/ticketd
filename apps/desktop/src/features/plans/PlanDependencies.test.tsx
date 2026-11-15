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
  SelectionPanel: ({ ticket }: { ticket: { reference: string } }) => (
    <aside aria-label="Selected ticket">{ticket.reference}</aside>
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
              reference: "T-KQ1",
              title: "Member",
              status: "Todo",
              availability: "Blocked",
              trashed: false,
              boundary: false,
            },
            {
              id: "2",
              reference: "T-KQ2",
              title: "Outside",
              status: "Todo",
              availability: "Ready",
              trashed: false,
              boundary: true,
            },
          ],
          edges: [{ blocker: "T-KQ2", dependent: "T-KQ1" }],
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
    await screen.findByRole("button", { name: /^T-KQ1: 1 open blocker/ }),
  );
  expect(screen.getByText(/Todo, so it blocks until it is Done/)).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove blocker T-KQ2 from T-KQ1" }),
  );
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("remove_dependency", {
      blocker: "T-KQ2",
      dependent: "T-KQ1",
    }),
  );
});

test("a blocker that would loop is explained by its failure kind, not its wording", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "plan_dependency_graph")
      return {
        nodes: [
          {
            id: "1",
            reference: "T-KQ1",
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
          reference: "T-KQ3",
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
      // The core's message names the loop but not the word "cycle"; the kind
      // decides, and the message only supplies the path (DP-05).
      throw {
        code: "cycle",
        message:
          "T-KQ3 can't block T-KQ1: T-KQ1 already reaches T-KQ3 through T-KQ2.",
      };
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
  expect(
    await screen.findByText("Nothing blocks anything in this Plan yet"),
  ).toBeTruthy();
  expect(screen.getByText(/T-KQ1 is its only ticket/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add blocker…" }));
  fireEvent.change(await screen.findByLabelText("Add a blocker"), {
    target: { value: "Other" },
  });
  fireEvent.click(await screen.findByRole("button", { name: /T-KQ3/ }));
  fireEvent.click(screen.getByRole("button", { name: "Add blocker" }));
  expect(
    await screen.findByText(
      "T-KQ3 already waits on T-KQ1 through T-KQ2, so it can’t block it. Choose another ticket.",
    ),
  ).toBeTruthy();
  // The same choice can never succeed, so Add waits for another ticket.
  expect(
    (screen.getByRole("button", { name: "Add blocker" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("an archived Plan shows its blockers without add or remove controls", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "plan_dependency_graph"
      ? {
          nodes: [
            {
              id: "1",
              reference: "T-KQ1",
              title: "Member",
              status: "Todo",
              availability: "Blocked",
              trashed: false,
              boundary: false,
            },
            {
              id: "2",
              reference: "T-KQ2",
              title: "Other",
              status: "Todo",
              availability: "Ready",
              trashed: false,
              boundary: false,
            },
          ],
          edges: [{ blocker: "T-KQ2", dependent: "T-KQ1" }],
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
    await screen.findByRole("button", { name: /^T-KQ1: 1 open blocker/ }),
  );
  expect(screen.getByLabelText("Blockers of T-KQ1")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Remove blocker/ })).toBeNull();
  expect(screen.queryByLabelText("Add a blocker")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^T-KQ2: No blockers/ }));
  expect(screen.queryByLabelText("Add a blocker")).toBeNull();
});
