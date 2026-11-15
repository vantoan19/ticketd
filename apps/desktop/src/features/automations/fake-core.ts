import type { Automation } from "@/features/automations/client";

/**
 * For tests: an Automation after a save, as a fake core answers. It derives the
 * one thing the page takes from the core about a definition and cannot work
 * out itself: whether its runs have a ticket.
 */
export function fakeStored(
  automation: Automation,
  definition: Partial<Automation>,
): Automation {
  const next = { ...automation, ...definition };
  const kind = next.trigger?.kind;
  return { ...next, has_ticket: kind !== "schedule" && kind !== "by_hand" };
}
