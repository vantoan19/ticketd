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
});
export const documents = {
  linkMarkdown: async (reference: string) =>
    z.string().parse(await invoke("context_link_markdown", { reference })),
  links: async (id: string) =>
    z
      .tuple([z.array(linkSchema), z.array(linkSchema)])
      .parse(await invoke("document_context_links", { id })),
  createTicket: async (id: string, title: string, requestId: string) =>
    z
      .object({ reference: z.string() })
      .parse(await invoke("ticket_from_document", { id, title, requestId })),
  recent: async () => z.array(schema).parse(await invoke("recent_documents")),
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
