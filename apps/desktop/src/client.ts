import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const ticketSchema = z.object({
  id: z.string(),
  reference: z.string(),
  title: z.string(),
  status: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
});
export type Ticket = z.infer<typeof ticketSchema>;
export const client = {
  async listTickets() {
    return z.array(ticketSchema).parse(await invoke("list_tickets"));
  },
  async createTicket(title: string) {
    return ticketSchema.parse(await invoke("create_ticket", { title }));
  },
  async changeTicket(
    reference: string,
    patch: { title?: string; body?: string },
  ) {
    return ticketSchema.parse(
      await invoke("change_ticket", { reference, patch }),
    );
  },
};
