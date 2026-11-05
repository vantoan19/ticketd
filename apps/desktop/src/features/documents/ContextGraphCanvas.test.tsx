// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ContextGraphCanvas } from "./ContextGraphCanvas";

const instance = {
  fitView: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  getNodes: () => [],
  getZoom: () => 1,
};
vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ onInit }: { onInit: (value: unknown) => void }) => {
    onInit(instance);
    return <div>Canvas</div>;
  },
  Background: () => null,
  Handle: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
}));

test("metadata refresh keeps layout and stale worker results are ignored", () => {
  const workers: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }[] = [];
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror = null;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() {
      workers.push(this);
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  const onPositions = vi.fn();
  const base = {
    edges: [],
    selected: null,
    positions: {},
    onPositions,
    viewport: { x: 0, y: 0, zoom: 1 },
    onViewport: vi.fn(),
    onSelect: vi.fn(),
    onError: vi.fn(),
  };
  const view = render(
    <ContextGraphCanvas {...base} nodes={[{ id: "a", label: "Old" }]} />,
  );
  expect(workers).toHaveLength(1);
  view.rerender(
    <ContextGraphCanvas {...base} nodes={[{ id: "a", label: "Updated" }]} />,
  );
  expect(workers).toHaveLength(1);
  view.rerender(
    <ContextGraphCanvas
      {...base}
      nodes={[
        { id: "a", label: "Updated" },
        { id: "b", label: "B" },
      ]}
    />,
  );
  expect(workers).toHaveLength(2);
  const firstId = workers[0]!.postMessage.mock.calls[0]![0].id;
  const secondId = workers[1]!.postMessage.mock.calls[0]![0].id;
  act(() =>
    workers[0]!.onmessage?.({
      data: { id: firstId, positions: { a: { x: 1, y: 1 } } },
    } as MessageEvent),
  );
  expect(onPositions).not.toHaveBeenCalled();
  act(() =>
    workers[1]!.onmessage?.({
      data: { id: secondId, positions: { a: { x: 2, y: 2 } } },
    } as MessageEvent),
  );
  expect(onPositions).toHaveBeenCalledWith({ a: { x: 2, y: 2 } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("the legend has its own row beside the canvas, one zoom and Fit control stays on it, and Fit never clips", () => {
  const view = render(
    <ContextGraphCanvas
      edges={[]}
      selected={null}
      positions={{}}
      onPositions={vi.fn()}
      viewport={{ x: 0, y: 0, zoom: 0.5 }}
      onViewport={vi.fn()}
      onSelect={vi.fn()}
      onError={vi.fn()}
      nodes={[]}
    />,
  );
  const canvas = view.getByLabelText("Connections canvas");
  // The legend is not drawn over the canvas, so it can never cover a card.
  const legend = view.getByRole("list", { name: "Legend" });
  expect(canvas.contains(legend)).toBe(false);
  expect(canvas.parentElement?.contains(legend)).toBe(true);
  const zoom = within(canvas).getByRole("group", { name: "Zoom" });
  expect(zoom.textContent).toContain("50%");
  fireEvent.click(within(zoom).getByRole("button", { name: "Zoom in" }));
  expect(instance.zoomIn).toHaveBeenCalled();
  fireEvent.click(within(zoom).getByRole("button", { name: "Fit" }));
  // Fit keeps cards legible; the user pans for the rest.
  expect(instance.fitView).toHaveBeenCalledWith(
    expect.objectContaining({ minZoom: 0.5 }),
  );
  expect(screen.getByRole("button", { name: "Fit" })).toBeTruthy();
});

test("the canvas stays hidden until the first fit, so the map is never seen at the starting zoom", () => {
  vi.stubGlobal(
    "Worker",
    class {
      postMessage = vi.fn();
      terminate = vi.fn();
    },
  );
  const view = render(
    <ContextGraphCanvas
      edges={[]}
      selected={null}
      positions={{}}
      onPositions={vi.fn()}
      viewport={{ x: 0, y: 0, zoom: 1 }}
      onViewport={vi.fn()}
      onSelect={vi.fn()}
      onError={vi.fn()}
      fit
      nodes={[{ id: "a", label: "A" }]}
    />,
  );
  // Pending is an opacity fade, not visibility: React Flow shows measured cards
  // with `visibility: visible`, which would leak them through a hidden canvas.
  const canvas = view.getByLabelText("Connections canvas");
  expect(canvas.hasAttribute("data-pending")).toBe(true);
  expect(canvas.style.visibility).toBe("");
});
