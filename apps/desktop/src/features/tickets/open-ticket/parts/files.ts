import { useMemo } from "react";
import { documents } from "@/features/documents/api";
import { attachments, type Attachment } from "@/lib/api/attachments";
import type { FailureDescription } from "@/lib/api/describe-failure";
import {
  read,
  skip,
  useRead,
  type ReadState,
  type ReadStatus,
} from "@/lib/workspace-reads";
import { parts, type Part } from "../parts";

// The files of a Ticket: attached files, and the Documents it links to.

export type DocumentLink = Awaited<
  ReturnType<typeof documents.links>
>[0][number];

export type TicketDocumentLinks = {
  /** One link per Document by its strongest source; undefined until read. */
  links: DocumentLink[] | undefined;
  failure: FailureDescription | null;
  retry(): void;
  status: ReadStatus;
};

declare module "../parts" {
  interface Parts {
    attachments: Part<[], ReadState<Attachment[]>>;
    documents: Part<[], TicketDocumentLinks>;
  }
}

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

parts.attachments = function useAttachmentsPart(record) {
  return useRead(attachmentsRead, record?.reference ?? skip);
};

parts.documents = function useDocumentsPart(record) {
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
};
