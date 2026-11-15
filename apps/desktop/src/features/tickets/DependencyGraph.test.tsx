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
import { DependencyView, SelectionPanel } from "./DependencyGraph";
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

function renderGraph(onCenter = vi.fn(), onOpen = vi.fn()) {
  render(
    <DependencyView
      reference="T-KQ2"
      revision={0}
      projects={[{ id: "p1", name: "Core", path: "/core", paths: [] }]}
      plans={[]}
      view="graph"
      onCenter={onCenter}
      onOpen={onOpen}
    />,
  );
  return { onCenter, onOpen };
}

test("the legend names only what the graph shows, in one row", async () => {
  renderGraph();
  await screen.findByRole("button", { name: /^T-KQ3\b/ });
  const legend = screen.getByRole("list", { name: "Legend" });
  expect(
    within(legend)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["blocks", "Ready", "Blocked"]);
  // The zoom readout is not announced on every change.
  const zoom = screen.getByRole("group", { name: "Zoom" });
  expect(within(zoom).queryByRole("status")).toBeNull();
});

test("selecting a node shows what it blocks, its project, and Open", async () => {
  const { onOpen } = renderGraph();
  fireEvent.click(await screen.findByRole("button", { name: /^T-KQ3\b/ }));
  const panel = screen.getByRole("complementary", { name: "Selected ticket" });
  expect(await within(panel).findByText(/Core/)).toBeTruthy();
  // The panel lists the ticket's own links, including ones the graph omits.
  expect(within(panel).getByText("Offscreen")).toBeTruthy();
  expect(within(panel).getByText("Beyond the graph")).toBeTruthy();
  fireEvent.click(within(panel).getByRole("button", { name: "Open T-KQ3" }));
  expect(onOpen).toHaveBeenCalledWith("T-KQ3");
});

test("panel rows are buttons: a drawn ticket is selected, another is centred", async () => {
  const { onCenter } = renderGraph();
  fireEvent.click(await screen.findByRole("button", { name: /^T-KQ3\b/ }));
  const panel = screen.getByRole("complementary", { name: "Selected ticket" });
  fireEvent.click(
    await within(panel).findByRole("button", { name: /T-KQ40.*Offscreen/ }),
  );
  expect(onCenter).toHaveBeenCalledWith("T-KQ40");
  fireEvent.click(within(panel).getByRole("button", { name: /T-KQ2.*Build/ }));
  await waitFor(() =>
    expect(
      within(
        screen.getByRole("complementary", { name: "Selected ticket" }),
      ).getByRole("heading", { name: "Build" }),
    ).toBeTruthy(),
  );
});

test("Center here centres the graph on the selected ticket", async () => {
  const { onCenter } = renderGraph();
  fireEvent.click(await screen.findByRole("button", { name: /^T-KQ3\b/ }));
  fireEvent.click(screen.getByRole("button", { name: "Center here" }));
  expect(onCenter).toHaveBeenCalledWith("T-KQ3");
});

test("says how far a limited graph reaches", async () => {
  graph = { ...graph, truncated: true };
  renderGraph();
  expect(
    await screen.findByText(/up to 5 links from T-KQ2 and at most 50 tickets/),
  ).toBeTruthy();
});

test("a panel that could not load says so and retries instead of loading forever", async () => {
  const base = vi.mocked(invoke).getMockImplementation()!;
  let fail = true;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "show_ticket" && fail) throw new Error("disk is gone");
    return base(command, args);
  });
  render(
    <SelectionPanel
      ticket={graph.nodes[2]!}
      nodes={graph.nodes}
      projects={[]}
      onOpen={() => {}}
      onSelect={() => {}}
    />,
  );
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.queryByText("Loading…")).toBeNull();
  fail = false;
  fireEvent.click(retry);
  expect(await screen.findByText("Offscreen")).toBeTruthy();
});

test("the selection panel reloads its lists when the graph changes", async () => {
  const ticket = graph.nodes[2]!;
  const view = render(
    <SelectionPanel
      ticket={ticket}
      nodes={graph.nodes}
      projects={[]}
      version={graph}
      onOpen={() => {}}
      onSelect={() => {}}
    />,
  );
  await screen.findByText("Offscreen");
  const shows = () =>
    vi.mocked(invoke).mock.calls.filter(([c]) => c === "show_ticket").length;
  const before = shows();
  view.rerender(
    <SelectionPanel
      ticket={ticket}
      nodes={graph.nodes}
      projects={[]}
      version={{ ...graph }}
      onOpen={() => {}}
      onSelect={() => {}}
    />,
  );
  await waitFor(() => expect(shows()).toBe(before + 1));
});
