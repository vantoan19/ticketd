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
export const documents = {
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
