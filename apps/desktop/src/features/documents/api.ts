import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const schema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  body: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  trashed: z.boolean(),
});
export type Document = z.infer<typeof schema>;
const summary = z.object({ id: z.string(), heading: z.string() });
const searchResult = summary.extend({ snippet: z.string() });
export type DocumentSummary = z.infer<typeof summary>;
export type DocumentSearchResult = z.infer<typeof searchResult>;
export const documents = {
  recent: async (offset: number) =>
    z.array(summary).parse(await invoke("recent_documents", { offset })),
  pins: async (offset: number) =>
    z.array(summary).parse(await invoke("pinned_documents", { offset })),
  search: async (query: string, tag: string | null, offset: number) =>
    z
      .array(searchResult)
      .parse(await invoke("search_documents", { query, tag, offset })),
  pin: async (id: string, pinned: boolean) =>
    invoke("set_document_pin", { id, pinned }),
  tags: async (id: string) =>
    z.array(z.string()).parse(await invoke("document_tags", { id })),
  tag: async (id: string, tag: string, present: boolean) =>
    invoke("set_document_tag", { id, tag, present }),
  trash: async () => z.array(schema).parse(await invoke("trashed_documents")),
  setTrashed: async (id: string, trashed: boolean, requestId: string) =>
    schema.parse(
      await invoke("set_document_trashed", { id, trashed, requestId }),
    ),
  show: async (id: string) =>
    schema.parse(await invoke("show_document", { id })),
  open: async (id: string) =>
    schema.parse(await invoke("open_document", { id })),
  save: async (
    id: string | null,
    title: string | null,
    body: string | null,
    titleChanged: boolean,
    requestId: string,
  ) =>
    schema.parse(
      await invoke("save_document", {
        id,
        title,
        body,
        titleChanged,
        requestId,
      }),
    ),
};
