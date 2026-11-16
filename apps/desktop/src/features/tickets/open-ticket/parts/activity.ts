import {
  client,
  type ActivityFeedEntry,
  type AuthoredActivity,
} from "@/lib/api/client";
import { latestUpdate, type LatestUpdate } from "@/lib/api/progress";
import {
  pagedRead,
  read,
  skip,
  usePagedRead,
  useRead,
  type PagedState,
  type ReadState,
} from "@/lib/workspace-reads";
import { parts, type Part } from "../parts";

// The Ticket page's Activity and the agent line: the feed, one update looked up
// by id (a link into Activity), and the latest update that the agent line and
// the "Latest update" property share.

const FEED_PAGE = 50;

const activityRead = pagedRead({
  key: "activity-feed",
  call: (reference: string, offset: number) =>
    client.activityFeed(reference, offset),
  next: (page, pages) =>
    page.length === FEED_PAGE
      ? pages.reduce((count, loaded) => count + loaded.length, 0)
      : null,
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

declare module "../parts" {
  interface Parts {
    /** The Ticket's feed of authored updates and recorded changes, 50 at a time. */
    activity: Part<[], PagedState<ActivityFeedEntry[]>>;
    /** One authored update by id; null when it no longer exists. Reads nothing without an id. */
    activityNote: Part<
      [id: string | undefined],
      ReadState<AuthoredActivity | null>
    >;
    /** The Ticket's latest authored update, or null when it has none. */
    latestUpdate: Part<[], ReadState<LatestUpdate | null>>;
  }
}

parts.activity = (record) =>
  usePagedRead(activityRead, record?.reference ?? skip);
parts.activityNote = (record, id) =>
  useRead(
    activityNoteRead,
    record && id !== undefined ? { reference: record.reference, id } : skip,
  );
parts.latestUpdate = (record) =>
  useRead(latestUpdateRead, record?.reference ?? skip);
