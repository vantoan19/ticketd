import { Channel, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { z } from "zod";

export const attachmentSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  original_filename: z.string(),
  size_bytes: z.number().nonnegative().nullable(),
  kind: z.enum(["local_snapshot", "external_reference"]),
  locator: z.string(),
});
export type Attachment = z.infer<typeof attachmentSchema>;
export const attachmentUsageSchema = z.object({
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
});
export type AttachmentUsage = z.infer<typeof attachmentUsageSchema>;
export type AttachmentState = "all" | "in_use" | "unused";
const attachmentSearchResultSchema = z.object({
  attachment: attachmentSchema,
  usage: attachmentUsageSchema,
  related: z.boolean(),
});
export type AttachmentSearchResult = z.infer<
  typeof attachmentSearchResultSchema
>;
const progressSchema = z.object({
  copied: z.number().nonnegative(),
  total: z.number().nonnegative(),
});
export type UploadProgress = z.infer<typeof progressSchema>;
export type CaptureSource = string | File;

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

const driveReferenceSchema = z.object({
  connection_id: z.string(),
  metadata: z.object({
    id: z.string(),
    name: z.string(),
    mime_type: z.string(),
    size_bytes: z.number().nonnegative().nullable(),
    web_url: z.string(),
    resource_key: z.string().nullable(),
  }),
});
export type DriveReference = z.infer<typeof driveReferenceSchema>;

export const attachments = {
  async driveInfo(id: string) {
    return driveReferenceSchema.parse(await invoke("drive_reference", { id }));
  },
  async driveConfiguration() {
    return z
      .object({ configured: z.boolean(), message: z.string() })
      .parse(await invoke("drive_configuration"));
  },
  async selectDrive(operationId: string) {
    return z
      .object({
        files: z.array(attachmentSchema),
        failures: z.array(z.string()),
      })
      .parse(await invoke("select_drive_files", { operationId }));
  },
  async cancelDriveSelection(operationId: string) {
    await invoke("cancel_drive_selection", { operationId });
  },

  async search(query: {
    search: string;
    state: AttachmentState;
    ticket: string | null;
    limit: number;
    offset: number;
  }) {
    return z
      .array(attachmentSearchResultSchema)
      .parse(await invoke("search_attachments", { query }));
  },
  async rename(id: string, displayName: string, requestId: string) {
    return attachmentSchema.parse(
      await invoke("rename_attachment", { id, displayName, requestId }),
    );
  },
  async usage(id: string) {
    return attachmentUsageSchema.parse(
      await invoke("attachment_usage", { id }),
    );
  },
  async workspaceId() {
    return z
      .string()
      .min(1)
      .parse(await invoke("attachment_workspace_id"));
  },
  async uploadLimit() {
    return z
      .number()
      .int()
      .positive()
      .parse(await invoke("attachment_upload_limit"));
  },
  async setUploadLimit(bytes: number) {
    await invoke("set_attachment_upload_limit", { bytes });
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
      multiple: true,
    });
    return typeof chosen === "string" ? [chosen] : (chosen ?? []);
  },
  async upload(
    source: CaptureSource,
    requestId: string,
    onProgress: (value: UploadProgress) => void,
  ) {
    const progress = new Channel<unknown>();
    progress.onmessage = (value) => onProgress(progressSchema.parse(value));
    if (typeof source !== "string") {
      const limit = await attachments.uploadLimit();
      if (source.size > limit)
        throw new Error(
          `File exceeds the workspace upload limit of ${formatUploadLimit(limit)}. Change it in Settings > Attachments.`,
        );
      const bytes = new Uint8Array(await source.arrayBuffer());
      if (bytes.byteLength > limit)
        throw new Error(
          `File exceeds the workspace upload limit of ${formatUploadLimit(limit)}.`,
        );
      // Raw IPC avoids expanding screenshots into millions of JSON numbers.
      const metadata = JSON.stringify({
        filename: source.name,
        requestId,
        progress: progress.toJSON(),
      }).replace(
        /[\u007f-\uffff]/g,
        (character) =>
          `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
      return attachmentSchema.parse(
        await invoke("capture_attachment", bytes, {
          headers: { "x-ticketd-upload": metadata },
        }),
      );
    }
    return attachmentSchema.parse(
      await invoke("import_attachment", { source, requestId, progress }),
    );
  },
  async cancel(requestId: string) {
    await invoke("cancel_attachment_upload", { requestId });
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

function formatUploadLimit(bytes: number) {
  return `${bytes} bytes (${bytes / 1048576} MiB)`;
}
