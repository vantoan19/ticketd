import { useMemo } from "react";
import { client, type Relationships, type Ticket } from "@/lib/api/client";
import { mergePage, nextOffset } from "@/features/tickets/linked-work";
import {
  pagedRead,
  skip,
  usePagedRead,
  withCurrent,
  type PagedState,
} from "@/lib/workspace-reads";

/** A Ticket's relationships, one core page at a time. */
const relationshipsRead = pagedRead({
  key: "relationships",
  call: (reference: string, offset) =>
    client.contextualRelationships(reference, offset),
  next: (page: Relationships) => nextOffset(page),
  // Pages overlap when links changed between reads, so a Ticket never repeats.
  join: (pages: readonly Relationships[]) =>
    pages.reduce((known, page) => mergePage(known, page)),
  failure: "load relationships",
  more: "load more links",
});

/** The failure a read that already has links shows: they are kept, the refresh failed. */
const refreshing = "Couldn't refresh relationships";

export type LinkedWorkRead = Omit<PagedState<Relationships>, "failure"> & {
  /** Why the links could not be read or refreshed; the links shown stay. */
  failure: PagedState<Relationships>["failure"];
  /** Why the next page could not be read, apart from the read itself. */
  moreFailure: PagedState<Relationships>["failure"];
};

/** The Ticket's linked work, paged: parent, subtickets, blockers, related, duplicates. */
export function useLinkedWork(record: Ticket | undefined): LinkedWorkRead {
  const state = usePagedRead(relationshipsRead, record?.reference ?? skip);
  const { value, failure: raw, failedMore: moreFailed } = state;
  const failure = useMemo(
    () =>
      raw === null || moreFailed
        ? null
        : value
          ? { ...raw, title: refreshing }
          : raw,
    [raw, moreFailed, value],
  );
  return withCurrent(
    {
      value,
      failure,
      failedMore: moreFailed,
      moreFailure: moreFailed ? raw : null,
      retry: state.retry,
      status: state.status,
      more: state.more,
      showMore: state.showMore,
      loadingMore: state.loadingMore,
    },
    () => state.current,
  );
}
