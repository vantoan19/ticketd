import type { DocumentSummary } from "./api";

/**
 * What a list row says about where the Document belongs: "Spec of {Plan}" for a Plan's spec,
 * else the name of a Plan it is attached to (Archived included), else the reference of the
 * first ticket that includes it, unless its title already starts with that reference.
 */
export function documentRowContext(doc: DocumentSummary): string {
  const plans = doc.plans ?? [];
  const spec = plans.find((plan) => plan.spec);
  if (spec) return `Spec of ${spec.name}`;
  if (plans[0]) return plans[0].name;
  const reference = doc.tickets?.[0]?.reference;
  return reference && !doc.heading.startsWith(reference) ? reference : "";
}

/**
 * What a row says inside a Current work group, whose header already names the Plan: "Spec"
 * for the Plan's spec, else the reference of the open ticket that brings it here (the first
 * ticket when none is open), unless its title already starts with that reference.
 */
export function groupRowContext(doc: DocumentSummary): string {
  if (doc.plans?.some((plan) => plan.spec && !plan.archived)) return "Spec";
  const tickets = doc.tickets ?? [];
  const ticket = tickets.find((item) => item.open) ?? tickets[0];
  return ticket && !doc.heading.startsWith(ticket.reference)
    ? ticket.reference
    : "";
}
