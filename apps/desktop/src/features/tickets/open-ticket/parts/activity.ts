import { client, type Ticket } from "@/lib/api/client";
import { latestUpdate } from "@/lib/api/progress";
import {
  byOffset,
  pagedRead,
  read,
  skip,
  usePagedRead,
  useRead,
} from "@/lib/workspace-reads";

// The Ticket page's Activity and the agent line: the feed, one update looked up
// by id (a link into Activity), and the latest update that the agent line and
// the "Latest update" property share.

const FEED_PAGE = 50;

const activityRead = pagedRead({
  key: "activity-feed",
  call: (reference: string, offset: number) =>
    client.activityFeed(reference, offset),
  next: byOffset(FEED_PAGE),
  join: (pages) => pages.flat(),
  failure: "load activity",
  more: "load more activity",
});

const activityNoteRead = read({
  key: "activity-note",
  call: (target: { reference: string; id: string }) =>
    client.activity(target.reference, target.id),
  failure: "load the linked update",
});

const latestUpdateRead = read({
  key: "latest-update",
  call: (reference: string) => latestUpdate(reference),
  failure: "load the latest update",
});

/** The Ticket's feed of authored updates and recorded changes, 50 at a time. */
export function useActivity(record: Ticket | undefined) {
  return usePagedRead(activityRead, record?.reference ?? skip);
}

/** One authored update by id; null when it no longer exists. Reads nothing without an id. */
export function useActivityNote(
  record: Ticket | undefined,
  id: string | undefined,
) {
  return useRead(
    activityNoteRead,
    record && id !== undefined ? { reference: record.reference, id } : skip,
  );
}

/** The Ticket's latest authored update, or null when it has none. */
export function useLatestUpdate(record: Ticket | undefined) {
  return useRead(latestUpdateRead, record?.reference ?? skip);
}
