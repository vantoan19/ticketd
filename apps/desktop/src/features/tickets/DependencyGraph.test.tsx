// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import DependencyGraph, { SelectionPanel } from "./DependencyGraph";
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
  status: reference === "T-KQ1" ? "Done" : "Todo",
  trashed: false,
  availability,
});
let graph: Graph;
beforeEach(() => {
  graph = {
    nodes: [
      node("T-KQ1", "Design", null),
      node("T-KQ2", "Build", "Ready"),
      node("T-KQ3", "Ship", "Blocked"),
    ],
    edges: [
      { blocker: "T-KQ1", dependent: "T-KQ2" },
      { blocker: "T-KQ2", dependent: "T-KQ3" },
    ],
    max_nodes: 50,
    max_depth: 5,
    max_edges: 300,
    max_work: 3000,
    omitted_neighbors: false,
    omitted_edges: false,
    truncated: false,
  };
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "dependency_graph") return graph;
    if (command === "show_ticket")
      return {
        ...node("T-KQ3", "Ship", "Blocked"),
        body: "",
        tags: [],
        project_id: "p1",
        plan_id: null,
        parent: null,
        children: [],
        // Links beyond the drawn graph still show in the panel.
        prerequisites: [
          {
            reference: "T-KQ2",
            title: "Build",
            status: "Todo",
            trashed: false,
            unresolved: true,
          },
          {
            reference: "T-KQ40",
            title: "Offscreen",
            status: "Todo",
            trashed: false,
            unresolved: true,
          },
        ],
      };
    if (command === "contextual_relationships") {
      const empty = { items: [], next_offset: null };
      const item = (reference: string, title: string) => ({
        reference,
        title: { text: title },
        status: "Todo",
        trashed: false,
        unresolved: true,
      });
      return {
        relationships: {
          parent: null,
          children: empty,
          children_progress: { total: 0, done: 0 },
          prerequisites: empty,
          blocking: {
            items: [item("T-KQ99", "Beyond the graph")],
            next_offset: null,
          },
          related: empty,
          discovered_while: empty,
          discoveries: empty,
          duplicate_of: null,
          duplicates: empty,
        },
      };
    }
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
      reference="T-KQ2"
      revision={0}
      projects={[{ id: "p1", name: "Core", path: "/core", paths: [] }]}
      plans={[]}
      onBack={onBack}
      onOpen={onOpen}
    />,
  );
  return { onBack, onOpen };
}

test("states the arrow direction and keeps a way back to the origin ticket", async () => {
  const { onBack } = renderGraph();
  await screen.findByRole("button", { name: /^T-KQ3\b/ });
  expect(screen.getByText("Arrows point to the work that waits.")).toBeTruthy();
  expect(
    screen.getByText(
      "A Todo ticket is Ready once every ticket with an arrow into it is Done.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to T-KQ2" }));
  expect(onBack).toHaveBeenCalled();
});

test("selecting a node shows what it blocks, its project, and Open", async () => {
  const { onOpen } = renderGraph();
  fireEvent.click(await screen.findByRole("button", { name: /^T-KQ3\b/ }));
  const panel = screen.getByRole("complementary", { name: "Selected ticket" });
  expect(within(panel).getByText("Blocked by")).toBeTruthy();
  expect(await within(panel).findByText("Core")).toBeTruthy();
  // The panel lists the ticket's own links, including ones the graph omits.
  expect(within(panel).getByText("Offscreen")).toBeTruthy();
  expect(await within(panel).findByText("Beyond the graph")).toBeTruthy();
  fireEvent.click(within(panel).getByRole("button", { name: "Open T-KQ3" }));
  expect(onOpen).toHaveBeenCalledWith("T-KQ3");
});

test("marks the origin ticket and says when the graph is limited", async () => {
  graph = { ...graph, truncated: true };
  renderGraph();
  const origin = await screen.findByRole("button", { name: /^T-KQ2\b/ });
  expect(within(origin).getByText("Opened from")).toBeTruthy();
  expect(
    screen.getByText(/up to 5 links from T-KQ2 and at most 50 tickets/),
  ).toBeTruthy();
});

test("re-centers the graph on the selected ticket", async () => {
  renderGraph();
  fireEvent.click(await screen.findByRole("button", { name: /^T-KQ3\b/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Center graph on T-KQ3" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("dependency_graph", {
      reference: "T-KQ3",
    }),
  );
});

test("the selection panel reloads its lists when the graph changes", async () => {
  const ticket = graph.nodes[2]!;
  const view = render(
    <SelectionPanel
      ticket={ticket}
      origin=""
      projects={[]}
      version={graph}
      onOpen={() => {}}
    />,
  );
  await screen.findByText("Offscreen");
  const shows = () =>
    vi.mocked(invoke).mock.calls.filter(([c]) => c === "show_ticket").length;
  const before = shows();
  view.rerender(
    <SelectionPanel
      ticket={ticket}
      origin=""
      projects={[]}
      version={{ ...graph }}
      onOpen={() => {}}
    />,
  );
  await waitFor(() => expect(shows()).toBe(before + 1));
});
