import { client, type Evidence, type Ticket } from "@/lib/api/client";
import { byOffset, pagedRead, skip, usePagedRead } from "@/lib/workspace-reads";

/** The core answers evidence in pages of this many; a shorter page is the last. */
const pageSize = 50;

/** A Ticket's evidence records, a page at a time. */
const evidenceRead = pagedRead({
  key: "evidence",
  call: (reference: string, offset) => client.evidence(reference, offset),
  next: byOffset<Evidence>(pageSize),
  join: (pages: readonly Evidence[][]) => pages.flat(),
  failure: "load evidence",
  more: "load more evidence",
});

/** The Ticket's evidence: pull requests, commits, branches, worktrees, verifications. */
export function useEvidence(record: Ticket | undefined) {
  return usePagedRead(evidenceRead, record?.reference ?? skip);
}
