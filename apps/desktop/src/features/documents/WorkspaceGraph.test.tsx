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
  ContextGraphCanvas: ({ edges }: { edges: { label?: string }[] }) => (
    <div>
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
  fireEvent.click(await screen.findByRole("button", { name: "Discovery" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "T-1 · First" }));
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
  expect((await screen.findAllByText("Blocks")).length).toBeGreaterThan(0);
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
