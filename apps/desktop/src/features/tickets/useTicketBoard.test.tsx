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
  ({ id: String(n), local_number: n, reference: `T-${n}`, status }) as Ticket;
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

// Device counters do not determine local order: the older imported ticket can
// have a much larger counter than a newer ticket from another device.
it("a mixed-device move takes the core slot before confirmation and stays there", async () => {
  const newer = { ...ticket(40, "Done"), reference: "T-AA1" };
  const middle = { ...ticket(37, "Done"), reference: "T-BD37" };
  const older = { ...ticket(34, "Done"), reference: "T-BD34" };
  const moved = { ...ticket(36), reference: "T-ZZ900" };
  read.tickets = [newer, middle, older, moved];
  const { result } = renderHook(() => useTicketBoard(filter, true, 0));
  await settled(result);
  await act(async () => {
    result.current.placeTicket({ ...moved, status: "Done" });
  });
  expect(done(result)).toEqual(["T-AA1", "T-BD37", "T-ZZ900", "T-BD34"]);

  read.tickets = [newer, middle, { ...moved, status: "Done" }, older];
  await act(async () => {
    await result.current.refresh();
  });
  expect(done(result)).toEqual(["T-AA1", "T-BD37", "T-ZZ900", "T-BD34"]);
});

it("older payloads without local order remain movable without guessing from references", async () => {
  const legacy = { ...ticket(5), local_number: undefined };
  read.tickets = [
    { ...ticket(10, "Done"), local_number: null },
    ticket(2, "Done"),
    legacy,
  ];
  const { result } = renderHook(() => useTicketBoard(filter, true, 0));
  await settled(result);
  await act(async () => {
    result.current.placeTicket({ ...legacy, status: "Done" });
  });
  expect(done(result)).toEqual(["T-5", "T-10", "T-2"]);
});
