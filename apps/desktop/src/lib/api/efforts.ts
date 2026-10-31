import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
const effortSchema = z.object({
  id: z.string(),
  name: z.string(),
  archived: z.boolean(),
});
const viewSchema = z.object({
  effort: effortSchema,
  counts: z.object({
    todo: z.number(),
    in_progress: z.number(),
    in_review: z.number(),
    done: z.number(),
    canceled: z.number(),
  }),
  members: z.array(
    z.object({
      reference: z.string(),
      title: z.string(),
      status: z.string(),
      project_id: z.string().nullable(),
    }),
  ),
});

export type Effort = z.infer<typeof effortSchema>;
export type View = z.infer<typeof viewSchema>;
export const effortsClient = {
  async list() {
    return z.array(effortSchema).parse(await invoke("list_efforts"));
  },
  async show(id: string) {
    return viewSchema.parse(await invoke("show_effort", { id }));
  },
  async create(name: string) {
    return effortSchema.parse(await invoke("create_effort", { name }));
  },
  async change(id: string, name: string | null, archived: boolean | null) {
    await invoke("change_effort", { id, name, archived });
  },
  async setMember(reference: string, effort: string | null) {
    await invoke("set_effort", { reference, effort });
  },
};
