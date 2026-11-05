// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ContextGraphCanvas } from "./ContextGraphCanvas";

vi.mock("@xyflow/react", () => ({
  ReactFlow: () => <div>Canvas</div>,
  Background: () => null,
  Controls: () => null,
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
afterEach(() => vi.unstubAllGlobals());
