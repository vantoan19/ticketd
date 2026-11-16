import { client, type Evidence, type Ticket } from "@/lib/api/client";
import {
  pagedRead,
  skip,
  usePagedRead,
  type PagedState,
} from "@/lib/workspace-reads";
import { parts, type Part } from "../parts";

/** The core answers evidence in pages of this many; a shorter page is the last. */
const pageSize = 50;

/** A Ticket's evidence records, a page at a time. */
const evidenceRead = pagedRead({
  key: "evidence",
  call: (reference: string, offset) => client.evidence(reference, offset),
  next: (page: Evidence[], pages) =>
    page.length === pageSize ? pages.length * pageSize : null,
  join: (pages: readonly Evidence[][]) => pages.flat(),
  failure: "load evidence",
  more: "load more evidence",
});

declare module "../parts" {
  interface Parts {
    /** The Ticket's evidence: pull requests, commits, branches, worktrees, verifications. */
    evidence: Part<[], PagedState<Evidence[]>>;
  }
}

function useEvidence(record: Ticket | undefined) {
  return usePagedRead(evidenceRead, record?.reference ?? skip);
}

parts.evidence = useEvidence;
