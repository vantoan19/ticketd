// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import {
  applyTokens,
  instantTokens,
  reducedTokens,
  rootTokens,
} from "@/test/motion-tokens";
import { MoveWatch, type Flight } from "./board-motion";

// Cards that change column fly (DESIGN.md section 6, Board). The watcher sees
// the board before and after a commit, so these tests render a plain board and
// give every element a place by its column.

let restoreTokens: () => void;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const column = this.closest("[data-board-status]");
      const left = column
        ? Number(column.getAttribute("data-board-status")) * 300
        : 0;
      return new DOMRect(left, 20, 240, 80);
    },
  );
});
afterEach(() => {
  cleanup();
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
}: {
  columns: Columns;
  holding?: boolean;
  /** Statuses whose cards are not rendered, like a folded column. */
  folded?: string[];
  preview?: { reference: string; left: number; top: number };
  onFlights: (flights: readonly Flight[]) => void;
}) {
  const board = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={board}>
        {shown.map((column) => (
          <section key={column.status} data-board-status={column.status}>
            {!folded.includes(column.status) &&
              column.tickets.map((item) => (
                <div key={item.id} data-ticket-reference={item.reference} />
              ))}
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
      />
    </>
  );
}

function setup(first: Columns) {
  const onFlights = vi.fn();
  const view = render(<Board columns={first} onFlights={onFlights} />);
  return {
    onFlights,
    update: (props: Partial<Parameters<typeof Board>[0]>) =>
      act(() => {
        view.rerender(
          <Board columns={first} onFlights={onFlights} {...props} />,
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
