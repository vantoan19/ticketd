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
import type { PlanViewState } from "./usePlanView";

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
  const run = async (change: () => Promise<unknown>) => {
    await change();
    return true;
  };
  const state: PlanViewState = {
    view: null,
    loadError: "",
    pending: false,
    actionError: "",
    run,
  };
  render(
    <PlanDependencies id="plan" revision={1} state={state} onOpen={vi.fn()} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Outside" }));
  expect(screen.getByText("Todo · Ready · Outside Plan")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Member" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove blocker T-2" }));
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("remove_dependency", {
      blocker: "T-2",
      dependent: "T-1",
    }),
  );
  fireEvent.change(screen.getByLabelText("Blocker ticket reference"), {
    target: { value: "T-3" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add blocker" }));
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("add_dependency", {
      blocker: "T-3",
      dependent: "T-1",
    }),
  );
});
