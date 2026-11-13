import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { FlowList } from "@/features/automations/canvas-layout";
import { ticketStatuses } from "@/lib/statuses";

const limitSchema = z.number().int().positive();
const statusSchema = z.enum(ticketStatuses);

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
  z.object({
    kind: z.enum(["ticket_created", "ticket_updated", "activity_created"]),
  }),
  z.object({
    kind: z.literal("status_changed"),
    /** null until chosen; the Automation cannot be switched on without it. */
    to: statusSchema.nullable(),
    /** null is any status. */
    from: statusSchema.nullable(),
  }),
  z.object({ kind: z.enum(["tag_added", "tag_removed"]), tag: z.string() }),
  z.looseObject({ kind: z.enum(["schedule", "by_hand"]) }),
]);
export type AutomationTrigger = z.infer<typeof triggerSchema>;

/** `source` holds provider ids ("github") and "local". */
const conditionSchema = z.union([
  z.object({
    kind: z.enum(["project", "source"]),
    any_of: z.array(z.string()),
  }),
  z.object({ kind: z.literal("tag"), tag: z.string(), has: z.boolean() }),
]);
export type AutomationCondition = z.infer<typeof conditionSchema>;
/** What an If asks of the ticket. `project_id` null is "No project". */
const checkSchema = z.union([
  z.object({ kind: z.literal("tag"), tag: z.string(), has: z.boolean() }),
  z.object({
    kind: z.literal("status"),
    status: statusSchema,
    is: z.boolean(),
  }),
  z.object({
    kind: z.literal("project"),
    project_id: z.string().nullable(),
    is: z.boolean(),
  }),
]);
export type AutomationCheck = z.infer<typeof checkSchema>;
const stepSchema = z.union([
  z.looseObject({
    id: z.string(),
    kind: z.literal("run_agent"),
    agent_id: z.string().nullable(),
    execution_folder: z.string().nullable(),
  }),
  z.looseObject({
    id: z.string(),
    kind: z.literal("change_ticket"),
    /** null until the person chooses what it changes. */
    change: z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("add_tag"), tag: z.string() }),
        z.object({ action: z.literal("remove_tag"), tag: z.string() }),
        z.object({ action: z.literal("set_status"), status: statusSchema }),
        /** `text` may hold field references; see `automation-text.ts`. */
        z.object({ action: z.literal("post_update"), text: z.string() }),
      ])
      .nullable(),
  }),
  z.looseObject({
    id: z.string(),
    kind: z.literal("notify"),
    /** May hold field references, like a posted update. */
    text: z.string(),
    /** What a click on the notification opens. */
    opens: z.enum(["ticket", "run"]),
  }),
  /** Its Yes and No paths are read with `stepPaths`, like a failure path. */
  z.looseObject({
    id: z.string(),
    kind: z.literal("if"),
    /** Every one must pass; with none the Automation cannot be switched on. */
    checks: z.array(checkSchema),
  }),
]);
export type AutomationStep = z.infer<typeof stepSchema>;
export type StepChange = NonNullable<
  Extract<AutomationStep, { kind: "change_ticket" }>["change"]
>;

const automationDefinitionSchema = z.object({
  name: z.string(),
  /** null until the person chooses what starts it. */
  trigger: triggerSchema.nullable(),
  /** Narrow the trigger; every one must match. */
  conditions: z.array(conditionSchema),
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
  automation_id: z.string(),
  status: z.enum([
    "queued",
    "running",
    "completed",
    "needs_attention",
    "taken_over",
  ]),
  /** Why it needs attention. */
  reason: z.string().nullable(),
  /**
   * It ended as Needs attention and the person has not yet run it again, taken
   * it over or dismissed it.
   */
  needs_you: z.boolean(),
  /** The ticket it acts on, as it is called now. */
  ticket: z
    .object({ id: z.string(), reference: z.string(), title: z.string() })
    .nullable(),
  created_at: z.string(),
});
export type AutomationRun = z.infer<typeof automationRunSchema>;

/** A run in the list of every run: with the Automation it belongs to. */
const listedRunSchema = automationRunSchema.extend({
  automation_id: z.string(),
  /** The Automation as it is called now. */
  automation_name: z.string(),
});
export type ListedRun = z.infer<typeof listedRunSchema>;

/** The examples the empty page offers, as the core names them. */
export type AutomationExample =
  "triage_tagged_tickets" | "verify_ready_for_testing" | "weekly_summary";
/** A run as its ticket lists it: with the name of the Automation it ran. */
const ticketRunSchema = automationRunSchema.extend({
  automation_name: z.string(),
});
export type TicketRun = z.infer<typeof ticketRunSchema>;

/** A run as its own view shows it: what it executes, and each step it reached. */
const automationRunDetailSchema = automationRunSchema.extend({
  /** The Automation as it was when the run was created. */
  definition: automationDefinitionSchema,
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  /** The steps reached so far, in the order they ran. */
  steps: z.array(
    z.object({
      step_id: z.string(),
      status: z.enum(["running", "completed", "failed"]),
      /** Why it failed, in plain words. */
      reason: z.string().nullable(),
      /** The Chat of a Run agent step. */
      chat_id: z.string().nullable(),
      /** The run still owns that Chat: replying in it takes the run over. */
      chat_owned: z.boolean(),
      started_at: z.string(),
      ended_at: z.string().nullable(),
    }),
  ),
});
export type AutomationRunDetail = z.infer<typeof automationRunDetailSchema>;

const stepPathsSchema = z.object({
  yes: z.array(stepSchema).optional(),
  no: z.array(stepSchema).optional(),
  on_failure: z.array(stepSchema).nullish(),
});
/**
 * The lists of steps under a step: an If's two paths, or the path taken when
 * the step fails. A step keeps them as they arrive; this reads them.
 */
export function stepPaths(step: AutomationStep): {
  yes?: AutomationStep[] | undefined;
  no?: AutomationStep[] | undefined;
  on_failure?: AutomationStep[] | null | undefined;
} {
  return stepPathsSchema.parse(step);
}

/**
 * `steps` with `edit` applied to the flow's own list and to every list under a
 * step, at any depth. `edit` is told which list it has; a list it makes is
 * walked in turn.
 */
export function editSteps(
  steps: AutomationStep[],
  edit: (list: AutomationStep[], owner?: FlowList) => AutomationStep[],
  owner?: FlowList,
): AutomationStep[] {
  return edit(steps, owner).map((step) => {
    const { yes, no, on_failure } = stepPaths(step);
    const under = (path: FlowList["path"], list: AutomationStep[]) =>
      editSteps(list, edit, { step: step.id, path });
    return {
      ...step,
      ...(yes && { yes: under("yes", yes) }),
      ...(no && { no: under("no", no) }),
      ...(on_failure && { on_failure: under("failure", on_failure) }),
    };
  });
}

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
  /**
   * One of the examples, as an Automation that is off. A step whose agent does
   * not exist yet comes back unfinished, saying so.
   */
  async createExample(example: AutomationExample): Promise<Automation> {
    return automationSchema.parse(
      await invoke("automation_create_example", { example }),
    );
  },
  /** A copy of an Automation, off. */
  async duplicateAutomation(id: string): Promise<Automation> {
    return automationSchema.parse(await invoke("automation_duplicate", { id }));
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
  /**
   * "Stop it and turn off": off for this device, with its runs in progress
   * ended as Needs attention.
   */
  async stopAndTurnOff(id: string): Promise<Automation> {
    return automationSchema.parse(
      await invoke("automation_stop_and_turn_off", { id }),
    );
  },
  /** How many runs execute at once on this desktop. */
  async runsAtOnce(): Promise<number> {
    return limitSchema.parse(await invoke("automation_runs_at_once"));
  },
  async setRunsAtOnce(runs: number): Promise<void> {
    await invoke("set_automation_runs_at_once", { runs });
  },
  /** Whether the system starts ticketd when the person signs in. */
  async startsAtLogin(): Promise<boolean> {
    return z.boolean().parse(await invoke("start_at_login"));
  },
  async setStartsAtLogin(enabled: boolean): Promise<void> {
    await invoke("set_start_at_login", { enabled });
  },
  /** An Automation's runs on this desktop, newest first. */
  async runs(automationId: string): Promise<AutomationRun[]> {
    return z
      .array(automationRunSchema)
      .parse(await invoke("automation_run_list", { automationId }));
  },
  /** The runs of every Automation on this desktop, newest first. */
  async allRuns(): Promise<ListedRun[]> {
    return z
      .array(listedRunSchema)
      .parse(await invoke("automation_run_list_all"));
  },
  /**
   * A step's text with its fields filled in from the most recent ticket, and
   * `tag` for the tag from the event. null while the Workspace has no ticket.
   */
  async previewText(text: string, tag: string | null): Promise<string | null> {
    return z
      .string()
      .nullable()
      .parse(await invoke("automation_text_preview", { text, tag }));
  },
  async run(id: string): Promise<AutomationRunDetail> {
    return automationRunDetailSchema.parse(
      await invoke("automation_run_get", { id }),
    );
  },
  /** Ends a run in progress as Needs attention. */
  async stopRun(id: string): Promise<AutomationRunDetail> {
    return automationRunDetailSchema.parse(
      await invoke("automation_run_stop", { id }),
    );
  },
  /**
   * Queues a new run for the event that started a finished one, which then no
   * longer needs the person.
   */
  async runAgain(id: string): Promise<AutomationRunDetail> {
    return automationRunDetailSchema.parse(
      await invoke("automation_run_again", { id }),
    );
  },
  /** The person wants nothing more from a run that needs attention. */
  async dismissRun(id: string): Promise<void> {
    await invoke("automation_run_dismiss", { id });
  },
  /** The runs that acted on a ticket, newest first. */
  async ticketRuns(reference: string): Promise<TicketRun[]> {
    return z
      .array(ticketRunSchema)
      .parse(await invoke("automation_run_list_for_ticket", { reference }));
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
