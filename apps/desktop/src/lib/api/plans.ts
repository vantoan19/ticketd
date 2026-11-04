import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { graphSchema } from "./client";
const planSchema = z.object({
  id: z.string(),
  name: z.string(),
  archived: z.boolean(),
  purpose: z.string().default(""),
});
const viewSchema = z.object({
  plan: planSchema.extend({
    spec_document_id: z.string().nullable().default(null),
  }),
  documents: z
    .array(
      z.object({ id: z.string(), heading: z.string(), trashed: z.boolean() }),
    )
    .default([]),
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
      availability: z.string().nullable().default(null),
    }),
  ),
});

export type Plan = z.infer<typeof planSchema>;
export type View = z.infer<typeof viewSchema>;
export const plansClient = {
  async setDocument(planId: string, documentId: string, present: boolean) {
    await invoke("set_plan_document", {
      planId,
      documentId,
      present,
      requestId: crypto.randomUUID(),
    });
  },
  async setSpec(planId: string, documentId: string | null) {
    await invoke("set_plan_spec", {
      planId,
      documentId,
      requestId: crypto.randomUUID(),
    });
  },
  async graph(id: string) {
    return graphSchema.parse(await invoke("plan_dependency_graph", { id }));
  },
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
