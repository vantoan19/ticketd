import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { z } from "zod";

const attachmentSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  original_filename: z.string(),
  size_bytes: z.number().nonnegative().nullable(),
  kind: z.enum(["local_snapshot", "external_reference"]),
  locator: z.string(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const attachments = {
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
