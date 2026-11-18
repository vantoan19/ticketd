// @vitest-environment jsdom
import { createRef, useEffect, useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import { TestReads } from "@/lib/workspace-reads/testing";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
import { TicketListPane } from "./TicketListPane";
import { useBulkEdit } from "./useBulkEdit";
import type { TicketWorkspace } from "./useTicketWorkspace";

// What the pane asks of the list (DESIGN.md section 12): a cascade when it
// replaces the Board, or placeholders that were shown, handed back as soon as
// the list has taken it. The list and the Board are stand-ins here; their own
// tests say what they do with it.

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("./TicketBoard", () => ({
  TicketBoard: () => <div data-testid="board" />,
}));
const asked = vi.hoisted(() => ({ cascade: [] as boolean[] }));
vi.mock("./TicketList", () => ({
  TicketList: ({
    cascade,
    onCascaded,
  }: {
    cascade: boolean;
    onCascaded: () => void;
  }) => {
    // Recorded as the list mounts, which is when it reads the flag.
    useState(() => asked.cascade.push(cascade));
    useEffect(() => {
      if (cascade) onCascaded();
    }, [cascade, onCascaded]);
    return <ul className="ticket-rows" />;
  },
}));

let restoreTokens: () => void;
beforeEach(() => {
  asked.cascade.length = 0;
  restoreTokens = applyTokens(rootTokens);
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
  restoreTokens();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  bridge.invoke.mockReset();
});

type State = { loading: boolean; layout: "list" | "board"; count: number };
function workspaceOf({ loading, layout, count }: State) {
  const tickets = Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    reference: `T-KQ${i + 1}`,
    title: `Ticket ${i + 1}`,
    status: "Todo",
    tags: [],
  }));
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
    matchingReferences: vi.fn(async () => []),
    plan: "",
    status: "",
    tags: "",
    availability: "",
    family: "",
    source: "all",
    setSource: vi.fn(),
    sourceCounts: { all: 0, local: 0, providers: {} },
    configuredSources: [],
    sourceRefresh: {},
    trash: false,
    tickets,
    counts: { total: count, todo: count },
    scopeTotal: count,
    total: count,
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

test("a list on screen from the start asks for no cascade", () => {
  render(<Pane loading={false} layout="list" count={3} />);
  expect(asked.cascade).toEqual([false]);
});

test("rows that replace placeholders that were shown ask for one, once", () => {
  const { rerender } = render(<Pane loading layout="list" count={0} />);
  act(() => vi.advanceTimersByTime(300));
  rerender(<Pane loading={false} layout="list" count={3} />);
  expect(asked.cascade).toEqual([true]);
  // Handed back: the list does not see it again on a later render.
  rerender(<Pane loading={false} layout="list" count={4} />);
  expect(asked.cascade).toEqual([true]);
});

test("rows from a read that ended inside the loading delay ask for none", () => {
  const { rerender } = render(<Pane loading layout="list" count={0} />);
  act(() => vi.advanceTimersByTime(299));
  rerender(<Pane loading={false} layout="list" count={3} />);
  expect(asked.cascade).toEqual([false]);
});

test("back from the Board the list asks for one, and only back from it", async () => {
  const { rerender, queryByTestId } = render(
    <Pane loading={false} layout="board" count={3} />,
  );
  expect(queryByTestId("board")).not.toBeNull();
  expect(asked.cascade).toEqual([]);
  rerender(<Pane loading={false} layout="list" count={3} />);
  // The Board leaves, then the list mounts with the request.
  await act(async () => {
    await vi.waitFor(() => expect(queryByTestId("board")).toBeNull());
  });
  expect(asked.cascade).toEqual([true]);
  // Going to the Board asks the list for nothing.
  rerender(<Pane loading={false} layout="board" count={3} />);
  expect(asked.cascade).toEqual([true]);
});
