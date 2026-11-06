import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

export type MarkdownExportSource =
  | { kind: "document"; id: string }
  | { kind: "ticket"; reference: string }
  | { kind: "markdown"; body: string };

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
      display_name: z.string(),
      original_filename: z.string().nullable(),
      path: z.string().nullable(),
      external_url: z.string().nullable(),
      omission: z.string().nullable(),
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
