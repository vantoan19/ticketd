// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi, test, expect } from "vitest";
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
        label: "T-1 · First",
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
  render(<ContextGraph origin="T-1" onBack={vi.fn()} onOpen={open} />);
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
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() =>
    expect(client.contextGraphExpanded).toHaveBeenLastCalledWith(
      "T-1",
      false,
      [],
      [],
    ),
  );
  expect(screen.getByRole("heading", { name: "Discovery" })).toBeTruthy();
});
