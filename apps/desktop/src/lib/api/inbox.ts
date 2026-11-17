import { invoke } from "@/lib/api/bridge-failure";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";

const entrySchema = lazySchema(() =>
  z.object({
    id: z.number(),
    reference: z.string(),
    title: z.string(),
    kind: z.string(),
    from_value: z.string(),
    to_value: z.string(),
    timestamp: z.string(),
    read: z.boolean(),
    deleted: z.boolean().optional(),
    editing_agent: z
      .string()
      .nullish()
      .transform((agent) => agent ?? null),
  }),
);

export type Entry = z.infer<typeof entrySchema>;

export const inboxClient = {
  async list(options: { offset: number; limit: number; unreadOnly: boolean }) {
    return z.array(entrySchema).parse(await invoke("inbox", options));
  },
  async setRead(
    ids: number[],
    read: boolean,
    requestId: string = crypto.randomUUID(),
  ) {
    await invoke("set_inbox_read", {
      ids,
      read,
      requestId,
    });
  },
  async reminder(reference: string) {
    return z
      .string()
      .nullable()
      .parse(await invoke("reminder", { reference }));
  },
  async snooze(
    reference: string,
    dueAt: string | null,
    requestId: string = crypto.randomUUID(),
  ) {
    await invoke("set_reminder", {
      reference,
      dueAt,
      requestId,
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
