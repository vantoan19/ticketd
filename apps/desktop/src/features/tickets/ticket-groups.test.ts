import { expect, test } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { groupTickets } from "./ticket-groups";

const ticket = (id: number, status: string) =>
  ({ id: String(id), reference: `T-KQ${id}`, status }) as Ticket;
const counts = {
  total: 0,
  todo: 0,
  in_progress: 0,
  in_review: 0,
  done: 0,
  canceled: 0,
  duplicate: 0,
};

test("groups the shown page in workflow order with the whole result's counts", () => {
  const groups = groupTickets(
    [ticket(5, "Todo"), ticket(4, "Todo"), ticket(3, "Done")],
    { ...counts, todo: 70, done: 1 },
  );
  expect(groups.map((group) => [group.status, group.count])).toEqual([
    ["Todo", 70],
    ["Done", 1],
  ]);
  expect(groups[0]?.tickets.map((item) => item.reference)).toEqual([
    "T-KQ5",
    "T-KQ4",
  ]);
});

test("omits statuses that have no row on the page and never counts below the rows shown", () => {
  const groups = groupTickets(
    [ticket(2, "Duplicate"), ticket(1, "In progress")],
    { ...counts, done: 4, in_progress: 0 },
  );
  expect(groups.map((group) => [group.status, group.count])).toEqual([
    ["In progress", 1],
    ["Duplicate", 1],
  ]);
});
