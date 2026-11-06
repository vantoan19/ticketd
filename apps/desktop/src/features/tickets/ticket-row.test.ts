import { expect, test } from "vitest";
import type { Ticket } from "@/lib/api/client";
import {
  fittingTags,
  readiness,
  readinessLabel,
  readinessShortLabel,
} from "./ticket-row";

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

test("line two shows every tag that fits and counts the rest", () => {
  // Two 60px pills and a 32px "+N" pill in a 192px half-line.
  expect(fittingTags([60, 60], 192)).toBe(2);
  expect(fittingTags([60, 60, 60], 192)).toBe(2);
  expect(fittingTags([60, 60, 60], 100)).toBe(1);
  expect(fittingTags([60], 0)).toBe(1);
});
