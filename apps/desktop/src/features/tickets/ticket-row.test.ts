import { expect, test } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { readiness, readinessLabel, readinessShortLabel } from "./ticket-row";

test("a blocker in Trash is named as such", () => {
  const ticket = {
    status: "Todo",
    availability: "Blocked",
    prerequisites: [
      {
        reference: "T-7",
        title: "x",
        status: "Todo",
        trashed: true,
        unresolved: true,
      },
    ],
  } as unknown as Ticket;
  expect(readinessLabel(readiness(ticket))).toBe("Blocked by T-7 (in Trash)");
});

test("the visible label keeps the blocker count short", () => {
  const ticket = {
    status: "Todo",
    availability: "Blocked",
    prerequisites: ["T-2", "T-3", "T-4"].map((reference) => ({
      reference,
      title: "x",
      status: "Todo",
      unresolved: true,
    })),
  } as unknown as Ticket;
  expect(readinessShortLabel(readiness(ticket))).toBe("Blocked by T-2 +2");
  expect(readinessLabel(readiness(ticket))).toBe("Blocked by T-2 and 2 more");
});
