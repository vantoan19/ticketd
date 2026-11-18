// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { visualElementStore } from "motion/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import type { Ticket } from "@/lib/api/client";
import { TestReads } from "@/lib/workspace-reads/testing";
import { frames } from "@/test/motion-clock";
import { motionTestbed } from "@/test/motion-testbed";
import { TicketListPane } from "./TicketListPane";
import { useBulkEdit } from "./useBulkEdit";
import type { TicketWorkspace } from "./useTicketWorkspace";

// The list pane wires the list's cascade to what the workspace is doing
// (DESIGN.md section 12): rows replace placeholders that were shown, or the
// Board, and nothing else. The workspace here is a stand-in with only what the
// pane reads, so the test decides when a read starts and ends.

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

motionTestbed();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  bridge.invoke.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  bridge.invoke.mockReset();
});

const ticket = (n: number): Ticket => ({
  id: String(n),
  trashed: false,
  reference: `T-KQ${n}`,
  title: `Ticket ${n}`,
  status: "Todo",
  body: "",
  tags: [],
  project_id: null,
  plan_id: null,
  availability: "Ready",
  parent: null,
  children: [],
  duplicate_of: null,
  duplicates: [],
  prerequisites: [],
});

type State = {
  loading: boolean;
  layout: "list" | "board";
  tickets: Ticket[];
  tags?: string;
};

function workspaceOf({ loading, layout, tickets, tags = "" }: State) {
  const counts = {
    total: tickets.length,
    todo: tickets.length,
    in_progress: 0,
    in_review: 0,
    done: 0,
    canceled: 0,
    duplicate: 0,
  };
  return {
    layout,
    board: { columns: [] },
    projects: [],
    plans: [],
    filter: "all",
    query: "",
    setQuery: vi.fn(),
    pages: 1,
    resetPaging: vi.fn(),
    showMore: vi.fn(),
    matchingTickets: vi.fn(async () => []),
    plan: "",
    status: "",
    tags,
    availability: "",
    family: "",
    source: "all",
    setSource: vi.fn(),
    sourceCounts: { all: 0, local: 0, providers: {} },
    configuredSources: [],
    sourceRefresh: {},
    trash: false,
    tickets,
    counts,
    scopeTotal: tickets.length,
    total: tickets.length,
    grouped: false,
    selected: null,
    loading,
    refresh: vi.fn(),
    scopeName: "All tickets",
    navigation: { kind: "all", project: "all", plan: "" },
    clearFilters: vi.fn(),
    queryError: false,
    listFailure: null,
    refreshFailed: false,
    setError: vi.fn(),
    setTags: vi.fn(),
    setPlan: vi.fn(),
    setStatus: vi.fn(),
    setAvailability: vi.fn(),
    setFamily: vi.fn(),
  } as unknown as TicketWorkspace;
}

const listRef = createRef<HTMLElement>();
function Pane(state: State) {
  const bulk = useBulkEdit(vi.fn());
  return (
    <MotionProvider>
      <TestReads>
        <TicketListPane
          workspace={workspaceOf(state)}
          bulk={bulk}
          listRef={listRef}
          planState={{ pending: false, apply: vi.fn() } as never}
          onOpen={vi.fn()}
          onCreate={vi.fn()}
        />
      </TestReads>
    </MotionProvider>
  );
}

const rows = [ticket(1), ticket(2), ticket(3)];
const rowOf = (title: string) => screen.getByText(title).closest("li")!;
const placeholders = () =>
  document.querySelectorAll('[aria-label="Loading tickets"] li');

test("rows that replace placeholders that were shown fade up", () => {
  const { rerender } = render(<Pane loading layout="list" tickets={[]} />);
  expect(placeholders().length).toBeGreaterThan(0);
  // Past the 300ms loading delay the placeholders are on screen.
  act(() => vi.advanceTimersByTime(300));
  rerender(<Pane loading={false} layout="list" tickets={rows} />);
  expect(rowOf("Ticket 3").style.opacity).toBe("0");
  expect(rowOf("Ticket 3").style.transform).toContain("translateY(6px)");
  expect(placeholders()).toHaveLength(0);
});

test("rows from a read that ended inside the delay just appear: nothing was shown to replace", () => {
  const { rerender } = render(<Pane loading layout="list" tickets={[]} />);
  act(() => vi.advanceTimersByTime(200));
  rerender(<Pane loading={false} layout="list" tickets={rows} />);
  expect(rowOf("Ticket 3").style.opacity).toBe("1");
});

test("the placeholders themselves fade up from their delay, even when the pane mounts them", () => {
  render(<Pane loading layout="list" tickets={[]} />);
  const [first] = placeholders();
  expect((first as HTMLElement).style.opacity).toBe("0");
  expect((first as HTMLElement).style.filter).toBe("blur(4px)");
});

test("a list on screen from the start has no cascade", () => {
  render(<Pane loading={false} layout="list" tickets={rows} />);
  expect(rowOf("Ticket 2").style.opacity).toBe("1");
});

test("the scrolling list is a layoutScroll host, so rows glide from where they were on screen", () => {
  render(<Pane loading={false} layout="list" tickets={rows} />);
  const host = document.querySelector(".ticket-scroll");
  expect(host).not.toBeNull();
  expect(
    visualElementStore.get(host as HTMLElement)?.projection?.options
      .layoutScroll,
  ).toBe(true);
});

// The chip row under the header opens and closes with Expand.

const chipRow = () =>
  document.querySelector<HTMLElement>('.ticket-list > [data-slot="expand"]');

test("the filter chip row is closed with no filter, and opens when one applies", async () => {
  const { rerender } = render(
    <Pane loading={false} layout="list" tickets={rows} />,
  );
  expect(chipRow()?.getAttribute("data-open")).toBe("false");
  expect(screen.queryByLabelText("Active filters")).toBeNull();
  rerender(<Pane loading={false} layout="list" tickets={rows} tags="api" />);
  expect(screen.getByLabelText("Active filters").textContent).toContain("api");
  await frames();
  expect(chipRow()?.getAttribute("data-open")).toBe("true");
});

// Applying a filter re-renders the whole list in the same task. A transition
// starts on the clock of the frame it was first drawn in, and that frame is
// late by however long the task took, so a row that opens in the same commit
// is already most of the way open when first seen (a 44px jump). The row
// mounts closed and opens a frame after the list has drawn.
test("the filter chip row mounts closed with its chips, and opens a frame later", async () => {
  const { rerender } = render(
    <Pane loading={false} layout="list" tickets={rows} />,
  );
  rerender(<Pane loading={false} layout="list" tickets={rows} tags="api" />);
  expect(chipRow()?.getAttribute("data-open")).toBe("false");
  expect(chipRow()?.querySelector(".filter-chips")).not.toBeNull();
  await frames();
  expect(chipRow()?.getAttribute("data-open")).toBe("true");
});

test("a pane that mounts with a filter already on shows the chip row open", () => {
  render(<Pane loading={false} layout="list" tickets={rows} tags="api" />);
  expect(chipRow()?.getAttribute("data-open")).toBe("true");
});

test("clearing the last filter closes the row while it still shows what it had, then removes it", () => {
  const { rerender } = render(
    <Pane loading={false} layout="list" tickets={rows} tags="api" />,
  );
  rerender(<Pane loading={false} layout="list" tickets={rows} />);
  expect(chipRow()?.getAttribute("data-open")).toBe("false");
  // Closing, not gone: the chips fade as the row's height closes.
  expect(chipRow()?.textContent).toContain("api");
  expect(chipRow()?.hasAttribute("inert")).toBe(true);
  expect(
    chipRow()?.querySelector(".filter-chips")?.getAttribute("aria-hidden"),
  ).toBe("true");
  expect(screen.queryByLabelText("Active filters")).toBeNull();
  act(() => vi.advanceTimersByTime(2000));
  expect(chipRow()?.textContent).toBe("");
});

test("filters changing while the row is open do not close it", () => {
  const { rerender } = render(
    <Pane loading={false} layout="list" tickets={rows} tags="api" />,
  );
  rerender(
    <Pane loading={false} layout="list" tickets={rows} tags="api, ui" />,
  );
  expect(chipRow()?.getAttribute("data-open")).toBe("true");
  expect(screen.getByLabelText("Active filters").textContent).toContain("ui");
});
