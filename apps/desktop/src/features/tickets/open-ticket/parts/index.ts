import type { Ticket } from "@/lib/api/client";
import { useActivity, useActivityNote, useLatestUpdate } from "./activity";
import { useFollowing, useReminder } from "./attention";
import { useBacklinks, useDocumentBacklinks } from "./backlinks";
import { useEvidence } from "./evidence";
import { useAttachments, useDocuments } from "./files";
import { useLinkedWork } from "./linked-work";

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

// Every part, by name. A new part is one line here; its types follow from it.
const declared = {
  linkedWork: useLinkedWork,
  evidence: useEvidence,
  activity: useActivity,
  activityNote: useActivityNote,
  latestUpdate: useLatestUpdate,
  reminder: useReminder,
  following: useFollowing,
  attachments: useAttachments,
  documents: useDocuments,
  backlinks: useBacklinks,
  documentBacklinks: useDocumentBacklinks,
};
type Declared = typeof declared;

export type PartName = keyof Declared;
export type PartArgs<Name extends PartName> =
  Declared[Name] extends Part<infer Args, unknown> ? Args : never;
export type PartState<Name extends PartName> = ReturnType<Declared[Name]>;

const parts: { [Name in PartName]: Part<PartArgs<Name>, PartState<Name>> } =
  declared;

/**
 * Serves part `name` of `record`, or nothing when no part is asked for. A call
 * site names the same part every render, so the hooks inside a part keep order.
 */
export function usePart<Name extends PartName>(
  record: Ticket | undefined,
  name: Name | undefined,
  args: PartArgs<Name>,
): PartState<Name> | undefined {
  if (name === undefined) return undefined;
  return parts[name](record, ...args);
}

// Fill builders: what a write of a section sets, for `changed(returned, fills)`.
export { editedUpdateFills } from "./activity";
export { followingFill } from "./attention";
export { relinkedDocumentFill, unlinkedDocumentFill } from "./files";
