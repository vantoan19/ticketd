import type { AgentSkill } from "@/lib/api/agent-skills";
import type { AgentUpdate } from "@/lib/api/client";
import type { CliStatus } from "@/lib/api/cli";
import type { NotificationPermission } from "@/lib/api/notifications";
import type { SourceEntry } from "@/lib/api/sources";
import type { SyncStatus } from "@/lib/sync-api";
import type { GithubIntegration } from "@/lib/api/github";
import {
  commandLineFix,
  type CommandLineFix,
} from "@/features/settings/command-line-state";

/**
 * What Set up ticketd needs to know, read from this computer. `null` (or
 * `undefined` for the agent update) means the read is not back yet: a step
 * never ticks from something unread.
 */
export interface SetupReadings {
  cli: CliStatus | null;
  skills: AgentSkill[] | null;
  /** The first update an agent wrote; `null` once read and there is none. */
  agentUpdate: AgentUpdate | null | undefined;
  /** The connections ticketd offers, saved or not; `null` while unread. */
  sources: readonly SourceEntry[] | null;
  github?: GithubIntegration | null;
  sync: SyncStatus | null;
  notifications: NotificationPermission | null;
}

export const SETUP_STEP_IDS = [
  "agents",
  "agent-update",
  "sources",
  "sync",
  "notifications",
] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/** What the first step's one button does. */
export type AgentsAction =
  /** Installs the command, if it needs it, then the skill for each agent that needs it. */
  | {
      kind: "install";
      label: string;
      fix: CommandLineFix | null;
      skills: AgentSkill[];
    }
  /** What this page cannot repair: another page can say why. */
  | { kind: "open"; label: string; page: "command-line" | "agent-skills" };

export interface SetupStep {
  id: SetupStepId;
  title: string;
  /** Only the first two are needed; the rest can wait or be hidden. */
  optional: boolean;
  /** False until everything the step reads is back. */
  settled: boolean;
  done: boolean;
  /** The fact it leaves behind when done, else the one sentence about what to do. */
  description: string;
  /** The first step's button, while it is not done. */
  agentsAction?: AgentsAction | undefined;
}

export interface SetupState {
  steps: SetupStep[];
  /** How many steps are ticked. */
  done: number;
  /** Every step is read, and every one is ticked. */
  complete: boolean;
  /** The step to do now: the first of the two needed ones that is not done. */
  current: SetupStepId | null;
}

/** "Claude Code", "Claude Code and Codex", "Claude Code, Codex and Antigravity". */
export function joinNames(names: readonly string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** An agent's name as it signs its writes, said the way the app names it. */
export function agentDisplayName(name: string) {
  switch (name.trim().toLowerCase()) {
    case "claude":
    case "claude-code":
    case "claude code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "antigravity":
    case "agy":
      return "Antigravity";
    default:
      return name;
  }
}

/** The agent already has the ticketd skill, in this app's version or a newer one. */
function hasSkill(agent: AgentSkill) {
  return (
    agent.state === "installed" ||
    agent.state === "newer" ||
    agent.state === "update_available"
  );
}

/** A copy ticketd leaves alone, or a folder it could not read. */
function needsLook(agent: AgentSkill) {
  return (
    agent.state === null ||
    agent.state === "edited" ||
    agent.state === "other" ||
    agent.state === "not_a_file"
  );
}

/** What the one install writes for an agent: a missing skill, or an old one. */
function installable(agent: AgentSkill) {
  return (
    agent.state === "update_available" ||
    (agent.state === "not_installed" && agent.detected)
  );
}

/** An agent can run `ticketd` by name and it is this app's, on this Workspace. */
export function commandReady(cli: CliStatus) {
  return (
    cli.found &&
    cli.on_path &&
    cli.version !== null &&
    commandLineFix(cli) === null &&
    cli.version_matches !== false &&
    cli.workspace_matches !== false
  );
}

function agentsStep(
  cli: CliStatus | null,
  skills: AgentSkill[] | null,
): SetupStep {
  const base = {
    id: "agents" as const,
    title: "Agents can use ticketd",
    optional: false,
  };
  if (!cli || !skills)
    return {
      ...base,
      settled: false,
      done: false,
      description: "",
    };
  const found = skills.filter((agent) => agent.detected);
  const names = joinNames(found.map((agent) => agent.name));
  const ready = commandReady(cli);
  const looks = found.filter(needsLook);
  const missing = found.filter((agent) => !hasSkill(agent));
  if (ready && missing.length === 0)
    return {
      ...base,
      settled: true,
      done: true,
      description:
        found.length === 0
          ? "The ticketd command is on your PATH."
          : `${names} ${found.length === 1 ? "has" : "have"} the ticketd command and skill.`,
    };
  const fix = commandLineFix(cli);
  const pending = skills.filter(installable);
  const action = (agentsAction: AgentsAction, description: string) => ({
    ...base,
    settled: true,
    done: false,
    description,
    agentsAction,
  });
  if (fix || pending.length > 0) {
    const forNames = joinNames(
      (pending.length > 0 ? pending : found).map((agent) => agent.name),
    );
    const one = pending.length === 1;
    const what =
      fix && pending.length > 0
        ? `the command and ${one ? "its skill" : "their skills"}`
        : fix
          ? "the command"
          : one
            ? "its skill"
            : "their skills";
    // Only the macOS install asks for a password.
    const asks = fix !== null && cli.bundled?.platform === "macos";
    return action(
      {
        kind: "install",
        label:
          pending.length > 0 || found.length > 0
            ? `Install for ${forNames}`
            : "Install the command",
        fix,
        skills: pending,
      },
      found.length > 0
        ? `Found ${names}. Installs ${what}${asks ? "; your Mac asks for your password once." : "."}`
        : `No agent found yet. Installs the command${asks ? ". Your Mac asks for your password once." : "."}`,
    );
  }
  // Nothing here can repair it: say which page can.
  if (!ready)
    return action(
      { kind: "open", label: "Command line", page: "command-line" },
      "Agents can’t run ticketd yet. Command line says why.",
    );
  return action(
    { kind: "open", label: "Agent skills", page: "agent-skills" },
    `ticketd left the skill for ${joinNames(looks.map((agent) => agent.name))} as it is.`,
  );
}

function agentUpdateStep(update: AgentUpdate | null | undefined): SetupStep {
  const base = {
    id: "agent-update" as const,
    title: "An agent has picked up a ticket",
    optional: false,
  };
  if (update === undefined)
    return { ...base, settled: false, done: false, description: "" };
  if (update === null)
    return {
      ...base,
      settled: true,
      done: false,
      description:
        "Paste this into Claude Code or Codex, then wait for its first update.",
    };
  // The day reads as every other date in the app does, in the person's locale.
  const day = new Date(update.reported_at);
  return {
    ...base,
    settled: true,
    done: true,
    description: `${agentDisplayName(update.editing_agent)} updated ${update.reference}${
      Number.isNaN(day.getTime())
        ? "."
        : ` on ${day.toLocaleDateString(undefined, { day: "numeric", month: "short" })}.`
    }`,
  };
}

function sourcesFact(
  connected: readonly SourceEntry[],
  githubConnected: boolean,
) {
  const providers = new Map<string, { name: string; count: number }>();
  for (const { connector } of connected) {
    const known = providers.get(connector.provider);
    if (known) known.count += 1;
    else providers.set(connector.provider, { name: connector.name, count: 1 });
  }
  const parts = [...providers.values()].map(({ name, count }) =>
    count > 1 ? `${name}, ${count} connections` : name,
  );
  if (githubConnected) parts.unshift("GitHub, through your gh login");
  return `${joinNames(parts)}.`;
}

function sourcesStep(
  sources: readonly SourceEntry[] | null,
  github: GithubIntegration | null | undefined,
): SetupStep {
  const base = {
    id: "sources" as const,
    title: "Bring in GitHub or Linear issues",
    optional: true,
  };
  if (!sources)
    return { ...base, settled: false, done: false, description: "" };
  const connected = sources.filter(
    (entry) => entry.connector.provider !== "github" && entry.saved !== null,
  );
  const githubConnected =
    github?.repositories.some(({ repository }) =>
      github.hosts.some(
        ({ host, state }) =>
          state === "connected" &&
          repository.toLowerCase().startsWith(`${host.toLowerCase()}/`),
      ),
    ) ?? false;
  if (connected.length === 0 && !githubConnected)
    return {
      ...base,
      settled: true,
      done: false,
      description: "Issues arrive as tickets. GitHub uses your gh login.",
    };
  return {
    ...base,
    settled: true,
    done: true,
    description: sourcesFact(connected, githubConnected),
  };
}

function syncStep(sync: SyncStatus | null): SetupStep {
  const base = {
    id: "sync" as const,
    title: "Keep it on your other computers",
    optional: true,
  };
  if (!sync) return { ...base, settled: false, done: false, description: "" };
  if (sync.connection !== "connected")
    return {
      ...base,
      settled: true,
      done: false,
      description:
        "The same Workspace everywhere, through your own Google Drive or S3.",
    };
  return {
    ...base,
    settled: true,
    done: true,
    description: `Synced through ${sync.provider === "s3" ? "S3" : "Google Drive"}.`,
  };
}

function notificationsStep(
  permission: NotificationPermission | null,
): SetupStep {
  const base = {
    id: "notifications" as const,
    title: "Get notified when a Chat or reminder needs you",
    optional: true,
  };
  if (!permission)
    return { ...base, settled: false, done: false, description: "" };
  if (permission.state === "allowed")
    return {
      ...base,
      settled: true,
      done: true,
      description: "Notifications are allowed.",
    };
  return {
    ...base,
    settled: true,
    done: false,
    description:
      permission.state === "blocked"
        ? "Off for ticketd in System Settings."
        : "Reminders and Chats reach you while you work elsewhere.",
  };
}

/**
 * The five steps of Set up ticketd, each ticked from what is true on this
 * computer now. The page, the sidebar row and the first-run guide read this
 * one value, so none of them can tick a step another would not.
 */
export function deriveSetup(readings: SetupReadings): SetupState {
  const steps = [
    agentsStep(readings.cli, readings.skills),
    agentUpdateStep(readings.agentUpdate),
    sourcesStep(readings.sources, readings.github),
    syncStep(readings.sync),
    notificationsStep(readings.notifications),
  ];
  const done = steps.filter((step) => step.done).length;
  const current =
    steps.find((step) => !step.optional && !step.done)?.id ?? null;
  return {
    steps,
    done,
    complete: steps.every((step) => step.settled && step.done),
    current,
  };
}

/** One step of a derived state, by id. */
export function setupStep(state: SetupState, id: SetupStepId): SetupStep {
  const step = state.steps.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`Unknown setup step ${id}`);
  return step;
}
