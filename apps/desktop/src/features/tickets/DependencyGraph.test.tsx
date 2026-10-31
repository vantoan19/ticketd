// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import DependencyGraph from "./DependencyGraph";
import type { DependencyGraph as Graph } from "@/lib/api/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.DOMMatrixReadOnly = class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;

const node = (
  reference: string,
  title: string,
  availability: string | null,
) => ({
  id: reference,
  reference,
  title,
  status: reference === "T-1" ? "Done" : "Todo",
  trashed: false,
  availability,
});
let graph: Graph;
beforeEach(() => {
  graph = {
    nodes: [
      node("T-1", "Design", null),
      node("T-2", "Build", "Ready"),
      node("T-3", "Ship", "Blocked"),
    ],
    edges: [
      { blocker: "T-1", dependent: "T-2" },
      { blocker: "T-2", dependent: "T-3" },
    ],
    max_nodes: 50,
    max_depth: 5,
    truncated: false,
  };
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "dependency_graph") return graph;
    if (command === "show_ticket")
      return {
        ...node("T-3", "Ship", "Blocked"),
        body: "",
        tags: [],
        project_id: "p1",
        effort_id: null,
        parent: null,
        children: [],
        prerequisites: [],
      };
    throw new Error(`unexpected ${command}`);
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderGraph(onBack = vi.fn(), onOpen = vi.fn()) {
  render(
    <DependencyGraph
      reference="T-2"
      revision={0}
      projects={[{ id: "p1", name: "Core", path: "/core", paths: [] }]}
      efforts={[]}
      onBack={onBack}
      onOpen={onOpen}
    />,
  );
  return { onBack, onOpen };
}

test("states the arrow direction and keeps a way back to the origin ticket", async () => {
  const { onBack } = renderGraph();
  await screen.findByRole("button", { name: /^T-3\b/ });
  expect(screen.getByText("Arrows point to the work that waits.")).toBeTruthy();
  expect(
    screen.getByText("A ticket is Ready once every ticket above it is Done."),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to T-2" }));
  expect(onBack).toHaveBeenCalled();
});

test("selecting a node shows what it blocks, its project, and Open", async () => {
  const { onOpen } = renderGraph();
  fireEvent.click(await screen.findByRole("button", { name: /^T-3\b/ }));
  const panel = screen.getByRole("complementary", { name: "Selected ticket" });
  expect(within(panel).getByText("Blocked by")).toBeTruthy();
  expect(await within(panel).findByText("Core")).toBeTruthy();
  fireEvent.click(within(panel).getByRole("button", { name: "Open T-3" }));
  expect(onOpen).toHaveBeenCalledWith("T-3");
});

test("marks the origin ticket and says when the graph is limited", async () => {
  graph = { ...graph, truncated: true };
  renderGraph();
  const origin = await screen.findByRole("button", { name: /^T-2\b/ });
  expect(within(origin).getByText("Opened from")).toBeTruthy();
  expect(
    screen.getByText(/up to 5 links from T-2 and at most 50 tickets/),
  ).toBeTruthy();
});
