import type { Ticket } from "@/lib/api/client";

/**
 * A section's data of a Ticket, for example its linked work or its evidence.
 * It is a hook over the reads module's catalogue that hides which identifier
 * each command wants (reference or internal id), reads that need combining and
 * the failure wording. `record` is undefined until the Ticket is known.
 */
export type Part<Args extends unknown[], State> = (
  record: Ticket | undefined,
  ...args: Args
) => State;

/**
 * Every part, by name. A part is declared here with the section that uses it:
 * `useOpenTicket(part)` serves it inside a page and `useTicket(reference, part)`
 * to callers above the pages.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Parts {}

export const parts: { [Name in keyof Parts]?: Parts[Name] } = {};

export type PartName = keyof Parts;
export type PartArgs<Name extends PartName> =
  Parts[Name] extends Part<infer Args, unknown> ? Args : never;
export type PartState<Name extends PartName> =
  Parts[Name] extends Part<never, infer State> ? State : never;

/**
 * Serves part `name` of `record`, or nothing when no part is asked for. A call
 * site names the same part every render, so the hooks inside a part keep order.
 */
export function usePart(
  record: Ticket | undefined,
  name: PartName | undefined,
  args: unknown[],
): unknown {
  if (name === undefined) return undefined;
  const part = parts[name] as unknown as Part<unknown[], unknown> | undefined;
  if (!part) throw new Error(`The Open Ticket has no part named "${name}".`);
  return part(record, ...args);
}
