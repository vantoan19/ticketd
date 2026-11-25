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
