import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const ticketSchema = z.object({
  id: z.string(),
  reference: z.string(),
  title: z.string(),
  status: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  project_id: z.string().nullable(),
});
const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
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
export const client = {
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
  async listTickets() {
    return z.array(ticketSchema).parse(await invoke("list_tickets"));
  },
  async createTicket(title: string, projectId: string | null) {
    return ticketSchema.parse(
      await invoke("create_ticket", { title, projectId }),
    );
  },
  async changeTicket(
    reference: string,
    patch: { title?: string; body?: string; project_id?: string | null },
  ) {
    return ticketSchema.parse(
      await invoke("change_ticket", { reference, patch }),
    );
  },
};
