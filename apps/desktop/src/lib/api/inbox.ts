import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const entrySchema = z.object({
  id: z.number(),
  reference: z.string(),
  title: z.string(),
  kind: z.string(),
  from_value: z.string(),
  to_value: z.string(),
  timestamp: z.string(),
  read: z.boolean(),
  editing_agent: z
    .string()
    .nullish()
    .transform((agent) => agent ?? null),
});

export type Entry = z.infer<typeof entrySchema>;

export const inboxClient = {
  async list(options: { offset: number; limit: number; unreadOnly: boolean }) {
    return z.array(entrySchema).parse(await invoke("inbox", options));
  },
  async setRead(ids: number[], read: boolean) {
    await invoke("set_inbox_read", {
      ids,
      read,
      requestId: crypto.randomUUID(),
    });
  },
  async snooze(reference: string, dueAt: string) {
    await invoke("set_reminder", {
      reference,
      dueAt,
      requestId: crypto.randomUUID(),
    });
  },
  async isFollowing(reference: string) {
    return z.boolean().parse(await invoke("is_following", { reference }));
  },
  async setFollowing(reference: string, following: boolean) {
    await invoke("set_following", {
      reference,
      following,
      requestId: crypto.randomUUID(),
    });
  },
};
