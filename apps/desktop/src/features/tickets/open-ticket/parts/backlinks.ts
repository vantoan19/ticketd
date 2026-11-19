import { useMemo, useState } from "react";
import { documents, type DocumentLink } from "@/features/documents/api";
import { client, type Ticket } from "@/lib/api/client";
import type { FailureDescription } from "@/lib/api/describe-failure";
import { read, skip, useRead } from "@/lib/workspace-reads";
import { documentLinksRead } from "./files";

// What mentions a Ticket: other tickets and updates (a window at a time), and
// Documents.

type Backlink = Awaited<ReturnType<typeof client.backlinks>>[number];

export type TicketBacklinks = {
  /** The shown window; the previous one stays while the next is read. Each
   * mentioning update carries its `reported_at`. */
  links: Backlink[] | undefined;
  failure: FailureDescription | null;
  retry(): void;
};

const backlinksRead = read({
  key: "backlinks",
  call: (args: { reference: string; offset: number }) =>
    client.backlinks(args.reference, args.offset),
  failure: "load mentions",
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

/** One window of 20 backlinks, from `offset`. */
export function useBacklinks(
  record: Ticket | undefined,
  offset: number,
): TicketBacklinks {
  const state = useRead(
    backlinksRead,
    record ? { reference: record.reference, offset } : skip,
  );
  // Show the previous window until the next one is read, so nothing jumps.
  const [shown, setShown] = useState(state.value);
  if (state.value && state.value !== shown) setShown(state.value);
  return {
    links: state.value ?? shown,
    failure: state.failure,
    retry: state.retry,
  };
}

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
