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
import { client } from "@/lib/api/client";
import { WorkspaceGraph } from "./WorkspaceGraph";

afterEach(cleanup);

vi.mock("./ContextGraphCanvas", () => ({
  ContextGraphCanvas: ({
    edges,
    nodes,
  }: {
    edges: { label?: string }[];
    nodes: { id: string }[];
  }) => (
    <div data-testid="canvas">
      {nodes.map((node) => (
        <i key={node.id} data-card={node.id} />
      ))}
      {edges.map((edge, index) => (
        <span key={index}>{edge.label}</span>
      ))}
    </div>
  ),
}));
vi.mock("@xyflow/react", () => ({
  ReactFlow: () => <div>Canvas</div>,
  Background: () => null,
  Controls: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
}));
vi.mock("@/lib/api/client", () => ({ client: { workspaceGraph: vi.fn() } }));

test("filters workspace results and focuses a selected item deliberately", async () => {
  vi.mocked(client.workspaceGraph).mockResolvedValue({
    node_tags: {},
    total: 1,
    nodes: [
      {
        id: "doc",
        kind: "document",
        label: "Discovery",
        state: null,
        trashed: false,
        activity_detail: false,
      },
    ],
    edges: [],
    next_cursor: null,
    omitted: false,
    omitted_groups: [],
  });
  const focus = vi.fn();
  render(
    <WorkspaceGraph
      active
      revision={0}
      onBack={vi.fn()}
      onFocus={focus}
      onOpen={vi.fn()}
    />,
  );
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Discovery" })).at(-1)!,
  );
  fireEvent.click(screen.getByRole("button", { name: "Context graph" }));
  expect(focus).toHaveBeenCalledWith("doc");
  fireEvent.change(screen.getByLabelText("Search"), {
    target: { value: "needle" },
  });
  await waitFor(() =>
    expect(client.workspaceGraph).toHaveBeenCalledWith(
      expect.objectContaining({ search: "needle" }),
    ),
  );
});

test("expands omitted connections while retaining the selected item", async () => {
  vi.mocked(client.workspaceGraph).mockResolvedValue({
    node_tags: {},
    total: 1,
    nodes: [
      {
        id: "one",
        kind: "ticket",
        label: "T-1 · First",
        state: "Todo",
        trashed: false,
        activity_detail: false,
      },
    ],
    edges: [],
    next_cursor: null,
    omitted: true,
    omitted_groups: ["blocks"],
  });
  render(
    <WorkspaceGraph
      active
      revision={0}
      onBack={vi.fn()}
      onFocus={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "T-1 · First" })).at(-1)!,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Show more connections" }),
  );
  await waitFor(() =>
    expect(client.workspaceGraph).toHaveBeenCalledWith(
      expect.objectContaining({ adjacency_limit: 6 }),
    ),
  );
  expect(screen.getByRole("button", { name: "Context graph" })).toBeTruthy();
});

test("connects visible items across candidate pages", async () => {
  const first = {
    id: "one",
    kind: "ticket" as const,
    label: "T-1 · First",
    state: null,
    trashed: false,
    activity_detail: false,
  };
  const second = {
    id: "two",
    kind: "ticket" as const,
    label: "T-2 · Second",
    state: null,
    trashed: false,
    activity_detail: false,
  };
  vi.mocked(client.workspaceGraph)
    .mockReset()
    .mockResolvedValueOnce({
      node_tags: {},
      total: 1,
      nodes: [first],
      edges: [],
      next_cursor: "cursor",
      omitted: true,
      omitted_groups: [],
    })
    .mockResolvedValueOnce({
      node_tags: {},
      total: 1,
      nodes: [first, second],
      edges: [
        { source: "one", target: "two", kind: "blocks", explanation: null },
      ],
      next_cursor: null,
      omitted: false,
      omitted_groups: [],
    });
  render(
    <WorkspaceGraph
      active
      revision={0}
      onBack={vi.fn()}
      onFocus={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  await waitFor(() =>
    expect(client.workspaceGraph).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "cursor", visible_ids: ["one"] }),
    ),
  );
  expect((await screen.findAllByText("blocks")).length).toBeGreaterThan(0);
});

test("a filter with no matches says so and can be cleared", async () => {
  vi.mocked(client.workspaceGraph).mockReset().mockResolvedValue({
    node_tags: {},
    total: 0,
    nodes: [],
    edges: [],
    next_cursor: null,
    omitted: false,
    omitted_groups: [],
  });
  render(
    <WorkspaceGraph
      active
      revision={0}
      onBack={vi.fn()}
      onFocus={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
  fireEvent.change(await screen.findByLabelText("Search"), {
    target: { value: "zzz" },
  });
  expect(await screen.findByText(/No items match these filters/)).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
  expect((screen.getByLabelText("Search") as HTMLInputElement).value).toBe("");
});

const nodeOf = (id: string, label: string, trashed = false) => ({
  id,
  kind: "ticket" as const,
  label,
  state: null,
  trashed,
  activity_detail: false,
});
const graphOf = (
  nodes: ReturnType<typeof nodeOf>[],
  next_cursor: string | null,
) => ({
  node_tags: {},
  total: nodes.length,
  nodes,
  edges: [],
  next_cursor,
  omitted: next_cursor !== null,
  omitted_groups: [],
});

test("a slow refresh does not erase pages loaded after it started", async () => {
  const first = nodeOf("one", "T-1 · First");
  const second = nodeOf("two", "T-2 · Second");
  let releaseHydrate: (value: ReturnType<typeof graphOf>) => void = () => {};
  vi.mocked(client.workspaceGraph)
    .mockReset()
    .mockImplementation((request) => {
      if (request.hydrate_only && request.visible_ids.length === 1)
        return new Promise((resolve) => {
          releaseHydrate = resolve;
        });
      if (request.hydrate_only)
        return Promise.resolve(graphOf([first, second], null));
      if (request.cursor)
        return Promise.resolve(graphOf([first, second], null));
      return Promise.resolve(graphOf([first], "cursor"));
    });
  const props = {
    active: true,
    onBack: vi.fn(),
    onFocus: vi.fn(),
    onOpen: vi.fn(),
  };
  const { rerender } = render(<WorkspaceGraph {...props} revision={0} />);
  (await screen.findAllByRole("button", { name: "T-1 · First" })).at(-1)!;
  rerender(<WorkspaceGraph {...props} revision={1} />);
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findAllByRole("button", { name: "T-2 · Second" });
  releaseHydrate(graphOf([first], "cursor"));
  await waitFor(() =>
    expect(client.workspaceGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        hydrate_only: true,
        visible_ids: ["one", "two"],
      }),
    ),
  );
  expect(
    screen.getAllByRole("button", { name: "T-2 · Second" }).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("marks items in the Trash", async () => {
  vi.mocked(client.workspaceGraph)
    .mockReset()
    .mockResolvedValue(graphOf([nodeOf("one", "T-1 · Old", true)], null));
  render(
    <WorkspaceGraph
      active
      revision={0}
      onBack={vi.fn()}
      onFocus={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
  expect(
    await screen.findByRole("button", { name: "T-1 · Old (Trash)" }),
  ).toBeTruthy();
});

test("a crowded workspace opens as a list and the map is one click away", async () => {
  vi.mocked(client.workspaceGraph).mockResolvedValue({
    node_tags: {},
    connection_counts: { n0: 49 },
    total: 13,
    nodes: Array.from({ length: 13 }, (_, i) => ({
      id: `n${i}`,
      kind: "document" as const,
      label: `Doc ${i}`,
      state: null,
      trashed: false,
      activity_detail: false,
    })),
    edges: [],
    next_cursor: null,
    omitted: false,
    omitted_groups: [],
  });
  render(
    <WorkspaceGraph
      active
      revision={0}
      onBack={vi.fn()}
      onFocus={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("radio", { name: "Graph" }));
  expect(screen.getByRole("radio", { name: "List" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  expect(screen.getByText(/49 connections/)).toBeTruthy();
});

test("items with no relationship leave the canvas for a Not connected list", async () => {
  vi.mocked(client.workspaceGraph)
    .mockReset()
    .mockResolvedValue({
      ...graphOf(
        [
          nodeOf("one", "T-1 · First"),
          nodeOf("two", "T-2 · Second"),
          nodeOf("lone", "T-4 · Dark mode"),
        ],
        null,
      ),
      edges: [
        { source: "one", target: "two", kind: "blocks", explanation: null },
      ],
    });
  render(
    <WorkspaceGraph
      active
      revision={0}
      onBack={vi.fn()}
      onFocus={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
  await screen.findByText("3 items · 1 relationship");
  const canvas = screen.getByTestId("canvas");
  expect(canvas.querySelectorAll("[data-card]")).toHaveLength(2);
  expect(canvas.querySelector('[data-card="lone"]')).toBeNull();
  const group = screen.getByRole("group", { name: "Not connected" });
  expect(group.textContent).toContain("Not connected · 1");
  fireEvent.click(
    within(group).getByRole("button", { name: "T-4 · Dark mode" }),
  );
  expect(await screen.findByRole("button", { name: "Open item" })).toBeTruthy();
});
