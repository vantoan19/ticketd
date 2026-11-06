import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client, type FindFilter, type Ticket } from "@/lib/api/client";
import { ticketStatuses, type TicketStatus } from "@/lib/statuses";

const BATCH_SIZE = 50;
type Column = {
  status: TicketStatus;
  tickets: Ticket[];
  total: number | null;
  loading: boolean;
  error: string;
};
const emptyColumns = (): Column[] =>
  ticketStatuses.map((status) => ({
    status,
    tickets: [],
    total: null,
    loading: true,
    error: "",
  }));

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
  const [state, setState] = useState({ key, columns: emptyColumns() });
  const displayed = state.key === key ? state.columns : emptyColumns();
  const saved = useRef(state);
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
    const previous =
      saved.current.key === key ? saved.current.columns : emptyColumns();
    const commit = (columns: Column[]) => {
      const next = { key, columns };
      saved.current = next;
      setState(next);
    };
    commit(previous.map((column) => ({ ...column, loading: true, error: "" })));
    await Promise.all(
      previous.map(async (column) => {
        try {
          const result = await read(
            column.status,
            Math.max(BATCH_SIZE, column.tickets.length),
          );
          if (request !== generation.current) return;
          commit(
            saved.current.columns.map((current) =>
              current.status === column.status
                ? { ...current, ...result, loading: false, error: "" }
                : current,
            ),
          );
        } catch (reason) {
          if (request !== generation.current) return;
          commit(
            saved.current.columns.map((current) =>
              current.status === column.status
                ? { ...current, loading: false, error: String(reason) }
                : current,
            ),
          );
        }
      }),
    );
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
      const next = {
        key,
        columns: saved.current.columns.map((item) =>
          item.status === status ? { ...item, ...patch } : item,
        ),
      };
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
        commit({ loading: false, error: String(reason) });
    } finally {
      if (request === generation.current) loadingMore.current.delete(status);
    }
  }
  return { columns: displayed, refresh, loadMore };
}
