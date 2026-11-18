import { invoke } from "@/lib/api/bridge-failure";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";

export const latestUpdateSchema = lazySchema(() =>
  z.object({
    activity_id: z.string(),
    brief: z.object({ text: z.string(), truncated: z.boolean() }),
    reported_at: z.string(),
    updated_at: z.string(),
    editing_agent: z.string().nullable(),
    supporting_document_id: z.string().nullable(),
  }),
);
export type LatestUpdate = z.infer<typeof latestUpdateSchema>;
export async function latestUpdate(
  reference: string,
): Promise<LatestUpdate | null> {
  return latestUpdateSchema
    .nullable()
    .parse(await invoke("latest_update", { reference }));
}
