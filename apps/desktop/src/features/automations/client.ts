import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const limitSchema = z.number().int().positive();

export const automationAgentSettingsSchema = z.object({
  name: z.string(),
  /** The harness as the Chat host names it. */
  harness: z.enum(["claude-code", "codex"]),
  /** null is the harness's own default model. */
  model: z.string().nullable(),
  instructions: z.string(),
  tools: z.object({
    read_files: z.boolean(),
    edit_files: z.boolean(),
    run_commands: z.boolean(),
    /** With `run_commands`, the only commands allowed; empty allows any. */
    allowed_commands: z.array(z.string()),
    use_web: z.boolean(),
  }),
  turn_limit: limitSchema,
  time_limit_minutes: limitSchema,
});
export type AutomationAgentSettings = z.infer<
  typeof automationAgentSettingsSchema
>;

const automationAgentSchema = automationAgentSettingsSchema.extend({
  id: z.string(),
});
export type AutomationAgent = z.infer<typeof automationAgentSchema>;

export const automationsClient = {
  async agents(): Promise<AutomationAgent[]> {
    return z
      .array(automationAgentSchema)
      .parse(await invoke("automation_agent_list"));
  },
  /** A new agent starts from the core's defaults and is edited in place. */
  async createAgent(): Promise<AutomationAgent> {
    return automationAgentSchema.parse(await invoke("automation_agent_create"));
  },
  async updateAgent(
    id: string,
    settings: AutomationAgentSettings,
  ): Promise<AutomationAgent> {
    return automationAgentSchema.parse(
      await invoke("automation_agent_update", { id, settings }),
    );
  },
  async deleteAgent(id: string): Promise<void> {
    await invoke("automation_agent_delete", { id });
  },
};
