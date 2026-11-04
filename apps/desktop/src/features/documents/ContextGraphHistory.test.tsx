// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    onPositions,
    onViewport,
  }: {
    positions: Record<string, { x: number; y: number }>;
    viewport: { x: number; y: number; zoom: number };
    onPositions: (p: Record<string, { x: number; y: number }>) => void;
    onViewport: (v: { x: number; y: number; zoom: number }) => void;
  }) => (
    <>
      <output data-testid="view">
        {JSON.stringify({ positions, viewport })}
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
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
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
  expect(screen.getByRole("heading", { name: "two" })).toBeTruthy();
});
