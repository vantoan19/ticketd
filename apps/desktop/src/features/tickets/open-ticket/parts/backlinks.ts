import { client, type Ticket } from "@/lib/api/client";
import { pagedRead, skip, usePagedRead } from "@/lib/workspace-reads";

// What mentions a Ticket: other tickets and updates (a window at a time), and
// Documents.

type MentionPage = Awaited<ReturnType<typeof client.backlinks>>;

const backlinksRead = pagedRead({
  key: "backlinks",
  call: (reference: string, offset) => client.backlinks(reference, offset),
  next: (page: MentionPage, pages) => {
    const loaded = pages.reduce(
      (count, entry) => count + entry.items.length,
      0,
    );
    return page.items.length > 0 && loaded < page.total ? loaded : null;
  },
  join: (pages: readonly MentionPage[]) => {
    const tickets = new Map<string, MentionPage["items"][number]>();
    for (const page of pages) {
      for (const ticket of page.items) {
        if (!tickets.has(ticket.reference))
          tickets.set(ticket.reference, ticket);
      }
    }
    return { items: [...tickets.values()], total: pages.at(-1)?.total ?? 0 };
  },
  failure: "load ticket mentions",
  more: "load more ticket mentions",
});

const documentBacklinksRead = pagedRead({
  key: "documentBacklinks",
  call: (reference: string, offset) =>
    client.documentMentions(reference, offset),
  next: (page, pages) => {
    const loaded = pages.reduce(
      (count, entry) => count + entry.items.length,
      0,
    );
    return page.items.length > 0 && loaded < page.total ? loaded : null;
  },
  join: (pages) => ({
    items: pages.flatMap((page) => page.items),
    total: pages.at(-1)?.total ?? 0,
  }),
  failure: "load Document mentions",
  more: "load more Document mentions",
});

const passagesRead = pagedRead({
  key: "mentionPassages",
  call: (
    {
      reference,
      source,
      start,
    }: { reference: string; source: string; start: number },
    offset,
  ) => client.mentionPassages(reference, source, offset || start),
  next: (page) => page.next_offset,
  join: (pages) => pages.flatMap((page) => page.items),
  failure: "load passages",
  more: "load more passages",
});

export function useBacklinks(record: Ticket | undefined) {
  return usePagedRead(backlinksRead, record?.reference ?? skip);
}

export type TicketBacklinks = ReturnType<typeof useBacklinks>;

export function useDocumentBacklinks(record: Ticket | undefined) {
  return usePagedRead(documentBacklinksRead, record?.reference ?? skip);
}

export function useMentionPassages(
  record: Ticket | undefined,
  source: string,
  start: number | null,
) {
  return usePagedRead(
    passagesRead,
    record && start !== null
      ? { reference: record.reference, source, start }
      : skip,
  );
}
