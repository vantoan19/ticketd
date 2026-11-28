import { invoke } from "@/lib/api/bridge-failure";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";
import { graphSchema, ticketSchema } from "./client";
import { latestUpdateSchema } from "./progress";
const planSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    archived: z.boolean(),
    purpose: z.string().default(""),
  }),
);
const viewSchema = lazySchema(() =>
  z.object({
    plan: z.object({
      ...planSchema.shape,
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
    latest_updates: z.record(z.string(), latestUpdateSchema).default({}),
    members: z.array(
      z.object({
        id: ticketSchema.shape.id.optional(),
        reference: z.string(),
        title: z.string(),
        status: z.string(),
        project_id: z.string().nullable(),
        availability: z.string().nullable().default(null),
        prerequisites: ticketSchema.shape.prerequisites.default([]),
        parent: ticketSchema.shape.parent.default(null),
        children: ticketSchema.shape.children.default([]),
        updated_at: ticketSchema.shape.updated_at,
        latest_update: ticketSchema.shape.latest_update,
      }),
    ),
  }),
);

export type Plan = z.infer<typeof planSchema>;
export type View = z.infer<typeof viewSchema>;
export type PlanCounts = View["counts"];
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
  async show(id: string, limit?: number, offset = 0, includeMembers = true) {
    return viewSchema.parse(
      await invoke("show_plan", {
        id,
        ...(limit !== undefined && { limit, offset }),
        ...(!includeMembers && { includeMembers }),
      }),
    );
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
