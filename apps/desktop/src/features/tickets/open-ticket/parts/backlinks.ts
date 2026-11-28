import { useMemo } from "react";
import { documents, type DocumentLink } from "@/features/documents/api";
import { client, type Ticket } from "@/lib/api/client";
import {
  pagedRead,
  read,
  skip,
  usePagedRead,
  useRead,
} from "@/lib/workspace-reads";
import { documentLinksRead } from "./files";

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
  failure: "load mentions",
  more: "load more mentions",
});

const PAGE = 100;

// Incoming links mix tickets, Plans and Documents; past the first 100 (the
// shared read) page through them, so Document mentions are not lost.
const laterDocumentBacklinksRead = read({
  key: "documentBacklinksAfterFirstPage",
  call: async (id: string) => {
    const found: DocumentLink[] = [];
    for (let page = 1; page < 5; page += 1) {
      const [, incoming] = await documents.links(id, page * PAGE);
      found.push(...incoming.filter((link) => link.source_kind === "document"));
      if (incoming.length < PAGE) break;
    }
    return found;
  },
  failure: "load mentions",
});

export function useBacklinks(record: Ticket | undefined) {
  return usePagedRead(backlinksRead, record?.reference ?? skip);
}

export type TicketBacklinks = ReturnType<typeof useBacklinks>;

/** The Documents that mention the Ticket (incoming links of kind document). */
export function useDocumentBacklinks(
  record: Ticket | undefined,
): DocumentLink[] {
  const first = useRead(
    documentLinksRead,
    record ? { id: record.id, offset: 0 } : skip,
  );
  const incoming = first.value?.[1];
  const later = useRead(
    laterDocumentBacklinksRead,
    record && incoming && incoming.length >= PAGE ? record.id : skip,
  );
  return useMemo(
    () => [
      ...(incoming?.filter((link) => link.source_kind === "document") ?? []),
      ...(later.value ?? []),
    ],
    [incoming, later.value],
  );
}
