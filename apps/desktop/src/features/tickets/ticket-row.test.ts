import { expect, test } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { readiness, readinessLabel } from "./ticket-row";

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
