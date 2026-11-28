import { client, type Ticket } from "@/lib/api/client";
import { pagedRead, skip, usePagedRead } from "@/lib/workspace-reads";

/** A Ticket's evidence records, a page at a time. */
const evidenceRead = pagedRead({
  key: "evidence",
  call: (reference: string, offset) => client.evidencePage(reference, offset),
  next: (page, pages) => {
    const loaded = pages.reduce(
      (count, loaded) => count + loaded.items.length,
      0,
    );
    return page.items.length > 0 && loaded < page.total ? loaded : null;
  },
  join: (pages) => ({
    items: pages.flatMap((page) => page.items),
    total: pages[0]?.total ?? 0,
    proof: pages[0]?.proof ?? [],
  }),
  failure: "load evidence",
  more: "load more evidence",
});

/** The Ticket's evidence: pull requests, commits, branches, worktrees, verifications. */
export function useEvidence(record: Ticket | undefined) {
  return usePagedRead(evidenceRead, record?.reference ?? skip);
}
