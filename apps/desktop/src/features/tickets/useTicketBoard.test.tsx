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

// The core lists a column highest number first, so a card shown at once in
// its new column must take that slot, or it moves when the core confirms.
const done = (result: { current: ReturnType<typeof useTicketBoard> }) =>
  result.current.columns
    .find((column) => column.status === "Done")
    ?.tickets.map((item) => item.reference);

it("a card placed at once takes its slot in the column's order, not the top", async () => {
  read.tickets = [
    ticket(10, "Done"),
    ticket(8, "Done"),
    ticket(2, "Done"),
    ticket(5),
    ticket(12),
    ticket(1),
  ];
  const { result } = renderHook(() => useTicketBoard(filter, true, 0));
  await settled(result);
  await act(async () => {
    result.current.placeTicket({ ...ticket(5), status: "Done" });
  });
  expect(done(result)).toEqual(["T-10", "T-8", "T-5", "T-2"]);
  await act(async () => {
    result.current.placeTicket({ ...ticket(12), status: "Done" });
  });
  expect(done(result)).toEqual(["T-12", "T-10", "T-8", "T-5", "T-2"]);
  await act(async () => {
    result.current.placeTicket({ ...ticket(1), status: "Done" });
  });
  expect(done(result)).toEqual(["T-12", "T-10", "T-8", "T-5", "T-2", "T-1"]);
});

it("the slot is the one the core confirms, so a refresh moves nothing", async () => {
  read.tickets = [ticket(10, "Done"), ticket(2, "Done"), ticket(5)];
  const { result } = renderHook(() => useTicketBoard(filter, true, 0));
  await settled(result);
  await act(async () => {
    result.current.placeTicket({ ...ticket(5), status: "Done" });
  });
  const placed = done(result);
  read.tickets = [ticket(10, "Done"), ticket(5, "Done"), ticket(2, "Done")];
  await act(async () => {
    await result.current.refresh();
  });
  expect(done(result)).toEqual(placed);
});

it("putting a card back uses the place it was given", async () => {
  read.tickets = [ticket(10, "Done"), ticket(2, "Done"), ticket(5)];
  const { result } = renderHook(() => useTicketBoard(filter, true, 0));
  await settled(result);
  await act(async () => {
    result.current.placeTicket({ ...ticket(5), status: "Done" }, 0);
  });
  expect(done(result)).toEqual(["T-5", "T-10", "T-2"]);
});

// A reference is a device code plus that device's own counter, so counters of
// different devices say nothing about the core's order: only one device's are
// compared, and a card with no kin in the column leads.
it("compares counters within one device code only", async () => {
  const at = (reference: string, status = "Done") =>
    ({ id: reference, reference, status }) as Ticket;
  read.tickets = [
    at("T-AB90"),
    at("T-CD5"),
    at("T-AB3"),
    at("T-CD2"),
    at("T-AB50", "Todo"),
    at("T-CD40", "Todo"),
    at("T-EF7", "Todo"),
    at("T-AB1", "Todo"),
  ];
  const { result } = renderHook(() => useTicketBoard(filter, true, 0));
  await settled(result);
  const place = async (reference: string) => {
    await act(async () => {
      result.current.placeTicket(at(reference));
    });
    return done(result);
  };
  // Not by the digits alone: those would put 50 above CD5 and 40 above AB50.
  expect(await place("T-AB50")).toEqual([
    "T-AB90",
    "T-CD5",
    "T-AB50",
    "T-AB3",
    "T-CD2",
  ]);
  expect(await place("T-CD40")).toEqual([
    "T-AB90",
    "T-CD40",
    "T-CD5",
    "T-AB50",
    "T-AB3",
    "T-CD2",
  ]);
  // No ticket of its device is there: the lead.
  expect(await place("T-EF7")).toEqual([
    "T-EF7",
    "T-AB90",
    "T-CD40",
    "T-CD5",
    "T-AB50",
    "T-AB3",
    "T-CD2",
  ]);
  // Older than every ticket of its device: after the last of them.
  expect(await place("T-AB1")).toEqual([
    "T-EF7",
    "T-AB90",
    "T-CD40",
    "T-CD5",
    "T-AB50",
    "T-AB3",
    "T-AB1",
    "T-CD2",
  ]);
});
