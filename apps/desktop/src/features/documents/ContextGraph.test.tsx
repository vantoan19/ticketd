// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, vi, test, expect } from "vitest";

afterEach(cleanup);
import { ContextGraph } from "./ContextGraph";
import { client } from "@/lib/api/client";

vi.mock("@xyflow/react", () => ({
  ReactFlow: () => <div>Canvas</div>,
  Background: () => null,
  Controls: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
}));
vi.mock("@/lib/api/client", () => ({
  client: { contextGraphExpanded: vi.fn() },
}));

test("previews a connection and focuses it only on request", async () => {
  vi.mocked(client.contextGraphExpanded).mockResolvedValue({
    center: "one",
    nodes: [
      {
        id: "one",
        kind: "ticket",
        label: "T-KQ1 · First",
        state: "Todo",
        trashed: false,
        activity_detail: false,
      },
      {
        id: "two",
        kind: "document",
        label: "Discovery",
        state: null,
        trashed: false,
        activity_detail: false,
      },
    ],
    edges: [
      {
        source: "one",
        target: "two",
        kind: "mention",
        explanation: "Read this",
      },
    ],
    omitted: false,
    omitted_groups: [],
    continuations: [],
    hidden_details: false,
    max_nodes: 50,
    max_edges: 300,
    max_work: 800,
  });
  const open = vi.fn();
  render(<ContextGraph origin="T-KQ1" onBack={vi.fn()} onOpen={open} />);
  fireEvent.click(await screen.findByRole("button", { name: "Discovery" }));
  expect(screen.getByText("Read this", { exact: false })).toBeTruthy();
  expect(client.contextGraphExpanded).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Center on this item" }));
  await waitFor(() =>
    expect(client.contextGraphExpanded).toHaveBeenCalledWith(
      "two",
      false,
      [],
      [],
    ),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Back to T-KQ1 · First" }),
  );
  await waitFor(() =>
    expect(client.contextGraphExpanded).toHaveBeenLastCalledWith(
      "T-KQ1",
      false,
      [],
      [],
    ),
  );
  expect(screen.getByRole("heading", { name: "Discovery" })).toBeTruthy();
});

test("drops an expansion whose item is no longer shown", async () => {
  const node = (id: string, label: string) => ({
    id,
    kind: "ticket" as const,
    label,
    state: "Todo",
    trashed: false,
    activity_detail: false,
  });
  const graph = (nodes: ReturnType<typeof node>[]) => ({
    center: "one",
    nodes,
    edges: [],
    omitted: false,
    omitted_groups: [],
    continuations: [],
    hidden_details: false,
    max_nodes: 50,
    max_edges: 300,
    max_work: 800,
  });
  const first = node("one", "T-KQ1 · First");
  const second = node("two", "T-KQ2 · Second");
  vi.mocked(client.contextGraphExpanded)
    .mockReset()
    .mockImplementation(async (_center, _details, expanded) =>
      expanded.includes("two") ? graph([first]) : graph([first, second]),
    );
  render(<ContextGraph origin="one" onBack={vi.fn()} onOpen={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "T-KQ2 · Second" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand connections" }));
  await waitFor(() =>
    expect(client.contextGraphExpanded).toHaveBeenLastCalledWith(
      "one",
      false,
      [],
      [],
    ),
  );
});

test("a crowded neighbourhood opens as a grouped list with a map toggle", async () => {
  const nodes = Array.from({ length: 14 }, (_, index) => ({
    id: `n${index}`,
    kind: "ticket" as const,
    label: `T-KQ${index} · Item`,
    state: "Todo",
    trashed: false,
    activity_detail: false,
  }));
  vi.mocked(client.contextGraphExpanded)
    .mockReset()
    .mockResolvedValue({
      center: "n0",
      nodes,
      edges: nodes.slice(1).map((node) => ({
        source: "n0",
        target: node.id,
        kind: "mention" as const,
        explanation: null,
      })),
      omitted: false,
      omitted_groups: [],
      continuations: [],
      hidden_details: false,
      max_nodes: 100,
      max_edges: 300,
      max_work: 800,
    });
  render(<ContextGraph origin="n0" onBack={vi.fn()} onOpen={vi.fn()} />);
  expect(
    await screen.findByRole("heading", { name: "Mentions 13" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Graph" }));
  expect(
    screen.getByRole("radio", { name: "Graph", checked: true }),
  ).toBeTruthy();
});

test("expanding a map that grows past the list-first size keeps the map", async () => {
  const node = (id: string) => ({
    id,
    kind: "ticket" as const,
    label: `T-KQ${id} · Item`,
    state: "Todo",
    trashed: false,
    activity_detail: false,
  });
  const graph = (count: number) => ({
    center: "n0",
    nodes: Array.from({ length: count }, (_, index) => node(`n${index}`)),
    edges: [],
    omitted: false,
    omitted_groups: [],
    continuations: [],
    hidden_details: false,
    max_nodes: 50,
    max_edges: 300,
    max_work: 800,
  });
  vi.mocked(client.contextGraphExpanded)
    .mockReset()
    .mockImplementation(async (_center, _details, expanded) =>
      graph(expanded.length ? 20 : 3),
    );
  render(<ContextGraph origin="n0" onBack={vi.fn()} onOpen={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "T-KQn1 · Item" }));
  fireEvent.click(screen.getByRole("button", { name: "Expand connections" }));
  await waitFor(() =>
    expect(client.contextGraphExpanded).toHaveBeenCalledTimes(2),
  );
  await screen.findByRole("radio", { name: "Graph", checked: true });
});

test("one 48px toolbar, with Open item in the panel beside the map", async () => {
  const node = (id: string, kind: "ticket" | "document", label: string) => ({
    id,
    kind,
    label,
    state: null,
    trashed: false,
    activity_detail: false,
  });
  vi.mocked(client.contextGraphExpanded).mockResolvedValue({
    center: "one",
    nodes: [
      node("one", "ticket", "T-KQ1 · First"),
      node("two", "document", "D"),
    ],
    edges: [
      { source: "one", target: "two", kind: "mention", explanation: "x" },
    ],
    omitted: false,
    omitted_groups: [],
    continuations: [],
    hidden_details: false,
    max_nodes: 50,
    max_edges: 300,
    max_work: 800,
  });
  const open = vi.fn();
  const { container } = render(
    <ContextGraph origin="T-KQ1" onBack={vi.fn()} onOpen={open} />,
  );
  const header = (await screen.findByRole("heading", { name: "Context graph" }))
    .parentElement!;
  expect(header.textContent).toContain("2 items · 1 relationship");
  expect(screen.queryByText(/Centered on/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Show (list|map)/ })).toBeNull();
  expect(screen.queryByText("Include update details")).toBeNull();
  const aside = container.querySelector(".context-graph-preview")!;
  fireEvent.click(within(aside as HTMLElement).getByText("Open item"));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "one" }));
  // The legend has its own row beside the canvas, never over it.
  const canvas = screen.getByText("Canvas").parentElement!;
  expect(canvas.querySelector(".graph-legend")).toBeNull();
  expect(container.querySelector(".graph-legend")).toBeTruthy();
});

test("marks a trashed item in the Connected items list", async () => {
  vi.mocked(client.contextGraphExpanded).mockResolvedValue({
    center: "one",
    nodes: [
      {
        id: "one",
        kind: "ticket",
        label: "T-KQ1 · First",
        state: "Todo",
        trashed: false,
        activity_detail: false,
      },
      {
        id: "two",
        kind: "document",
        label: "Old notes",
        state: null,
        trashed: true,
        activity_detail: false,
      },
    ],
    edges: [
      { source: "one", target: "two", kind: "mention", explanation: "x" },
    ],
    omitted: false,
    omitted_groups: [],
    continuations: [],
    hidden_details: false,
    max_nodes: 50,
    max_edges: 300,
    max_work: 800,
  });
  render(<ContextGraph origin="T-KQ1" onBack={vi.fn()} onOpen={vi.fn()} />);
  expect(
    await screen.findByRole("button", { name: "Old notes (Trash)" }),
  ).toBeTruthy();
});
