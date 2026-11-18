import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client, type FindFilter, type Ticket } from "@/lib/api/client";
import { failureText } from "@/lib/api/describe-failure";
import { ticketStatuses, type TicketStatus } from "@/lib/statuses";

const BATCH_SIZE = 50;
type Column = {
  status: TicketStatus;
  tickets: Ticket[];
  total: number | null;
  loading: boolean;
  error: string;
};
const noFresh: ReadonlySet<string> = new Set();
const emptyColumns = (): Column[] =>
  ticketStatuses.map((status) => ({
    status,
    tickets: [],
    total: null,
    loading: true,
    error: "",
  }));

type Shown = { key: string; ids: Set<string>; settled: boolean };
/**
 * Notes every ticket the board shows. Once the board has settled, a ticket it
 * had not shown before has arrived (a live update, not a move or a page).
 */
function remember(shown: Shown, columns: Column[], arrive: boolean) {
  const arrived = new Set<string>();
  for (const column of columns)
    for (const { id } of column.tickets) {
      if (arrive && shown.settled && !shown.ids.has(id)) arrived.add(id);
      shown.ids.add(id);
    }
  return arrived;
}

/**
 * A reference is a device code and that device's own counter ("T-CJ42" is
 * counter 42 of device "T-CJ"). The core orders by the local row number, which
 * the reference does not carry, so only counters of one device compare.
 */
function partsOf(reference: string) {
  const match = /^(.*?)(\d+)$/.exec(reference);
  return { device: match?.[1] ?? reference, counter: Number(match?.[2] ?? 0) };
}

/**
 * Where a ticket sits in a column the core lists newest first, among the
 * tickets loaded so far. Newer tickets of the same device come first, so it
 * goes before the first older one of its device, or after the last one of its
 * device. With none of its device in the column the order is unknown: it leads.
 */
function slotOf(column: readonly Ticket[], ticket: Ticket) {
  const own = partsOf(ticket.reference);
  const kin = column.map((item) => partsOf(item.reference));
  const older = kin.findIndex(
    (item) => item.device === own.device && item.counter < own.counter,
  );
  if (older >= 0) return older;
  return kin.map((item) => item.device).lastIndexOf(own.device) + 1;
}

/** Independent bounded reads; core owns matching and ordering, desktop owns pages. */
export function useTicketBoard(
  filter: FindFilter,
  active: boolean,
  refreshTick: number,
) {
  // List pagination is deliberately absent: a column has its own loaded extent.
  const key = JSON.stringify({ ...filter, offset: 0, limit: BATCH_SIZE });
  const requestFilter = useMemo<FindFilter>(
    () => JSON.parse(key) as FindFilter,
    [key],
  );
  const [state, setState] = useState({
    key,
    columns: emptyColumns(),
    fresh: noFresh,
  });
  const displayed = state.key === key ? state.columns : emptyColumns();
  const saved = useRef(state);
  const shown = useRef<Shown>({ key, ids: new Set(), settled: false });
  const generation = useRef(0);
  const loadingMore = useRef(new Set<TicketStatus>());

  const read = useCallback(
    async (status: TicketStatus, limit: number) => {
      // Intersect, rather than replace, an explicit status constraint.
      if (requestFilter.status && requestFilter.status !== status)
        return { tickets: [], total: 0 };
      const args = { ...requestFilter, status, limit, offset: 0 };
      let timeout = 0;
      try {
        const [tickets, counts] = await Promise.race([
          Promise.all([
            (async () => {
              const tickets: Ticket[] = [];
              // The core caps search pages at 100. Keep every request at our 50-card batch.
              for (let offset = 0; offset < limit; offset += BATCH_SIZE) {
                const page = await client.findTickets({
                  ...args,
                  limit: BATCH_SIZE,
                  offset,
                });
                tickets.push(...page);
                if (page.length < BATCH_SIZE) break;
              }
              return tickets;
            })(),
            client.countTickets(args),
          ]),
          new Promise<never>((_, reject) => {
            timeout = window.setTimeout(
              () => reject(new Error("Read timed out")),
              5000,
            );
          }),
        ]);
        return {
          tickets: [
            ...new Map(tickets.map((ticket) => [ticket.id, ticket])).values(),
          ],
          total: counts.total,
        };
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [requestFilter],
  );

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    loadingMore.current.clear();
    if (shown.current.key !== key)
      shown.current = { key, ids: new Set(), settled: false };
    const previous =
      saved.current.key === key ? saved.current.columns : emptyColumns();
    const commit = (columns: Column[], fresh = saved.current.fresh) => {
      const next = { key, columns, fresh };
      saved.current = next;
      setState(next);
    };
    commit(
      previous.map((column) => ({ ...column, loading: true, error: "" })),
      noFresh,
    );
    await Promise.all(
      previous.map(async (column) => {
        try {
          const result = await read(
            column.status,
            Math.max(BATCH_SIZE, column.tickets.length),
          );
          if (request !== generation.current) return;
          const columns = saved.current.columns.map((current) =>
            current.status === column.status
              ? { ...current, ...result, loading: false, error: "" }
              : current,
          );
          commit(
            columns,
            new Set([
              ...saved.current.fresh,
              ...remember(shown.current, columns, true),
            ]),
          );
        } catch (reason) {
          if (request !== generation.current) return;
          commit(
            saved.current.columns.map((current) =>
              current.status === column.status
                ? {
                    ...current,
                    loading: false,
                    error: failureText(reason, `load ${column.status} tickets`),
                  }
                : current,
            ),
          );
        }
      }),
    );
    if (request === generation.current) shown.current.settled = true;
  }, [key, read]);

  useEffect(() => {
    if (active) void refresh();
    const current = generation;
    return () => {
      current.current++;
    };
  }, [active, refresh, refreshTick]);

  async function loadMore(status: TicketStatus) {
    if (loadingMore.current.has(status)) return;
    const column = saved.current.columns.find((item) => item.status === status);
    if (
      !active ||
      saved.current.key !== key ||
      !column ||
      column.loading ||
      column.total === null ||
      column.tickets.length >= column.total
    )
      return;
    const request = generation.current;
    loadingMore.current.add(status);
    const commit = (patch: Partial<Column>) => {
      const columns = saved.current.columns.map((item) =>
        item.status === status ? { ...item, ...patch } : item,
      );
      // A page the person asked for lands where the button was; it is not news.
      remember(shown.current, columns, false);
      const next = { key, columns, fresh: noFresh };
      saved.current = next;
      setState(next);
    };
    commit({ loading: true, error: "" });
    try {
      // Re-read the bounded prefix so concurrent insertions cannot duplicate or skip a card.
      const result = await read(status, column.tickets.length + BATCH_SIZE);
      if (request === generation.current) commit({ ...result, loading: false });
    } catch (reason) {
      if (request === generation.current)
        commit({
          loading: false,
          error: failureText(reason, `load more ${status} tickets`),
        });
    } finally {
      if (request === generation.current) loadingMore.current.delete(status);
    }
  }
  async function matches(ticket: Ticket): Promise<boolean> {
    if (requestFilter.status && requestFilter.status !== ticket.status)
      return false;
    // Ask the core with the same filters. A newly moved card can be beyond the loaded prefix.
    for (let offset = 0; ; offset += BATCH_SIZE) {
      const page = await client.findTickets({
        ...requestFilter,
        status: ticket.status,
        offset,
        limit: BATCH_SIZE,
      });
      if (page.some((item) => item.reference === ticket.reference)) return true;
      if (page.length < BATCH_SIZE) return false;
    }
  }
  function confirmTicket(ticket: Ticket) {
    generation.current++;
    if (saved.current.key !== key) return;
    // A failed column read must not keep a ticket whose saved status is now known elsewhere.
    const columns = saved.current.columns.map((column) => {
      const contained = column.tickets.some((item) => item.id === ticket.id);
      if (!contained) return column;
      const remains = !ticket.trashed && column.status === ticket.status;
      return {
        ...column,
        tickets: column.tickets.flatMap((item) =>
          item.id !== ticket.id ? [item] : remains ? [ticket] : [],
        ),
        total:
          remains || column.total === null
            ? column.total
            : Math.max(0, column.total - 1),
      };
    });
    saved.current = { key, columns, fresh: noFresh };
    setState(saved.current);
  }
  /**
   * Shows a status change at once (P10): the card leaves its column and takes
   * its slot in the target column's order, where the core will put it, so the
   * card never moves when the core confirms. `at` puts it at a given place
   * instead, back where it was after a failure. Returns where it was.
   */
  function placeTicket(
    ticket: Ticket,
    at?: number,
  ): { status: string; index: number } {
    let from = { status: "", index: -1 };
    if (saved.current.key !== key) return from;
    generation.current++;
    const columns = saved.current.columns.map((column) => {
      const index = column.tickets.findIndex((item) => item.id === ticket.id);
      if (column.status === ticket.status)
        return {
          ...column,
          tickets: (() => {
            const rest = column.tickets.filter((item) => item.id !== ticket.id);
            const slot = at ?? slotOf(rest, ticket);
            return [...rest.slice(0, slot), ticket, ...rest.slice(slot)];
          })(),
          total:
            index >= 0 || column.total === null
              ? column.total
              : column.total + 1,
        };
      if (index < 0) return column;
      from = { status: column.status, index };
      return {
        ...column,
        tickets: column.tickets.filter((item) => item.id !== ticket.id),
        total: column.total === null ? null : Math.max(0, column.total - 1),
      };
    });
    saved.current = { key, columns, fresh: noFresh };
    setState(saved.current);
    return from;
  }
  return {
    columns: displayed,
    /** Ids of tickets the last refresh added to a board already showing. */
    fresh: state.key === key ? state.fresh : noFresh,
    refresh,
    loadMore,
    matches,
    confirmTicket,
    placeTicket,
    key,
  };
}
