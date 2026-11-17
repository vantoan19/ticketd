import { Component, useEffect, type ReactNode, type RefObject } from "react";
import { m } from "motion/react";
import type { Ticket } from "@/lib/api/client";
import { spring } from "@/lib/motion-tokens";

// Cards that change column (DESIGN.md section 6, Board; section 12, Motion).
// A card is rendered inside its column, so it cannot glide to another one:
// React unmounts it there and mounts it here, and a column's body clips what
// leaves it. So the move is drawn by a copy that flies above the board, from
// where the card was to where it landed, while the real card waits unseen in
// its new place. Cards around it glide with the layout (TicketBoard).

type Columns = readonly { status: string; tickets: readonly Ticket[] }[];
type Corner = { left: number; top: number };

/** One card's flight above the board. */
export type Flight = {
  reference: string;
  /** A drop settles from the lift; a move another hand made lifts on the way. */
  kind: "drop" | "live";
  from: Corner;
  to: Corner & { width: number };
  /** A new flight of the same card restarts the animation. */
  serial: number;
};

/** The statuses of the tickets in these columns, by reference. */
function placed(columns: Columns): Map<string, string> {
  return new Map(
    columns.flatMap((column) =>
      column.tickets.map(
        (ticket) => [ticket.reference, column.status] as const,
      ),
    ),
  );
}

/** Whether most of the box shows inside the column body that holds it. */
function shows(element: Element): boolean {
  const body = element.closest(".board-column-body")?.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  return (
    !body ||
    (box.bottom > body.top &&
      box.top < body.bottom &&
      box.right > body.left &&
      box.left < body.right)
  );
}

type Snapshot = Map<string, { from: Corner; kind: Flight["kind"] }>;

/**
 * Watches the columns for cards that change column and, in the same commit,
 * reports where each one was and where it is. It renders nothing. It is a class
 * because only `getSnapshotBeforeUpdate` sees the board as it was, before React
 * changes it; a card's old place is gone by the time any effect runs.
 *
 * A flight needs a place to start and a place to land that both show; with
 * neither motion (reduced, or a held key) there is no flight at all.
 */
export class MoveWatch extends Component<{
  columns: Columns;
  /** A card is being dragged; its copy follows the pointer. */
  holding: boolean;
  board: RefObject<HTMLElement | null>;
  onFlights: (flights: readonly Flight[]) => void;
}> {
  private serial = 0;

  getSnapshotBeforeUpdate(previous: {
    columns: Columns;
    holding: boolean;
  }): Snapshot | null {
    const board = this.props.board.current;
    if (!board || spring("travel").duration === 0) return null;
    const preview = document.querySelector<HTMLElement>(
      "[data-board-drag-preview]",
    );
    const letGo = previous.holding && !this.props.holding ? preview : null;
    const before = placed(previous.columns);
    const after = placed(this.props.columns);
    const moved = [...before].filter(
      ([reference, status]) =>
        after.has(reference) && after.get(reference) !== status,
    );
    const references = new Set(moved.map(([reference]) => reference));
    const dropped = letGo?.dataset.boardDragReference;
    if (dropped) references.add(dropped);
    const snapshot: Snapshot = new Map();
    for (const reference of references) {
      if (reference === dropped && letGo) {
        snapshot.set(reference, {
          from: {
            left: Number.parseFloat(letGo.style.left),
            top: Number.parseFloat(letGo.style.top),
          },
          kind: "drop",
        });
        continue;
      }
      // A card already in the air starts again from where it is.
      const old =
        document.querySelector(`[data-board-flight="${reference}"]`) ??
        board.querySelector(`[data-ticket-reference="${reference}"]`);
      if (!old || !shows(old)) continue;
      const box = old.getBoundingClientRect();
      snapshot.set(reference, {
        from: { left: box.left, top: box.top },
        kind: "live",
      });
    }
    return snapshot.size ? snapshot : null;
  }

  componentDidUpdate(
    _previous: unknown,
    _state: unknown,
    snapshot: Snapshot | null,
  ) {
    const board = this.props.board.current;
    if (!board || !snapshot) return;
    const flights: Flight[] = [];
    for (const [reference, { from, kind }] of snapshot) {
      const card = board.querySelector(
        `[data-ticket-reference="${reference}"]`,
      );
      // A card that landed in a folded column, or out of sight, just appears.
      if (!card || !shows(card)) continue;
      const box = card.getBoundingClientRect();
      flights.push({
        reference,
        kind,
        from,
        to: { left: box.left, top: box.top, width: box.width },
        serial: ++this.serial,
      });
    }
    if (flights.length) this.props.onFlights(flights);
  }

  render() {
    return null;
  }
}

/**
 * The copy of a card in the air. It starts where the card was and settles on
 * the smooth spring (a drop) or the travel spring (a move). The caller takes it
 * away when `onLand` is called, which is when the spring has settled.
 */
export function FlightCard({
  flight,
  onLand,
  children,
}: {
  flight: Flight;
  onLand: (flight: Flight) => void;
  children: ReactNode;
}) {
  const { from, to, kind } = flight;
  const flightSpring = spring(kind === "drop" ? "smooth" : "travel");
  useEffect(() => {
    // Motion settles a frame or two after its duration.
    const timer = window.setTimeout(
      () => onLand(flight),
      flightSpring.duration * 1000 + 50,
    );
    return () => window.clearTimeout(timer);
  }, [flight, flightSpring.duration, onLand]);
  return (
    <m.div
      className="board-flight"
      data-board-flight={flight.reference}
      data-kind={kind}
      aria-hidden="true"
      inert
      style={{ left: to.left, top: to.top, width: to.width }}
      initial={{
        x: from.left - to.left,
        y: from.top - to.top,
        scale: kind === "drop" ? 1.02 : 1,
      }}
      animate={{ x: 0, y: 0, scale: 1, transition: flightSpring }}
    >
      {children}
    </m.div>
  );
}
