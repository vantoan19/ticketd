import { invoke } from "@/lib/api/bridge-failure";
import { z } from "zod";

const tokenSchema = z.number().int();

export const changesClient = {
  /** A number that moves whenever any workspace data changes, from any writer. */
  async token(): Promise<number> {
    return tokenSchema.parse(await invoke("workspace_change_token"));
  },
};
