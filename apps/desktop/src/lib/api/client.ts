import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const ticketSchema = z.object({
  id: z.string(),
  trashed: z.boolean(),
  reference: z.string(),
  title: z.string(),
  status: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  project_id: z.string().nullable(),
  effort_id: z.string().nullable(),
  availability: z.string().nullable(),
  parent: z
    .object({ reference: z.string(), title: z.string(), trashed: z.boolean() })
    .nullable(),
  children: z.array(
    z.object({
      reference: z.string(),
      title: z.string(),
      trashed: z.boolean(),
    }),
  ),
  prerequisites: z.array(
    z.object({
      reference: z.string(),
      title: z.string(),
      status: z.string(),
      trashed: z.boolean(),
    }),
  ),
});
const graphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      trashed: z.boolean(),
      reference: z.string(),
      title: z.string(),
      status: z.string(),
      availability: z.string().nullable(),
    }),
  ),
  edges: z.array(z.object({ blocker: z.string(), dependent: z.string() })),
  max_nodes: z.number(),
  max_depth: z.number(),
  truncated: z.boolean(),
});
export type DependencyGraph = z.infer<typeof graphSchema>;
const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  paths: z.array(z.string()),
});
export type Project = z.infer<typeof projectSchema>;
const noteSchema = z.object({
  id: z.string(),
  content: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  editing_agent: z.string().nullable(),
});
export type Note = z.infer<typeof noteSchema>;
export type Ticket = z.infer<typeof ticketSchema>;
export type FindFilter = {
  query: string;
  project: string | null;
  unlinked: boolean;
  effort: string | null;
  status: string | null;
  tags: string[];
  availability: string | null;
  family: string | null;
  limit: number;
  offset: number;
};
export const client = {
  async bulkStatus(references: string[], status: string, requestId: string) {
    return z
      .array(ticketSchema)
      .parse(await invoke("bulk_status", { references, status, requestId }));
  },
  async changeDependency(
    command: "add_dependency" | "remove_dependency",
    blocker: string,
    dependent: string,
  ) {
    await invoke(command, { blocker, dependent });
  },
  async searchTags(query: string) {
    return z.array(z.string()).parse(await invoke("search_tags", { query }));
  },
  async changeTag(
    command: "add_tag" | "remove_tag",
    reference: string,
    tag: string,
  ) {
    return ticketSchema.parse(await invoke(command, { reference, tag }));
  },
  async setEffort(reference: string, effort: string | null) {
    return ticketSchema.parse(
      await invoke("set_effort", { reference, effort }),
    );
  },
  async setParent(reference: string, parent: string | null) {
    await invoke("set_parent", { reference, parent });
  },
  async detachChild(child: string, parent: string) {
    await invoke("detach_child", { child, parent });
  },
  async backupWorkspace(path: string) {
    return z.string().parse(await invoke("backup_workspace", { path }));
  },
  async restoreWorkspace(path: string) {
    return z.string().parse(await invoke("restore_workspace", { path }));
  },
  async exportWorkspace(path: string) {
    await invoke("export_workspace", { path });
  },
  async dependencyGraph(reference: string) {
    return graphSchema.parse(await invoke("dependency_graph", { reference }));
  },
  async listEfforts() {
    return z
      .array(
        z.object({ id: z.string(), name: z.string(), archived: z.boolean() }),
      )
      .parse(await invoke("list_efforts"));
  },
  async listProjects() {
    return z.array(projectSchema).parse(await invoke("list_projects"));
  },
  async createProject(name: string, path: string) {
    return projectSchema.parse(await invoke("create_project", { name, path }));
  },
  async editProject(id: string, name: string, path: string) {
    return projectSchema.parse(
      await invoke("edit_project", { id, name, path }),
    );
  },
  async notes(reference: string, offset: number) {
    return z
      .array(noteSchema)
      .parse(await invoke("list_notes", { reference, limit: 50, offset }));
  },
  async addNote(reference: string, content: string) {
    return noteSchema.parse(await invoke("add_note", { reference, content }));
  },
  async editNote(reference: string, id: string, content: string) {
    return noteSchema.parse(
      await invoke("edit_note", { reference, id, patch: { content } }),
    );
  },
  async deleteNote(reference: string, id: string) {
    await invoke("delete_note", { reference, id });
  },
  async showTicket(reference: string) {
    return ticketSchema.parse(await invoke("show_ticket", { reference }));
  },
  async findTickets(filter: FindFilter) {
    return z
      .array(ticketSchema)
      .parse(await invoke("find_tickets", { filter }));
  },
  async listTickets() {
    return z.array(ticketSchema).parse(await invoke("list_tickets"));
  },
  async searchTickets(query: string, filter: string, offset: number) {
    return z.array(ticketSchema).parse(
      await invoke("search_tickets", {
        query,
        project: filter === "all" || filter === "unlinked" ? null : filter,
        unlinked: filter === "unlinked",
        limit: 50,
        offset,
      }),
    );
  },
  async listTrash() {
    return z.array(ticketSchema).parse(await invoke("list_trash"));
  },
  async setTrashed(reference: string, trashed: boolean) {
    return ticketSchema.parse(
      await invoke("set_trashed", { reference, trashed }),
    );
  },
  async registerCheckout(id: string, path: string) {
    return projectSchema.parse(await invoke("register_checkout", { id, path }));
  },
  async removeCheckout(id: string, path: string) {
    return projectSchema.parse(await invoke("remove_checkout", { id, path }));
  },
  async createTicket(
    title: string,
    body: string,
    status: string,
    projectId: string | null,
    effortId: string | null,
    tags: string[],
  ) {
    return ticketSchema.parse(
      await invoke("create_ticket", {
        title,
        body,
        status,
        projectId,
        effortId,
        tags,
      }),
    );
  },
  async changeTicket(
    reference: string,
    patch: {
      title?: string;
      body?: string;
      project_id?: string | null;
      status?: string;
    },
  ) {
    return ticketSchema.parse(
      await invoke("change_ticket", { reference, patch }),
    );
  },
};
