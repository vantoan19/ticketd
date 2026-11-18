import {
  createContext,
  useContext,
  useLayoutEffect,
  useReducer,
  useRef,
} from "react";
import type { Ticket } from "@/lib/api/client";
import type { FailureDescription } from "@/lib/api/describe-failure";
import { withCurrent, type Fill } from "@/lib/workspace-reads";
import type { ReturnedTickets } from "./changed";
import { usePart, type PartArgs, type PartName, type PartState } from "./parts";

export type OpenTicketState = {
  reference: string;
  record: Ticket;
  /** A saved copy is shown while the first read of the record is unanswered. */
  opening: boolean;
  /**
   * The record arrived after the page showed its skeleton, and the page is
   * still showing: its document fades up (DESIGN.md section 5). It ends when
   * the page is hidden, so showing the page again does not play it again.
   */
  fresh: boolean;
  /**
   * Whether the record is as current as the last change. It is read when asked
   * for, so a page that never asks does not re-render when it moves.
   */
  readonly current: boolean;
  /** The last failure to refresh the record, kept while the page shows it. */
  failure: FailureDescription | null;
  /** Reads the record again; resolves once a read made after it has answered. */
  retry(): Promise<void>;
  /**
   * Reports a write of this Ticket (or others) that succeeded: the Tickets it
   * returned, and the fills for what it set that no Ticket carries (see
   * `useTicketChanged`).
   */
  changed(returned?: ReturnedTickets, fills?: readonly Fill[]): Promise<void>;
};

/**
 * Whether the record is current, as the gate knows it (the gate holds the one
 * read of the record). Callers that ask subscribe through `subscribe`; the gate
 * calls `update` after each render with its latest answer.
 */
export type Currency = {
  read(): boolean;
  subscribe(listener: () => void): () => void;
  update(read: () => boolean): void;
};

export function createCurrency(read: () => boolean): Currency {
  let latest = read;
  const listeners = new Set<() => void>();
  return {
    read: () => latest(),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    update(next) {
      latest = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** What the gate provides; `current` is served from its `currency`. */
export type OpenTicketScope = Omit<OpenTicketState, "current"> & {
  currency: Currency;
};

export const OpenTicketContext = createContext<OpenTicketScope | null>(null);

/**
 * `current` for one caller of `useOpenTicket()`: a getter that says whether the
 * record is current and, from the first time it is read, re-renders the caller
 * when the answer changes. A caller that never reads it costs nothing: it holds
 * a listener that does nothing, and the gate's read (the only one of the
 * record) tracks `current` only once someone asked. It subscribes in a layout
 * effect, which runs before the gate's own (`update`) when both mount together.
 */
function useCurrent(currency: Currency): () => boolean {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  // The last answer given; null while this caller has not asked.
  const asked = useRef<boolean | null>(null);
  useLayoutEffect(
    () =>
      currency.subscribe(() => {
        if (asked.current !== null && asked.current !== currency.read())
          rerender();
      }),
    [currency],
  );
  return () => {
    asked.current = currency.read();
    return asked.current;
  };
}

/**
 * The open Ticket of the enclosing `<OpenTicket>`. `useOpenTicket(part,
 * ...args)` gives a section its data instead (linked work, evidence, ...).
 */
export function useOpenTicket(): OpenTicketState;
export function useOpenTicket<Name extends PartName>(
  part: Name,
  ...args: PartArgs<Name>
): PartState<Name>;
export function useOpenTicket<Name extends PartName>(
  part?: Name,
  ...args: PartArgs<Name>
): OpenTicketState | PartState<Name> | undefined {
  const open = useContext(OpenTicketContext);
  if (!open) throw new Error("useOpenTicket must be used inside <OpenTicket>.");
  const current = useCurrent(open.currency);
  const served = usePart(open.record, part, args);
  if (part !== undefined) return served;
  const { reference, record, opening, fresh, failure, retry, changed } = open;
  return withCurrent(
    { reference, record, opening, fresh, failure, retry, changed },
    current,
  );
}
