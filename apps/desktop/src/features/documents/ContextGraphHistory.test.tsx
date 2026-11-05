// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { client } from "@/lib/api/client";
import { ContextGraph } from "./ContextGraph";

vi.mock("@/lib/api/client", () => ({
  client: { contextGraphExpanded: vi.fn() },
}));
vi.mock("./ContextGraphCanvas", () => ({
  ContextGraphCanvas: ({
    positions,
    viewport,
    fit,
    centerOn,
    onPositions,
    onViewport,
  }: {
    positions: Record<string, { x: number; y: number }>;
    viewport: { x: number; y: number; zoom: number };
    fit: boolean;
    centerOn: string | null;
    onPositions: (p: Record<string, { x: number; y: number }>) => void;
    onViewport: (v: { x: number; y: number; zoom: number }) => void;
  }) => (
    <>
      <output data-testid="view">
        {JSON.stringify({ positions, viewport, fit, centerOn })}
      </output>
      <button
        onClick={() => {
          onPositions({ one: { x: 12, y: 34 } });
          onViewport({ x: 5, y: 6, zoom: 2 });
        }}
      >
        Move view
      </button>
    </>
  ),
}));

test("Back restores selection, coordinates, viewport and expansion request", async () => {
  const nodes = ["one", "two"].map((id) => ({
    id,
    kind: "ticket" as const,
    label: id,
    state: null,
    trashed: false,
    activity_detail: false,
  }));
  vi.mocked(client.contextGraphExpanded).mockImplementation(
    async (reference) => ({
      center: reference === "two" ? "two" : "one",
      nodes,
      edges: [],
      omitted: false,
      omitted_groups: [],
      continuations: [],
      hidden_details: false,
      max_nodes: 100,
      max_edges: 300,
      max_work: 1000,
    }),
  );
  render(<ContextGraph origin="one" onBack={vi.fn()} onOpen={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "two" }));
  fireEvent.click(screen.getByRole("button", { name: "Expand connections" }));
  await waitFor(() =>
    expect(client.contextGraphExpanded).toHaveBeenLastCalledWith(
      "one",
      false,
      ["two"],
      [],
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Move view" }));
  fireEvent.click(screen.getByRole("button", { name: "Center on this item" }));
  await waitFor(() =>
    expect(client.contextGraphExpanded).toHaveBeenLastCalledWith(
      "two",
      false,
      [],
      [],
    ),
  );
  // Center keeps the zoom and asks the canvas to centre the focused card.
  expect(screen.getByTestId("view").textContent).toContain('"zoom":2');
  expect(screen.getByTestId("view").textContent).toContain('"centerOn":"two"');
  expect(screen.getByTestId("view").textContent).toContain('"fit":false');
  fireEvent.click(screen.getByRole("button", { name: /^Back to / }));
  await waitFor(() =>
    expect(client.contextGraphExpanded).toHaveBeenLastCalledWith(
      "one",
      false,
      ["two"],
      [],
    ),
  );
  expect(screen.getByTestId("view").textContent).toContain(
    '"one":{"x":12,"y":34}',
  );
  expect(screen.getByTestId("view").textContent).toContain(
    '"x":5,"y":6,"zoom":2',
  );
  expect(screen.getByTestId("view").textContent).toContain('"centerOn":null');
  expect(screen.getByTestId("view").textContent).toContain('"fit":false');
  expect(screen.getByText("two", { selector: "h2" })).toBeTruthy();
});

test("Back with no history names the source item and returns it", async () => {
  const node = {
    id: "id-1",
    kind: "ticket" as const,
    label: "Source work",
    ticket_reference: "T-15",
    state: null,
    trashed: false,
    activity_detail: false,
  };
  vi.mocked(client.contextGraphExpanded).mockResolvedValue({
    center: "id-1",
    nodes: [node],
    edges: [],
    omitted: false,
    omitted_groups: [],
    continuations: [],
    hidden_details: false,
    max_nodes: 100,
    max_edges: 300,
    max_work: 1000,
  });
  const onBack = vi.fn();
  render(<ContextGraph origin="T-15" onBack={onBack} onOpen={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Back to T-15" }));
  expect(onBack).toHaveBeenCalledWith(node);
});

test("Back to a centre that opened as a map and grew past the list limit keeps the map", async () => {
  const make = (count: number) =>
    Array.from({ length: count + 1 }, (_, index) => ({
      id: index === 0 ? "hub" : `n${index}`,
      kind: "ticket" as const,
      label: index === 0 ? "hub" : `n${index}`,
      state: null,
      trashed: false,
      activity_detail: false,
    }));
  const graphFor = (center: string, count: number) => ({
    center,
    nodes: center === "hub" ? make(count) : make(1),
    edges: [],
    omitted: false,
    omitted_groups: [],
    continuations: [],
    hidden_details: false,
    max_nodes: 100,
    max_edges: 300,
    max_work: 1000,
  });
  vi.mocked(client.contextGraphExpanded).mockImplementation(
    async (reference, _details, expanded) =>
      graphFor(reference === "n1" ? "n1" : "hub", expanded.length ? 13 : 12),
  );
  cleanup();
  render(<ContextGraph origin="hub" onBack={vi.fn()} onOpen={vi.fn()} />);
  await screen.findByTestId("view");
  fireEvent.click(screen.getByRole("button", { name: "n2" }));
  fireEvent.click(screen.getByRole("button", { name: "Expand connections" }));
  await screen.findByRole("radio", { name: "Graph", checked: true });
  fireEvent.click(screen.getByRole("button", { name: "n1" }));
  fireEvent.click(screen.getByRole("button", { name: "Center on this item" }));
  await waitFor(() =>
    expect(client.contextGraphExpanded).toHaveBeenLastCalledWith(
      "n1",
      false,
      [],
      [],
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: /^Back to / }));
  await screen.findByRole("radio", { name: "Graph", checked: true });
  expect(screen.getByTestId("view")).toBeTruthy();
});
