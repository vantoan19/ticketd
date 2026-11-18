import { invoke } from "@/lib/api/bridge-failure";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";

const countSchema = lazySchema(() => z.number().int().nonnegative());
const sidebarCountsSchema = lazySchema(() =>
  z.object({
    unread_inbox: countSchema,
    total: countSchema.optional(),
    ready: countSchema,
    in_progress: countSchema,
    /** Automation runs that need attention and have not been acted on. */
    runs_needing_you: countSchema.optional(),
  }),
);

export type SidebarCounts = z.infer<typeof sidebarCountsSchema>;

export const countsClient = {
  async sidebar(): Promise<SidebarCounts> {
    return sidebarCountsSchema.parse(await invoke("sidebar_counts"));
  },
};
