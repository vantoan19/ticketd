import { invoke } from "@/lib/api/bridge-failure";
import { z } from "zod";
import { loadPreferences } from "@/lib/preferences";
import { plainLabel, plainSnippet } from "@/lib/plain-text";

const schema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  body: z.string(),
  heading: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  trashed: z.boolean(),
  origin_brief: z.string().nullable().optional(),
  origin_ticket: z.string().nullable().optional(),
  kept: z.boolean().optional(),
  /** The author's one-line summary; absent when there is none. */
  summary: z.string().nullable().optional(),
});
export type Document = z.infer<typeof schema>;
const linkSchema = z.object({
  source_id: z.string(),
  target_id: z.string(),
  source_kind: z.string(),
  target_kind: z.string(),
  passage: z.string(),
  source_label: z.string(),
  target_label: z.string(),
  source_trashed: z.boolean(),
  target_trashed: z.boolean(),
  explicit: z.boolean().optional(),
  /** The update that mentions the target, when the link comes from one. */
  activity_id: z.string().nullable().optional(),
});
/** One link between a Document and another record, as the core reports it. */
export type DocumentLink = z.infer<typeof linkSchema>;
const linkDocuments = {
  linkMarkdown: async (reference: string) =>
    z.string().parse(await invoke("context_link_markdown", { reference })),
  links: async (id: string, offset = 0) =>
    z
      .tuple([z.array(linkSchema), z.array(linkSchema)])
      .parse(await invoke("document_context_links", { id, offset })),
  /** Attach or detach a Document to a ticket's context without touching its description. */
  setTicketDocument: async (
    reference: string,
    documentId: string,
    present: boolean,
  ) => {
    await invoke("set_ticket_document", {
      reference,
      documentId,
      present,
      requestId: crypto.randomUUID(),
    });
  },
  createTicket: async (id: string, title: string, requestId: string) =>
    z.object({ reference: z.string() }).parse(
      await invoke("ticket_from_document", {
        id,
        title,
        requestId,
        follow: loadPreferences().followCreated,
      }),
    ),
};
// A derived heading is the body's first line and can hold Markdown; list rows show plain text.
const summary = z.object({
  id: z.string(),
  heading: z.string().transform(plainLabel),
  origin_ticket: z.string().nullable().optional(),
  snippet: z.string().transform(plainSnippet).optional(),
  tags: z.array(z.string()).optional(),
  updated_at: z.string().optional(),
  /** Where the Document belongs, read with the row so a list never asks per row. */
  plans: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        archived: z.boolean(),
        spec: z.boolean(),
      }),
    )
    .optional(),
  tickets: z
    .array(
      z.object({
        reference: z.string(),
        title: z.string(),
        status: z.string(),
      }),
    )
    .optional(),
  /** Whether this computer has opened the Document; a row without it counts as opened. */
  opened: z.boolean().optional(),
});
const searchResult = summary;
export type DocumentSummary = z.infer<typeof summary>;
export type DocumentSearchResult = z.infer<typeof searchResult>;
export const documents = {
  ...linkDocuments,
  recent: async (offset: number, includeSupport = false) =>
    z
      .array(summary)
      .parse(await invoke("recent_documents", { offset, includeSupport })),
  pins: async (offset: number) =>
    z.array(summary).parse(await invoke("pinned_documents", { offset })),
  search: async (
    query: string,
    tag: string | null,
    offset: number,
    includeSupport = false,
  ) =>
    z.array(searchResult).parse(
      await invoke("search_documents", {
        query,
        tag,
        offset,
        includeSupport,
      }),
    ),
  /** One Document's row: the same Plans, tickets and tags a list row carries. */
  summary: async (id: string) =>
    summary.parse(await invoke("document_summary", { id })),
  keep: async (id: string, requestId: string) =>
    schema.parse(await invoke("keep_document", { id, requestId })),
  pin: async (id: string, pinned: boolean) =>
    invoke("set_document_pin", { id, pinned }),
  tags: async (id: string) =>
    z.array(z.string()).parse(await invoke("document_tags", { id })),
  tag: async (id: string, tag: string, present: boolean) =>
    invoke("set_document_tag", { id, tag, present }),
  all: async (offset: number, includeSupport = false) =>
    z
      .array(summary)
      .parse(await invoke("all_documents", { offset, includeSupport })),
  trash: async (offset: number) =>
    z.array(summary).parse(await invoke("trashed_documents", { offset })),
  setTrashed: async (id: string, trashed: boolean, requestId: string) =>
    schema.parse(
      await invoke("set_document_trashed", { id, trashed, requestId }),
    ),
  show: async (id: string) =>
    schema.parse(await invoke("show_document", { id })),
  version: async (id: string) =>
    z
      .tuple([z.string(), z.boolean()])
      .parse(await invoke("document_version", { id })),
  open: async (id: string) =>
    schema.parse(await invoke("open_document", { id })),
  save: async (
    id: string | null,
    title: string | null,
    body: string | null,
    titleChanged: boolean,
    expectedUpdatedAt: string | null,
    requestId: string,
    /** The summary to store (empty clears it); leave it out to keep the stored one. */
    summary?: string,
  ) =>
    schema.parse(
      await invoke("save_document", {
        id,
        title,
        body,
        titleChanged,
        expectedUpdatedAt,
        requestId,
        summary,
      }),
    ),
};
