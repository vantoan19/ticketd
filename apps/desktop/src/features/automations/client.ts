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
  /** The Automations with a step that runs it; it cannot be deleted while any does. */
  used_by: z.array(z.string()).default([]),
});
export type AutomationAgent = z.infer<typeof automationAgentSchema>;

/**
 * The trigger and step kinds this page can set up are spelled out. The others
 * the record can hold are kept as they arrive, so saving never drops them.
 */
const triggerSchema = z.union([
  z.object({ kind: z.literal("tag_added"), tag: z.string() }),
  z.looseObject({
    kind: z.enum([
      "ticket_created",
      "ticket_updated",
      "status_changed",
      "tag_removed",
      "activity_created",
      "schedule",
      "by_hand",
    ]),
  }),
]);
const stepSchema = z.union([
  z.looseObject({
    id: z.string(),
    kind: z.literal("run_agent"),
    agent_id: z.string().nullable(),
    execution_folder: z.string().nullable(),
  }),
  z.looseObject({
    id: z.string(),
    kind: z.enum(["change_ticket", "notify", "if"]),
  }),
]);
export type AutomationStep = z.infer<typeof stepSchema>;

const automationDefinitionSchema = z.object({
  name: z.string(),
  /** null until the person chooses what starts it. */
  trigger: triggerSchema.nullable(),
  conditions: z.array(z.unknown()),
  /** In the order they run. */
  steps: z.array(stepSchema),
});
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;

const automationSchema = automationDefinitionSchema.extend({
  id: z.string(),
  /** On for this device. */
  enabled: z.boolean(),
  /** It was synced from another desktop and has not been turned on here since. */
  arrived_off: z.boolean(),
  /**
   * Why it cannot be switched on yet, in the order the steps run. `step_id` is
   * the unfinished step, "trigger", or null for the Automation as a whole.
   */
  problems: z.array(
    z.object({ step_id: z.string().nullable(), message: z.string() }),
  ),
});
export type Automation = z.infer<typeof automationSchema>;

const automationRunSchema = z.object({
  id: z.string(),
  status: z.enum([
    "queued",
    "running",
    "completed",
    "needs_attention",
    "taken_over",
  ]),
  /** Why it needs attention. */
  reason: z.string().nullable(),
  /** The ticket it acts on, as it is called now. */
  ticket: z
    .object({ id: z.string(), reference: z.string(), title: z.string() })
    .nullable(),
  created_at: z.string(),
});
export type AutomationRun = z.infer<typeof automationRunSchema>;

/** What is sent back on a save: the Automation without what the core derives. */
export function definitionOf(automation: Automation): AutomationDefinition {
  return automationDefinitionSchema.parse(automation);
}

/** The harnesses by the names people know them by. */
export const HARNESS_NAMES = {
  "claude-code": "Claude Code",
  codex: "Codex",
} as const;

export const automationsClient = {
  async automations(): Promise<Automation[]> {
    return z.array(automationSchema).parse(await invoke("automation_list"));
  },
  /** A new Automation starts empty and off, and is edited in place. */
  async createAutomation(): Promise<Automation> {
    return automationSchema.parse(await invoke("automation_create"));
  },
  /** Replaces the whole definition: renaming and reshaping are the same edit. */
  async updateAutomation(
    id: string,
    definition: AutomationDefinition,
  ): Promise<Automation> {
    return automationSchema.parse(
      await invoke("automation_update", { id, definition }),
    );
  },
  async deleteAutomation(id: string): Promise<void> {
    await invoke("automation_delete", { id });
  },
  /** On or off for this device only. */
  async setAutomationEnabled(
    id: string,
    enabled: boolean,
  ): Promise<Automation> {
    return automationSchema.parse(
      await invoke("automation_set_enabled", { id, enabled }),
    );
  },
  /** An Automation's runs on this desktop, newest first. */
  async runs(automationId: string): Promise<AutomationRun[]> {
    return z
      .array(automationRunSchema)
      .parse(await invoke("automation_run_list", { automationId }));
  },
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
