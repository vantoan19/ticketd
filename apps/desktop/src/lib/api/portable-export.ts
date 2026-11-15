import { invoke } from "@/lib/api/bridge-failure";
import { z } from "zod";
import { driveCopyStatusSchema } from "./attachments";

export type MarkdownExportSource =
  | { kind: "document"; id: string }
  | { kind: "ticket"; reference: string }
  | { kind: "markdown"; body: string }
  | { kind: "selection"; body: string; context: string };

const resultSchema = z.object({
  format_version: z.literal(1),
  status: z.enum(["complete", "partial"]),
  directory: z.string(),
  markdown_path: z.string(),
  manifest_path: z.string(),
  attachments: z.array(
    z.object({
      uri: z.string(),
      attachment_id: z.string().nullable(),
      kind: z
        .enum(["local_snapshot", "external_reference", "uploaded_copy"])
        .nullable()
        .optional(),
      display_name: z.string(),
      original_filename: z.string().nullable(),
      path: z.string().nullable(),
      external_url: z.string().nullable(),
      omission: z.string().nullable(),
      copy_status: driveCopyStatusSchema.nullable().optional(),
    }),
  ),
});
export type MarkdownExport = z.infer<typeof resultSchema>;

export async function exportMarkdown(
  source: MarkdownExportSource,
  output: string,
) {
  return resultSchema.parse(
    await invoke("export_markdown_with_files", { source, output }),
  );
}
