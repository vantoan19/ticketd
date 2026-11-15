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

const flow: { onMoveStart?: ((event: unknown) => void) | undefined } = {};
const instance = {
  fitView: vi.fn(),
  zoomTo: vi.fn(),
  getNodes: () => [],
  getZoom: () => 1,
};
vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: {
    onInit: (value: unknown) => void;
    onMoveStart?: (event: unknown) => void;
  }) => {
    flow.onMoveStart = props.onMoveStart;
    props.onInit(instance);
    return <div>Canvas</div>;
  },
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
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

test("the legend is one row inside the canvas naming only the kinds drawn; zoom steps and Fit stays at 100%", () => {
  const view = render(
    <ContextGraphCanvas
      edges={[
        { id: "0", source: "a", target: "b", label: "blocks" },
        { id: "1", source: "a", target: "c", label: "related" },
        { id: "2", source: "a", target: "d", label: "attached" },
      ]}
      selected={null}
      positions={{}}
      onPositions={vi.fn()}
      viewport={{ x: 0, y: 0, zoom: 0.6 }}
      onViewport={vi.fn()}
      onSelect={vi.fn()}
      onError={vi.fn()}
      nodes={[{ id: "a", label: "A" }]}
    />,
  );
  const canvas = view.getByLabelText("Connections canvas");
  // One row inside the canvas, top-right.
  const legend = within(canvas).getByRole("list", { name: "Legend" });
  // It lists only the kinds drawn, by the names on their lines, one sample per line style.
  expect(
    within(legend)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["blocks", "related", "attached"]);
  const zoom = within(canvas).getByRole("group", { name: "Zoom" });
  expect(zoom.textContent).toContain("60%");
  // The readout is not announced on every change.
  expect(within(zoom).queryByRole("status")).toBeNull();
  fireEvent.click(within(zoom).getByRole("button", { name: "Zoom in" }));
  // One press steps the shown 60% by the standard 1.2 factor.
  expect(instance.zoomTo).toHaveBeenLastCalledWith(
    expect.closeTo(0.72, 5),
    expect.anything(),
  );
  fireEvent.click(within(zoom).getByRole("button", { name: "Fit to view" }));
  // Fit never goes below 100%: cards stay legible and the person pans.
  expect(instance.fitView).toHaveBeenCalledWith(
    expect.objectContaining({ minZoom: 1 }),
  );
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

test("a resize refits after Fit, even when the viewport syncs back, but not after a person's own pan", () => {
  vi.useFakeTimers();
  let notify: () => void = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  try {
    render(
      <ContextGraphCanvas
        edges={[]}
        selected={null}
        positions={{}}
        onPositions={vi.fn()}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onViewport={vi.fn()}
        onSelect={vi.fn()}
        onError={vi.fn()}
        nodes={[{ id: "a", label: "A" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fit to view" }));
    // The controlled viewport syncing back starts a move with a marker object.
    flow.onMoveStart?.({ sync: true });
    flow.onMoveStart?.(null);
    instance.fitView.mockClear();
    notify();
    act(() => vi.advanceTimersByTime(200));
    expect(instance.fitView).toHaveBeenCalledTimes(1);

    // A real wheel or pointer move is the person's: later resizes keep their view.
    flow.onMoveStart?.(new WheelEvent("wheel"));
    instance.fitView.mockClear();
    notify();
    act(() => vi.advanceTimersByTime(200));
    expect(instance.fitView).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
