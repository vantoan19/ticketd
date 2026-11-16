import { useMemo, useState } from "react";
import { documents } from "@/features/documents/api";
import { client } from "@/lib/api/client";
import type { FailureDescription } from "@/lib/api/describe-failure";
import { read, skip, useRead } from "@/lib/workspace-reads";
import { parts, type Part } from "../parts";
import { documentLinksRead } from "./files";

// What mentions a Ticket: other tickets and updates (a window at a time), and
// Documents.

type Backlink = Awaited<ReturnType<typeof client.backlinks>>[number];
type DocumentBacklink = Awaited<ReturnType<typeof documents.links>>[1][number];

export type TicketBacklinks = {
  /** The shown window; the previous one stays while the next is read. */
  links: Backlink[] | undefined;
  /** When each mentioning update was reported, by its id. */
  dates: Record<string, string>;
  failure: FailureDescription | null;
  retry(): void;
};

declare module "../parts" {
  interface Parts {
    /** One window of 20 backlinks, from `offset`, with the dates of updates. */
    backlinks: Part<[offset: number], TicketBacklinks>;
    /** The Documents that mention the Ticket (incoming links of kind document). */
    documentBacklinks: Part<[], DocumentBacklink[]>;
  }
}

const backlinksRead = read({
  key: "backlinks",
  call: (args: { reference: string; offset: number }) =>
    client.backlinks(args.reference, args.offset),
  failure: "load mentions",
});

// The mention itself carries no date, so each update's is read. An update that
// cannot be read just has no date.
const noteDatesRead = read({
  key: "backlinkDates",
  call: async (notes: [source: string, id: string][]) => {
    const dated = await Promise.all(
      notes.map(([source, id]) =>
        client
          .activity(source, id)
          .then((note) => [id, note?.reported_at] as const)
          .catch(() => null),
      ),
    );
    return Object.fromEntries(
      dated.flatMap((entry) =>
        entry?.[0] && entry[1] ? [[entry[0], entry[1]]] : [],
      ),
    ) as Record<string, string>;
  },
  failure: "load mentions",
});

const PAGE = 100;

// Incoming links mix tickets, Plans and Documents; past the first 100 (the
// shared read) page through them, so Document mentions are not lost.
const laterDocumentBacklinksRead = read({
  key: "documentBacklinksAfterFirstPage",
  call: async (id: string) => {
    const found: DocumentBacklink[] = [];
    for (let page = 1; page < 5; page += 1) {
      const [, incoming] = await documents.links(id, page * PAGE);
      found.push(...incoming.filter((link) => link.source_kind === "document"));
      if (incoming.length < PAGE) break;
    }
    return found;
  },
  failure: "load mentions",
});

parts.backlinks = function useBacklinksPart(record, offset) {
  const state = useRead(
    backlinksRead,
    record ? { reference: record.reference, offset } : skip,
  );
  // Show the previous window until the next one is read, so nothing jumps.
  const [shown, setShown] = useState(state.value);
  if (state.value && state.value !== shown) setShown(state.value);
  const links = state.value ?? shown;
  const notes = useMemo(
    () =>
      links?.flatMap((link): [string, string][] =>
        link.activity_id ? [[link.source_reference, link.activity_id]] : [],
      ) ?? [],
    [links],
  );
  const dates = useRead(noteDatesRead, notes.length > 0 ? notes : skip);
  return {
    links,
    dates: dates.value ?? {},
    failure: state.failure,
    retry: state.retry,
  };
};

parts.documentBacklinks = function useDocumentBacklinksPart(record) {
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
};
