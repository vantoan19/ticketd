import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
const planSchema = z.object({
  id: z.string(),
  name: z.string(),
  archived: z.boolean(),
  purpose: z.string().default(""),
});
const viewSchema = z.object({
  plan: planSchema,
  counts: z.object({
    todo: z.number(),
    in_progress: z.number(),
    in_review: z.number(),
    done: z.number(),
    canceled: z.number(),
    duplicate: z.number().default(0),
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

export type Plan = z.infer<typeof planSchema>;
export type View = z.infer<typeof viewSchema>;
export const plansClient = {
  async show(id: string) {
    return viewSchema.parse(await invoke("show_plan", { id }));
  },
  async create(name: string) {
    return planSchema.parse(await invoke("create_plan", { name }));
  },
  async change(id: string, name: string | null, archived: boolean | null) {
    await invoke("change_plan", { id, name, archived });
  },
  async setPurpose(id: string, purpose: string) {
    await invoke("set_plan_purpose", { id, purpose });
  },
  async setMember(reference: string, plan: string | null) {
    await invoke("set_plan", { reference, plan });
  },
};
