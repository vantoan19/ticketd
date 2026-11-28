import { invoke } from "@/lib/api/bridge-failure";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";
import { ticketStatuses } from "@/lib/statuses";
import { attachmentSchema } from "./attachments";
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
    status_since: z
      .record(z.string(), z.iso.datetime({ offset: true }))
      .default({}),
    pull_request: z.string().nullable().default(null),
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

const activitySchema = lazySchema(() => {
  const common = {
    reference: z.string(),
    title: z.string(),
    timestamp: z.iso.datetime({ offset: true }),
    editing_agent: z.string().nullable(),
  };
  const status = z.enum(ticketStatuses);
  return z.array(
    z.discriminatedUnion("kind", [
      z.object({
        ...common,
        kind: z.literal("status"),
        from: status,
        to: status,
      }),
      z.object({ ...common, kind: z.literal("joined") }),
      z.object({ ...common, kind: z.literal("update"), brief: z.string() }),
    ]),
  );
});

const filesSchema = lazySchema(() =>
  z.array(
    z.object({
      reference: z.string(),
      title: z.string(),
      status: z.enum(ticketStatuses),
      files: z.array(attachmentSchema).min(1),
    }),
  ),
);

export type Plan = z.infer<typeof planSchema>;
export type View = z.infer<typeof viewSchema>;
export type PlanCounts = View["counts"];
export type PlanActivity = z.infer<typeof activitySchema>[number];
export type PlanTicketFiles = z.infer<typeof filesSchema>[number];
export const plansClient = {
  async files(id: string) {
    return filesSchema.parse(await invoke("plan_files", { id }));
  },
  async openPullRequest(id: string, url: string) {
    await invoke("open_plan_pull_request", { id, url });
  },
  async activity(id: string, limit: number) {
    return activitySchema.parse(await invoke("plan_activity", { id, limit }));
  },
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
