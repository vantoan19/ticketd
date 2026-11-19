import { invoke } from "@/lib/api/bridge-failure";
import { lazySchema } from "@/lib/api/lazy-schema";
import { z } from "zod";

const agentSkillSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    detected: z.boolean(),
    /** Null when the folder could not be read; `error` says why. */
    state: z
      .enum([
        "installed",
        "update_available",
        /** A newer ticketd wrote this copy; this build leaves it alone. */
        "newer",
        "not_installed",
        "edited",
        "other",
        "not_a_file",
      ])
      .nullable(),
    error: z.string().nullable(),
  }),
);

const installSchema = lazySchema(() =>
  z.object({ backup: z.string().nullable() }),
);

export type AgentSkill = z.infer<typeof agentSkillSchema>;

export const agentSkillsClient = {
  /** The ticketd skill's state in each supported agent's per-user skills folder. */
  async list(): Promise<AgentSkill[]> {
    return z.array(agentSkillSchema).parse(await invoke("agent_skills"));
  },
  /** Installs or updates the skill; `replace` saves an edited copy as a backup first. */
  async install(agent: string, replace: boolean) {
    return installSchema.parse(
      await invoke("install_agent_skill", { agent, replace }),
    );
  },
};
