import { useMemo } from "react";
import { documents, type DocumentLink } from "@/features/documents/api";
import { attachments } from "@/lib/api/attachments";
import type { FailureDescription } from "@/lib/api/describe-failure";
import {
  read,
  skip,
  updateRead,
  useRead,
  type Fill,
  type ReadStatus,
} from "@/lib/workspace-reads";
import type { Ticket } from "@/lib/api/client";

// The files of a Ticket: attached files, and the Documents it links to.

export type TicketDocumentLinks = {
  /** One link per Document by its strongest source; undefined until read. */
  links: DocumentLink[] | undefined;
  failure: FailureDescription | null;
  retry(): void;
  status: ReadStatus;
};

const attachmentsRead = read({
  key: "attachments",
  call: (reference: string) => attachments.forTicket(reference),
  failure: "load attachments",
});

/**
 * A Ticket's links to Documents, outgoing and incoming, 100 at a time. Files
 * (the outgoing side) and Backlinks (the incoming side) share offset 0.
 */
export const documentLinksRead = read({
  key: "documentLinks",
  call: (args: { id: string; offset: number }) =>
    documents.links(args.id, args.offset),
  failure: "load Documents",
});

const sourceRank = (link: DocumentLink) =>
  link.explicit ? 0 : link.activity_id ? 2 : 1;

// Attached Documents list first, like the CLI's context.
function strongest(outgoing: DocumentLink[]): DocumentLink[] {
  const byDocument = new Map<string, DocumentLink>();
  for (const link of outgoing) {
    if (link.target_kind !== "document") continue;
    const known = byDocument.get(link.target_id);
    if (!known || sourceRank(link) < sourceRank(known))
      byDocument.set(link.target_id, link);
  }
  return [...byDocument.values()].sort((a, b) => sourceRank(a) - sourceRank(b));
}

/** The files attached to the Ticket. */
export function useAttachments(record: Ticket | undefined) {
  return useRead(attachmentsRead, record?.reference ?? skip);
}

/** The Documents the Ticket links to, one per Document by its strongest source. */
export function useDocuments(record: Ticket | undefined): TicketDocumentLinks {
  const state = useRead(
    documentLinksRead,
    record ? { id: record.id, offset: 0 } : skip,
  );
  const outgoing = state.value?.[0];
  const links = useMemo(
    () => (outgoing ? strongest(outgoing) : undefined),
    [outgoing],
  );
  return {
    links,
    failure: state.failure,
    retry: state.retry,
    status: state.status,
  };
}

type DocumentLinks = [outgoing: DocumentLink[], incoming: DocumentLink[]];

const firstWindow = (record: Ticket) => ({ id: record.id, offset: 0 });

/**
 * The fill for unlinking `documentId` from `record`: its explicit link leaves
 * the Documents list, as in the core, which deletes only the attached row. A
 * mention in the description or an update stays. Pass it to `changed` after
 * `documents.setTicketDocument(..., false)` succeeded.
 */
export function unlinkedDocumentFill(record: Ticket, documentId: string): Fill {
  return updateRead(
    documentLinksRead,
    firstWindow(record),
    (cached): DocumentLinks => {
      const [outgoing, incoming] = cached;
      const kept = outgoing.filter(
        (link) => !(link.target_id === documentId && link.explicit),
      );
      return kept.length === outgoing.length ? cached : [kept, incoming];
    },
  );
}

/**
 * The fill for linking a Document again (Undo of an unlink): `link` goes back
 * among the outgoing links unless an explicit link to the Document is listed
 * already (a mention does not count). Pass it to `changed` after
 * `documents.setTicketDocument(..., true)` succeeded.
 */
export function relinkedDocumentFill(record: Ticket, link: DocumentLink): Fill {
  return updateRead(
    documentLinksRead,
    firstWindow(record),
    (cached): DocumentLinks => {
      const [outgoing, incoming] = cached;
      return outgoing.some(
        (known) => known.target_id === link.target_id && known.explicit,
      )
        ? cached
        : [[...outgoing, link], incoming];
    },
  );
}
