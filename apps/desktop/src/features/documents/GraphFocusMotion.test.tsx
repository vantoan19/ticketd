// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  applyTokens,
  instantTokens,
  reducedTokens,
  rootTokens,
} from "@/test/motion-tokens";
import { ContextGraphCanvas } from "./ContextGraphCanvas";

// Focusing a ticket or island in the Workspace graph (DESIGN.md section 12):
// the view glides to it and zooms in on the smooth spring, everything else
// dims, and Fit glides back. The tokens own the time, so these tests apply the
// real ones.

type Flow = {
  nodes: { id: string; className?: string }[];
  edges: { id: string; className?: string }[];
  viewport?: unknown;
  onMoveStart?: ((event: unknown) => void) | undefined;
};
const flow: Flow = { nodes: [], edges: [] };
const instance = {
  fitView: vi.fn(),
  fitBounds: vi.fn(),
  setCenter: vi.fn(),
  setViewport: vi.fn(),
  zoomTo: vi.fn(),
  getNodes: () => [],
  getZoom: () => 1,
};
vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: Flow & { onInit: (value: unknown) => void }) => {
    flow.nodes = props.nodes;
    flow.edges = props.edges;
    flow.viewport = props.viewport;
    flow.onMoveStart = props.onMoveStart;
    props.onInit(instance);
    return <div>Canvas</div>;
  },
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  Handle: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
}));

let restoreTokens: () => void;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
  // The canvas fits only once it has a size.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  for (const mock of Object.values(instance))
    if (typeof mock === "function" && "mockClear" in mock) mock.mockClear();
});
afterEach(() => {
  cleanup();
  restoreTokens();
  vi.restoreAllMocks();
});

const cards = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
  { id: "c", label: "C" },
];
const islands = [
  {
    id: "plan",
    title: "Plan",
    caption: "2 tickets",
    x: 0,
    y: 0,
    width: 700,
    height: 200,
    memberIds: ["a", "b"],
  },
];

function canvas(props: Partial<Parameters<typeof ContextGraphCanvas>[0]> = {}) {
  return (
    <ContextGraphCanvas
      nodes={cards}
      edges={[
        { id: "ab", source: "a", target: "b" },
        { id: "bc", source: "b", target: "c" },
      ]}
      islands={islands}
      selected={null}
      positions={{
        a: { x: 10, y: 10 },
        b: { x: 260, y: 10 },
        c: { x: 10, y: 300 },
        plan: { x: 20, y: 20 },
      }}
      onPositions={vi.fn()}
      viewport={{ x: 0, y: 0, zoom: 1 }}
      onViewport={vi.fn()}
      onSelect={vi.fn()}
      onError={vi.fn()}
      {...props}
    />
  );
}
const dim = (list: { id: string; className?: string }[]) =>
  list.filter((item) => item.className === "is-dim").map((item) => item.id);

test("focusing a ticket dims everything else and lines that do not touch only it", () => {
  render(canvas({ focusId: "a" }));
  expect(dim(flow.nodes)).toEqual(["b", "c"]);
  expect(dim(flow.edges)).toEqual(["ab", "bc"]);
});

test("focusing an island keeps its cards and the lines between them", () => {
  render(canvas({ focusId: "plan" }));
  expect(dim(flow.nodes)).toEqual(["c"]);
  expect(dim(flow.edges)).toEqual(["bc"]);
});

test("nothing dims without a focus", () => {
  render(canvas());
  expect(dim(flow.nodes)).toEqual([]);
  expect(dim(flow.edges)).toEqual([]);
});

test("a focused ticket is centred and zoomed in on, gliding on the smooth spring", async () => {
  render(canvas({ focusId: "a", centerOn: "a" }));
  await waitFor(() => expect(instance.setCenter).toHaveBeenCalled());
  const [, , options] = instance.setCenter.mock.calls[0]!;
  expect(options.zoom).toBeGreaterThan(1);
  expect(options.duration).toBeGreaterThan(0);
  expect(typeof options.ease).toBe("function");
});

test("a focused island fills the view", async () => {
  render(canvas({ focusId: "plan", centerOn: "plan" }));
  await waitFor(() => expect(instance.fitBounds).toHaveBeenCalled());
  const [bounds, options] = instance.fitBounds.mock.calls[0]!;
  expect(bounds).toEqual({ x: 0, y: 0, width: 700, height: 200 });
  expect(options.duration).toBeGreaterThan(0);
});

test("centring without a focus keeps the zoom, as the item graph does", async () => {
  render(canvas({ centerOn: "a" }));
  await waitFor(() => expect(instance.setCenter).toHaveBeenCalled());
  expect(instance.setCenter.mock.calls[0]![2].zoom).toBe(1);
});

test("Fit glides back and tells the page everything is shown again", () => {
  const showAll = vi.fn();
  render(canvas({ focusId: "a", onShowAll: showAll }));
  fireEvent.click(screen.getByRole("button", { name: "Fit to view" }));
  expect(showAll).toHaveBeenCalled();
  expect(instance.fitView).toHaveBeenLastCalledWith(
    expect.objectContaining({ duration: expect.any(Number) }),
  );
  expect(instance.fitView.mock.lastCall![0].duration).toBeGreaterThan(0);
});

test.each([
  ["reduced motion", reducedTokens],
  ["a held key", instantTokens],
])("under %s the view jumps", async (_name, tokens) => {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...tokens });
  render(canvas({ focusId: "a", centerOn: "a" }));
  await waitFor(() => expect(instance.setCenter).toHaveBeenCalled());
  expect(instance.setCenter.mock.calls[0]![2].duration).toBe(0);
});

// React Flow hands a controlled viewport back after every frame of a glide, one
// render behind, and snaps the view to it: the glide ends after a step. So the
// canvas leaves the viewport out while it glides (useViewportGlide).
test("while the view glides the canvas leaves its viewport to React Flow, and takes it back on arrival", async () => {
  let arrive: () => void = () => {};
  instance.setCenter.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      arrive = resolve;
    }),
  );
  render(canvas({ focusId: "a", centerOn: "a" }));
  await waitFor(() => expect(instance.setCenter).toHaveBeenCalled());
  await waitFor(() => expect(flow.viewport).toBeUndefined());
  await act(async () => arrive());
  await waitFor(() => expect(flow.viewport).toEqual({ x: 0, y: 0, zoom: 1 }));
});

test("a person's own pan or zoom hands the viewport back before the glide ends", async () => {
  instance.setCenter.mockReturnValueOnce(new Promise<void>(() => {}));
  render(canvas({ focusId: "a", centerOn: "a" }));
  await waitFor(() => expect(flow.viewport).toBeUndefined());
  act(() => flow.onMoveStart?.(new Event("wheel")));
  await waitFor(() => expect(flow.viewport).toEqual({ x: 0, y: 0, zoom: 1 }));
});

test("a Fit that is interrupted still hands the viewport back", async () => {
  vi.useFakeTimers();
  try {
    instance.fitView.mockReturnValueOnce(new Promise<void>(() => {}));
    render(canvas({ focusId: "a" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit to view" }));
    expect(flow.viewport).toBeUndefined();
    // A glide cut off by another never reports its end; the glide's time plus
    // a short grace gives the viewport back.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(flow.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ["reduced motion", reducedTokens],
  ["a held key", instantTokens],
])(
  "under %s the viewport stays controlled: a jump has nothing to cut short",
  async (_name, tokens) => {
    restoreTokens();
    restoreTokens = applyTokens({ ...rootTokens, ...tokens });
    render(canvas({ focusId: "a", centerOn: "a" }));
    await waitFor(() => expect(instance.setCenter).toHaveBeenCalled());
    expect(flow.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  },
);
