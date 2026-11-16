// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { client } from "@/lib/api/client";
import { WorkspaceGraph } from "./WorkspaceGraph";

afterEach(cleanup);

vi.mock("./ContextGraphCanvas", () => ({
  ContextGraphCanvas: ({
    edges,
    nodes,
    notice,
    footnote,
    onSelect,
  }: {
    edges: { label?: string }[];
    nodes: { id: string; label: string }[];
    onSelect: (id: string) => void;
    notice?: import("react").ReactNode;
    footnote?: import("react").ReactNode;
  }) => (
    <div data-testid="canvas">
      {nodes.map((node) => (
        <button
          key={node.id}
          data-card={node.id}
          onClick={() => onSelect(node.id)}
        >
          {node.label.replace(/^[^:]+: /, "")}
        </button>
      ))}
      {edges.map((edge, index) => (
        <span key={index}>{edge.label}</span>
      ))}
      {notice}
      <p>{footnote}</p>
    </div>
  ),
}));
vi.mock("@xyflow/react", () => ({
  ReactFlow: () => <div>Canvas</div>,
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  Controls: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
}));
vi.mock("@/lib/api/client", () => ({
  client: {
    workspaceGraph: vi.fn(),
    listPlans: vi.fn().mockResolvedValue([]),
    findTicketMetadata: vi.fn(async (_filter, ids: string[]) => ({
      items: ids.map((id) => ({
        id,
        reference: id === "one" ? "T-KQ1" : "T-KQ2",
        title: id === "one" ? "First" : "Second",
        status: "Todo",
        trashed: false,
        project_id: null,
        plan_id: null,
        availability: "Ready",
        updated_at: "2026-11-06T00:00:00Z",
      })),
      omitted: false,
    })),
  },
}));

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
    connection_counts: { doc: 2 },
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
  fireEvent.click(screen.getByRole("button", { name: "Center here" }));
  expect(focus).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Filter" }));
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
        label: "T-KQ1 · First",
        state: "Todo",
        trashed: false,
        activity_detail: false,
      },
    ],
    edges: [],
    connection_counts: { one: 3 },
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
    (await screen.findAllByRole("button", { name: "T-KQ1 · First" })).at(-1)!,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Show more connections" }),
  );
  await waitFor(() =>
    expect(client.workspaceGraph).toHaveBeenCalledWith(
      expect.objectContaining({ adjacency_limit: 6 }),
    ),
  );
  expect(screen.getByRole("button", { name: "Center here" })).toBeTruthy();
});

test("connects visible items across candidate pages", async () => {
  const first = {
    id: "one",
    kind: "ticket" as const,
    label: "T-KQ1 · First",
    state: null,
    trashed: false,
    activity_detail: false,
  };
  const second = {
    id: "two",
    kind: "ticket" as const,
    label: "T-KQ2 · Second",
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
  fireEvent.click(screen.getByRole("button", { name: "Filter" }));
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
  const first = nodeOf("one", "T-KQ1 · First");
  const second = nodeOf("two", "T-KQ2 · Second");
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
  (await screen.findAllByRole("button", { name: "T-KQ1 · First" })).at(-1)!;
  rerender(<WorkspaceGraph {...props} revision={1} />);
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findAllByRole("button", { name: "T-KQ2 · Second" });
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
    screen.getAllByRole("button", { name: "T-KQ2 · Second" }).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("marks items in the Trash", async () => {
  vi.mocked(client.workspaceGraph)
    .mockReset()
    .mockResolvedValue(graphOf([nodeOf("one", "T-KQ1 · Old", true)], null));
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
    await screen.findByRole("button", { name: "T-KQ1 · Old (Trash)" }),
  ).toBeTruthy();
});

test("a crowded workspace opens Graph with every loaded item", async () => {
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
  await screen.findByRole("button", { name: "Doc 0" });
  expect(
    screen.getByRole("radio", { name: "Graph" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.getByTestId("canvas").querySelectorAll("[data-card]"),
  ).toHaveLength(13);
  expect(screen.getByRole("radio", { name: "List" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  fireEvent.click(screen.getByRole("button", { name: "Doc 0" }));
  expect(screen.getByText(/49 connections in total/)).toBeTruthy();
});

test("items with no relationship remain available on the canvas", async () => {
  vi.mocked(client.workspaceGraph)
    .mockReset()
    .mockResolvedValue(graphOf([nodeOf("lone", "T-KQ4 · Dark mode")], null));
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
    await screen.findByRole("button", { name: "T-KQ4 · Dark mode" }),
  );
  expect(screen.getByRole("button", { name: "Open T-KQ4" })).toBeTruthy();
});

test("an item created while the graph is open is added, not left counted but unseen", async () => {
  const first = nodeOf("one", "T-KQ1 · First");
  const created = nodeOf("new", "Untitled");
  vi.mocked(client.workspaceGraph)
    .mockReset()
    .mockImplementation((request) => {
      // Hydration only refreshes the shown items, but the total already counts the new one.
      if (request.hydrate_only)
        return Promise.resolve({ ...graphOf([first], null), total: 2 });
      if (request.visible_ids.length)
        return Promise.resolve(graphOf([first, created], null));
      return Promise.resolve(graphOf([first], null));
    });
  const props = {
    active: true,
    onBack: vi.fn(),
    onFocus: vi.fn(),
    onOpen: vi.fn(),
  };
  const { rerender } = render(<WorkspaceGraph {...props} revision={0} />);
  await screen.findByText(/Showing 1 of 1 item/);
  rerender(<WorkspaceGraph {...props} revision={1} />);
  await screen.findByText(/Showing 2 of 2 items/);
  expect(screen.getByText("2 items · 0 connections")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Untitled" })).toBeTruthy();
});

test("a selected ticket offers Open and, with connections, Center here", async () => {
  vi.mocked(client.workspaceGraph).mockResolvedValue({
    node_tags: {},
    total: 1,
    nodes: [
      {
        id: "one",
        kind: "ticket",
        label: "T-KQ1 · First",
        state: "Todo",
        trashed: false,
        activity_detail: false,
      },
    ],
    edges: [],
    connection_counts: { one: 1 },
    next_cursor: null,
    omitted: false,
    omitted_groups: [],
  });
  const open = vi.fn();
  const focus = vi.fn();
  render(
    <WorkspaceGraph
      active
      revision={0}
      onBack={vi.fn()}
      onFocus={focus}
      onOpen={open}
    />,
  );
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "T-KQ1 · First" })).at(-1)!,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open T-KQ1" }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "one" }));
  fireEvent.click(screen.getByRole("button", { name: "Center here" }));
  expect(focus).not.toHaveBeenCalled();
});
