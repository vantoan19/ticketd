import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { z } from "zod";

const attachmentSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  original_filename: z.string(),
  size_bytes: z.number().nonnegative(),
  kind: z.literal("local_snapshot"),
  locator: z.string(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

const draftRetentionSchema = z.object({
  owner: z.string(),
  kind: z.enum(["draft", "undo"]),
  revision: z.number().int().nonnegative(),
  payload: z.unknown().nullable(),
  markdown: z.array(z.string()),
});
export type DraftRetention = z.infer<typeof draftRetentionSchema>;

export const draftRetention = {
  async cutoverPending() {
    return z.boolean().parse(await invoke("draft_cutover_pending"));
  },
  async completeCutover() {
    await invoke("complete_draft_cutover");
  },
  async list() {
    return z
      .array(draftRetentionSchema)
      .parse(await invoke("draft_retentions"));
  },
  async retain(draft: DraftRetention) {
    return draftRetentionSchema.parse(await invoke("retain_draft", { draft }));
  },
};

export const attachments = {
  async usage(id: string) {
    return z
      .object({
        eligible: z.boolean(),
        legacy_drafts_pending: z.boolean(),
        protections: z.array(
          z.object({
            kind: z.string(),
            owner: z.string(),
            ticket_id: z.string().nullable(),
            trashed: z.boolean(),
          }),
        ),
      })
      .parse(await invoke("attachment_usage", { id }));
  },
  async uri(id: string) {
    return z.string().parse(await invoke("attachment_uri", { id }));
  },
  async resolve(uri: string) {
    return attachmentSchema.parse(
      await invoke("resolve_attachment_uri", { uri }),
    );
  },
  async forTicket(reference: string) {
    return z
      .array(attachmentSchema)
      .parse(await invoke("ticket_attachments", { reference }));
  },
  async recent() {
    return z
      .array(attachmentSchema)
      .parse(await invoke("list_attachments", { limit: 50, offset: 0 }));
  },
  async inspect(id: string) {
    return attachmentSchema.parse(await invoke("inspect_attachment", { id }));
  },
  async chooseFile() {
    const chosen = await open({
      title: "Attach file",
      directory: false,
      multiple: false,
    });
    return typeof chosen === "string" ? chosen : null;
  },
  async upload(source: string, requestId: string) {
    return attachmentSchema.parse(
      await invoke("import_attachment", { source, requestId }),
    );
  },
  async setTicket(
    reference: string,
    attachmentId: string,
    present: boolean,
    requestId: string,
  ) {
    await invoke("set_ticket_attachment", {
      reference,
      attachmentId,
      present,
      requestId,
    });
  },
  async open(id: string) {
    await invoke("open_attachment", { id });
  },
  async export(file: Attachment) {
    const destination = await save({
      title: "Export file",
      defaultPath: file.original_filename,
    });
    if (destination)
      await invoke("export_attachment", { id: file.id, destination });
  },
};
