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
  BackgroundVariant: { Dots: "dots" },
  Controls: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
}));
vi.mock("@/lib/api/client", () => ({
  client: { contextGraphExpanded: vi.fn() },
}));
vi.mock("@/features/tickets/DependencyGraph", () => ({
  DependencyView: ({
    reference,
    onCenter,
  }: {
    reference: string;
    onCenter: (reference: string) => void;
  }) => (
    <div>
      Dependencies of {reference}
      <button onClick={() => onCenter("T-KQ9")}>Center on T-KQ9</button>
    </div>
  ),
}));
vi.mock("./ContextGraphCanvas", () => ({
  // Each card as a button, and the canvas's caption.
  ContextGraphCanvas: ({
    nodes,
    onSelect,
    footnote,
  }: {
    nodes: { id: string; title?: string; label: string }[];
    onSelect: (id: string) => void;
    footnote?: import("react").ReactNode;
  }) => (
    <div>
      Canvas
      {nodes.map((node) => (
        <button key={node.id} onClick={() => onSelect(node.id)}>
          {node.title ?? node.label}
        </button>
      ))}
      <p>{footnote}</p>
    </div>
  ),
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
  // The panel names the connection from the item's side, with its passage.
  expect(screen.getByRole("heading", { name: "Mentioned by 1" })).toBeTruthy();
  expect(screen.getByText("“Read this”")).toBeTruthy();
  expect(client.contextGraphExpanded).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Center here" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "Second" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Show its connections here" }),
  );
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
  fireEvent.click(
    screen.getByRole("button", { name: "Show its connections here" }),
  );
  await waitFor(() =>
    expect(client.contextGraphExpanded).toHaveBeenCalledTimes(2),
  );
  await screen.findByRole("radio", { name: "Graph", checked: true });
});

test("one graph header, with Open in the panel beside the map", async () => {
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
  const header = (await screen.findByRole("heading", { name: "Graph" }))
    .parentElement!;
  expect(header.textContent).toContain("T-KQ1 · First · 2 items");
  // Graph and List are always there; Dependencies waits for a ticket reference.
  expect(screen.getByRole("radio", { name: "List" })).toBeTruthy();
  expect(
    (screen.getByRole("radio", { name: "Dependencies" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(container.querySelector("[data-slot=graph-panel]")).toBeTruthy();
  const aside = screen.getByRole("complementary", { name: "Selected item" });
  fireEvent.click(within(aside).getByRole("button", { name: "Open T-KQ1" }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "one" }));
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
  // On the map, and in the List.
  expect(
    await screen.findByRole("button", { name: "Old notes (Trash)" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  expect(
    within(screen.getByRole("region", { name: "Mentions" })).getByRole(
      "button",
      { name: "Old notes (Trash)" },
    ),
  ).toBeTruthy();
});

test("a ticket's graph opens on its dependencies; All connections is one click away", async () => {
  vi.mocked(client.contextGraphExpanded).mockResolvedValue({
    center: "one",
    nodes: [
      {
        id: "one",
        kind: "ticket",
        label: "T-KQ1 · First",
        ticket_reference: "T-KQ1",
        state: "Todo",
        trashed: false,
        activity_detail: false,
      },
      {
        id: "two",
        kind: "document",
        label: "Notes",
        state: null,
        trashed: false,
        activity_detail: false,
      },
    ],
    edges: [
      { source: "one", target: "two", kind: "mention", explanation: null },
    ],
    omitted: false,
    omitted_groups: [],
    continuations: [],
    hidden_details: false,
    max_nodes: 50,
    max_edges: 300,
    max_work: 800,
  });
  render(
    <ContextGraph
      origin="T-KQ1"
      dependencies
      onBack={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
  expect(await screen.findByText("Dependencies of T-KQ1")).toBeTruthy();
  expect(
    screen.getByRole("radio", { name: "Dependencies", checked: true }),
  ).toBeTruthy();
  // Centring on a blocker keeps the way back to the ticket.
  fireEvent.click(screen.getByRole("button", { name: "Center on T-KQ9" }));
  await waitFor(() =>
    expect(client.contextGraphExpanded).toHaveBeenLastCalledWith(
      "T-KQ9",
      false,
      [],
      [],
    ),
  );
  expect(screen.getByRole("button", { name: "Back to T-KQ1" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "All connections" }));
  expect(await screen.findByText("Canvas")).toBeTruthy();
  expect(screen.queryByText(/Dependencies of/)).toBeNull();
});
