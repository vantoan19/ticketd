// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { FindFilter, Ticket } from "@/lib/api/client";
import { useTicketBoard } from "./useTicketBoard";

// A card the board has not shown before, arriving once it has settled, is
// fresh and enters; a card that moved, a page the person asked for, and the
// first read are not.

const read = vi.hoisted(() => ({ tickets: [] as Ticket[] }));
vi.mock("@/lib/api/client", () => ({
  client: {
    findTickets: async (filter: FindFilter) =>
      read.tickets.filter((item) => item.status === filter.status),
    countTickets: async (filter: FindFilter) => ({
      total: read.tickets.filter((item) => item.status === filter.status)
        .length,
    }),
  },
}));

const ticket = (n: number, status = "Todo"): Ticket =>
  ({ id: String(n), reference: `T-${n}`, status }) as Ticket;
const filter = { tags: [] } as unknown as FindFilter;

beforeEach(() => {
  read.tickets = [ticket(1), ticket(2, "In review")];
});

async function settled(view: { current: { columns: { loading: boolean }[] } }) {
  await waitFor(() =>
    expect(view.current.columns.every((c) => !c.loading)).toBe(true),
  );
}

it("the first read shows no card as news", async () => {
  const { result } = renderHook(() => useTicketBoard(filter, true, 0));
  await settled(result);
  expect(result.current.fresh.size).toBe(0);
});

it("a card added by a later refresh is fresh; a card that only moved is not", async () => {
  const { result, rerender } = renderHook(
    ({ tick }) => useTicketBoard(filter, true, tick),
    { initialProps: { tick: 0 } },
  );
  await settled(result);
  read.tickets = [ticket(1, "In review"), ticket(2, "In review"), ticket(3)];
  rerender({ tick: 1 });
  await waitFor(() => expect([...result.current.fresh]).toEqual(["3"]));
});

it("a drop or status choice ends the news, so a moved card never re-enters", async () => {
  const { result } = renderHook(() => useTicketBoard(filter, true, 0));
  await settled(result);
  read.tickets = [...read.tickets, ticket(3)];
  await act(async () => {
    await result.current.refresh();
  });
  expect([...result.current.fresh]).toEqual(["3"]);
  await act(async () => {
    result.current.placeTicket({ ...ticket(3), status: "Done" });
  });
  expect(result.current.fresh.size).toBe(0);
});
