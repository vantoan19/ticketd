// @vitest-environment jsdom
import { useRef, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import {
  applyTokens,
  instantTokens,
  reducedTokens,
  rootTokens,
} from "@/test/motion-tokens";
import { MotionProvider, Presence } from "@/components/ui/motion";
import { freezeMotionClock } from "@/test/motion-clock";
import { FlightCard, MoveWatch, type Flight } from "./board-motion";

// Cards that change column fly (DESIGN.md section 6, Board). The watcher sees
// the board before and after a commit, so these tests render a plain board and
// give every element a place by its column.

// Statuses whose cards have scrolled out of their column's body.
const scrolledAway = new Set<string>();
let restoreTokens: () => void;
let clock: ReturnType<typeof freezeMotionClock>;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
  clock = freezeMotionClock();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const column = this.closest("[data-board-status]");
      const status = column?.getAttribute("data-board-status") ?? "";
      const left = column ? Number(status) * 300 : 0;
      // A column's body is 100px tall; its cards sit inside it, or far below.
      if (this.classList.contains("board-column-body"))
        return new DOMRect(left, 0, 280, 100);
      return new DOMRect(left, scrolledAway.has(status) ? 500 : 20, 240, 80);
    },
  );
});
afterEach(() => {
  cleanup();
  scrolledAway.clear();
  clock.restore();
  restoreTokens();
  vi.restoreAllMocks();
});

const ticket = (n: number): Ticket =>
  ({ id: String(n), reference: `T-${n}` }) as Ticket;
type Columns = { status: string; tickets: Ticket[] }[];
// Statuses are numbers here, so a column's left edge is status * 300.
const columns = (...tickets: number[][]): Columns =>
  tickets.map((ids, status) => ({
    status: String(status),
    tickets: ids.map(ticket),
  }));

function Board({
  columns: shown,
  holding = false,
  preview,
  folded = [],
  onFlights,
  onEntering = () => {},
}: {
  columns: Columns;
  holding?: boolean;
  /** Statuses whose cards are not rendered, like a folded column. */
  folded?: string[];
  preview?: { reference: string; left: number; top: number };
  onFlights: (flights: readonly Flight[]) => void;
  onEntering?: (references: readonly string[]) => void;
}) {
  const board = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={board}>
        {shown.map((column) => (
          <section key={column.status} data-board-status={column.status}>
            <div className="board-column-body">
              {!folded.includes(column.status) &&
                column.tickets.map((item) => (
                  <div key={item.id} data-ticket-reference={item.reference} />
                ))}
            </div>
          </section>
        ))}
      </div>
      {preview && (
        <div
          data-board-drag-preview=""
          data-board-drag-reference={preview.reference}
          style={{ left: preview.left, top: preview.top }}
        />
      )}
      <MoveWatch
        columns={shown}
        holding={holding}
        board={board}
        onFlights={onFlights}
        onEntering={onEntering}
      />
    </>
  );
}

function setup(
  first: Columns,
  shown: Partial<Parameters<typeof Board>[0]> = {},
) {
  const onFlights = vi.fn();
  const onEntering = vi.fn();
  const view = render(
    <Board
      columns={first}
      onFlights={onFlights}
      onEntering={onEntering}
      {...shown}
    />,
  );
  return {
    onFlights,
    onEntering,
    update: (props: Partial<Parameters<typeof Board>[0]>) =>
      act(() => {
        view.rerender(
          <Board
            columns={first}
            onFlights={onFlights}
            onEntering={onEntering}
            {...shown}
            {...props}
          />,
        );
      }),
  };
}

it("a card that changes column flies from where it was to where it landed", () => {
  const { onFlights, update } = setup(columns([1, 2], [3]));
  update({ columns: columns([2], [3, 1]) });
  expect(onFlights).toHaveBeenCalledTimes(1);
  expect(onFlights.mock.calls[0]?.[0]).toEqual([
    expect.objectContaining({
      reference: "T-1",
      kind: "live",
      from: { left: 0, top: 20 },
      to: { left: 300, top: 20, width: 240 },
    }),
  ]);
});

it("nothing flies when no card changes column", () => {
  const { onFlights, update } = setup(columns([1, 2], [3]));
  update({ columns: columns([2, 1], [3]) });
  expect(onFlights).not.toHaveBeenCalled();
});

it("a card that arrives from nowhere does not fly: it enters in place", () => {
  const { onFlights, update } = setup(columns([1], [3]));
  update({ columns: columns([1, 9], [3]) });
  expect(onFlights).not.toHaveBeenCalled();
});

it("a card moved into a folded column, which shows no cards, just appears", () => {
  const { onFlights, update } = setup(columns([1], [3]));
  update({ columns: columns([], [3, 1]), folded: ["1"] });
  expect(onFlights).not.toHaveBeenCalled();
});

it("a card let go over a column that refuses it settles back from where it was let go", () => {
  const { onFlights, update } = setup(columns([1, 2], [3]));
  update({
    holding: true,
    preview: { reference: "T-1", left: 410, top: 55 },
  });
  expect(onFlights).not.toHaveBeenCalled();
  // Let go: the copy leaves in the same commit that ends the hold.
  update({ holding: false });
  expect(onFlights).toHaveBeenCalledTimes(1);
  expect(onFlights.mock.calls[0]?.[0]).toEqual([
    expect.objectContaining({
      reference: "T-1",
      kind: "drop",
      from: { left: 410, top: 55 },
      to: { left: 0, top: 20, width: 240 },
    }),
  ]);
});

it("a card already in the air starts its next flight from where it is", () => {
  const { onFlights, update } = setup(columns([1], [3]));
  const flying = document.createElement("div");
  flying.setAttribute("data-board-flight", "T-1");
  flying.getBoundingClientRect = () => new DOMRect(123, 45, 240, 80);
  document.body.append(flying);
  update({ columns: columns([], [3, 1]) });
  flying.remove();
  expect(onFlights.mock.calls[0]?.[0]).toEqual([
    expect.objectContaining({ from: { left: 123, top: 45 } }),
  ]);
});

it("reduced motion and a held key make every move instant", () => {
  for (const tokens of [reducedTokens, instantTokens]) {
    cleanup();
    restoreTokens();
    restoreTokens = applyTokens({ ...rootTokens, ...tokens });
    const { onFlights, update } = setup(columns([1], [3]));
    update({ columns: columns([], [3, 1]) });
    expect(onFlights).not.toHaveBeenCalled();
  }
});

it("a render that changes neither the columns nor the hold reads no tokens", () => {
  const { update } = setup(columns([1, 2], [3]));
  const reads = vi.spyOn(window, "getComputedStyle");
  update({}); // a pointer move re-renders the board with the same columns
  expect(reads).not.toHaveBeenCalled();
});

it("motion tokens are read again for every move, so a held key stops the next flight", () => {
  const { onFlights, update } = setup(columns([1, 2], [3]));
  update({ columns: columns([2], [3, 1]) });
  expect(onFlights).toHaveBeenCalledTimes(1);
  const restoreInstant = applyTokens(instantTokens);
  update({ columns: columns([1, 2], [3]) });
  restoreInstant();
  expect(onFlights).toHaveBeenCalledTimes(1);
});

it("a card that lands in view from out of sight has nothing to fly from: it enters", () => {
  const { onFlights, onEntering, update } = setup(columns([1, 2], [3]));
  scrolledAway.add("0");
  update({ columns: columns([2], [3, 1]) });
  expect(onFlights).not.toHaveBeenCalled();
  expect(onEntering).toHaveBeenLastCalledWith(["T-1"]);
});

it("a card that lands in view from a folded column, which shows no cards, enters", () => {
  const { onFlights, onEntering, update } = setup(columns([1], [3]), {
    folded: ["0"],
  });
  update({ columns: columns([], [3, 1]), folded: [] });
  expect(onFlights).not.toHaveBeenCalled();
  expect(onEntering).toHaveBeenLastCalledWith(["T-1"]);
});

it("a card that lands out of sight, or flies, does not enter; the next change ends the news", () => {
  const { onEntering, update } = setup(columns([1, 2], [3]));
  update({ columns: columns([2], [3, 1]) }); // flies: visible to visible
  expect(onEntering).toHaveBeenLastCalledWith([]);
  scrolledAway.add("1");
  update({ columns: columns([2], [3]), folded: ["1"] }); // lands out of sight
  expect(onEntering).toHaveBeenLastCalledWith([]);
});

it("a render that changes nothing reports nothing", () => {
  const { onEntering, update } = setup(columns([1, 2], [3]));
  onEntering.mockClear();
  update({}); // a pointer move re-renders the board with the same columns
  expect(onEntering).not.toHaveBeenCalled();
});

// A flight is mounted well after the board, which the pane's Presence (with
// initial={false}) holds from its first render.
function Pane({ flights }: { flights: readonly Flight[] }) {
  return (
    <MotionProvider>
      <Presence initial={false}>
        <Air key="board" flights={flights} />
      </Presence>
    </MotionProvider>
  );
}
function Air({ flights }: { flights: readonly Flight[] }): ReactNode {
  return flights.map((flight) => (
    <FlightCard key={flight.serial} flight={flight} onLand={() => {}}>
      <p>Card</p>
    </FlightCard>
  ));
}
const flightOf = (kind: Flight["kind"]): Flight => ({
  reference: "T-1",
  kind,
  from: { left: 0, top: 20 },
  to: { left: 300, top: 20, width: 240 },
  serial: 1,
});

it("a flight under a Presence that skipped its first entrance still travels from the old slot", async () => {
  const view = render(<Pane flights={[]} />);
  view.rerender(<Pane flights={[flightOf("live")]} />);
  const flight = document.querySelector<HTMLElement>("[data-board-flight]")!;
  expect(flight.style.transform).toContain("translateX(-300px)");
  await clock.advance(100);
  const midway = flight.style.transform;
  expect(midway).toMatch(/translateX\(-\d/);
  expect(midway).not.toContain("-300px");
  await clock.advance(2000);
  expect(flight.style.transform).toMatch(/^(none)?$/);
});

it("a drop starts at the lift scale and settles to 1", async () => {
  const view = render(<Pane flights={[]} />);
  view.rerender(<Pane flights={[flightOf("drop")]} />);
  const flight = document.querySelector<HTMLElement>("[data-board-flight]")!;
  expect(flight.style.transform).toContain("scale(1.02)");
  await clock.advance(2000);
  expect(flight.style.transform).toMatch(/^(none)?$/);
});
