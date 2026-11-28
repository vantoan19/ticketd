import { expect, test, vi } from "vitest";
import { githubIntegration } from "@/test/source-fixtures";
import type { AgentSkill } from "@/lib/api/agent-skills";
import type { CliStatus } from "@/lib/api/cli";
import type { SourceEntry } from "@/lib/api/sources";
import type { SyncStatus } from "@/lib/sync-api";
import {
  deriveSetup,
  setupStep,
  type SetupReadings,
} from "@/features/setup/setup-state";

const cli = (overrides: Partial<CliStatus> = {}): CliStatus => ({
  found: true,
  on_path: true,
  path: "/usr/local/bin/ticketd",
  version: "0.2.0",
  version_matches: true,
  workspace_path: "/w/workspace.sqlite3",
  workspace_matches: true,
  app_version: "0.2.0",
  app_workspace_path: "/w/workspace.sqlite3",
  suggested_directory: "/usr/local/bin",
  bundled: { platform: "macos", installed: true, in_the_way: null },
  ...overrides,
});

const missingCli = cli({
  found: false,
  on_path: false,
  path: null,
  version: null,
  version_matches: null,
  workspace_path: null,
  workspace_matches: null,
  bundled: { platform: "macos", installed: false, in_the_way: null },
});

const skill = (
  id: string,
  name: string,
  state: AgentSkill["state"],
  detected = true,
): AgentSkill => ({
  id,
  name,
  path: `~/.${id}/skills/ticketd`,
  detected,
  state,
  error: null,
});

const ready = [
  skill("claude-code", "Claude Code", "installed"),
  skill("codex", "Codex", "installed"),
];

/** Everything read and nothing done: a computer where setup has not started. */
const fresh: SetupReadings = {
  cli: missingCli,
  skills: [
    skill("claude-code", "Claude Code", "not_installed"),
    skill("codex", "Codex", "not_installed"),
  ],
  agentUpdate: null,
  sources: [],
  sync: null,
  notifications: { state: "not_asked", reported: true, settings: true },
};

const source = (provider: string, name: string): SourceEntry =>
  ({
    connector: { provider, name, schema: { fields: [] } },
    saved: { provider, config: {}, account: "a", saved_at: "2026-11-25" },
  }) as unknown as SourceEntry;

const synced = (provider: "google_drive" | "s3" = "google_drive") =>
  ({ connection: "connected", provider }) as SyncStatus;

test("nothing read yet ticks nothing and finishes nothing", () => {
  const state = deriveSetup({
    cli: null,
    skills: null,
    agentUpdate: undefined,
    sources: null,
    sync: null,
    notifications: null,
  });
  expect(state.steps.map((step) => step.done)).toEqual([
    false,
    false,
    false,
    false,
    false,
  ]);
  expect(state.steps.every((step) => !step.settled)).toBe(true);
  expect(state.complete).toBe(false);
});

test("step 1 needs the command on PATH and the skill in every agent found", () => {
  const step = (readings: Partial<SetupReadings>) =>
    setupStep(deriveSetup({ ...fresh, ...readings }), "agents");
  expect(step({ cli: cli(), skills: ready }).done).toBe(true);
  // The skill without the command it calls: the old guide ticked here.
  expect(step({ cli: missingCli, skills: ready }).done).toBe(false);
  expect(step({ cli: cli({ on_path: false }), skills: ready }).done).toBe(
    false,
  );
  // The command without the skill in one agent found.
  expect(
    step({
      cli: cli(),
      skills: [ready[0]!, skill("codex", "Codex", "not_installed")],
    }).done,
  ).toBe(false);
  // An agent that is not installed here does not hold it back.
  expect(
    step({
      cli: cli(),
      skills: [ready[0]!, skill("codex", "Codex", "not_installed", false)],
    }).done,
  ).toBe(true);
  // An older skill is still a skill; another version of the command is not this app's.
  expect(
    step({
      cli: cli(),
      skills: [skill("claude-code", "Claude Code", "update_available")],
    }).done,
  ).toBe(true);
  expect(
    step({ cli: cli({ version_matches: false }), skills: ready }).done,
  ).toBe(false);
  expect(
    step({ cli: cli({ workspace_matches: false }), skills: ready }).done,
  ).toBe(false);
});

test("step 1 says what its button installs and when the Mac asks for a password", () => {
  const step = setupStep(deriveSetup(fresh), "agents");
  expect(step.description).toBe(
    "Found Claude Code and Codex. Installs the command and their skills; your Mac asks for your password once.",
  );
  expect(step.agentsAction).toMatchObject({
    kind: "install",
    label: "Install for Claude Code and Codex",
  });
  const skillsOnly = setupStep(deriveSetup({ ...fresh, cli: cli() }), "agents");
  expect(skillsOnly.description).toBe(
    "Found Claude Code and Codex. Installs their skills.",
  );
  const commandOnly = setupStep(
    deriveSetup({ ...fresh, skills: ready }),
    "agents",
  );
  expect(commandOnly.description).toBe(
    "Found Claude Code and Codex. Installs the command; your Mac asks for your password once.",
  );
  expect(commandOnly.agentsAction).toMatchObject({
    kind: "install",
    label: "Install for Claude Code and Codex",
  });
  const linux = setupStep(
    deriveSetup({
      ...fresh,
      cli: cli({
        found: false,
        on_path: false,
        bundled: { platform: "linux", installed: false, in_the_way: null },
      }),
      skills: ready,
    }),
    "agents",
  );
  // On Linux the package puts the command there: this page has nothing to run.
  expect(linux.agentsAction).toMatchObject({
    kind: "open",
    page: "command-line",
  });
});

test("step 1 sends a copy it must not touch to Agent skills", () => {
  const step = setupStep(
    deriveSetup({
      ...fresh,
      cli: cli(),
      skills: [
        skill("claude-code", "Claude Code", "edited"),
        skill("codex", "Codex", "installed"),
      ],
    }),
    "agents",
  );
  expect(step.done).toBe(false);
  expect(step.agentsAction).toMatchObject({
    kind: "open",
    page: "agent-skills",
  });
});

test("step 1 when it is done names the agents it covers", () => {
  const done = (skills: AgentSkill[]) =>
    setupStep(deriveSetup({ ...fresh, cli: cli(), skills }), "agents")
      .description;
  expect(done(ready)).toBe(
    "Claude Code and Codex have the ticketd command and skill.",
  );
  expect(done([ready[1]!])).toBe("Codex has the ticketd command and skill.");
});

test("step 2 ticks on the first update an agent wrote, and says which and when", () => {
  expect(setupStep(deriveSetup(fresh), "agent-update").done).toBe(false);
  const step = setupStep(
    deriveSetup({
      ...fresh,
      agentUpdate: {
        reference: "T-KQ27",
        editing_agent: "codex",
        reported_at: "2026-11-25T10:00:00Z",
      },
    }),
    "agent-update",
  );
  expect(step.done).toBe(true);
  expect(step.description).toMatch(/^Codex updated T-KQ27 on /);
});

test("step 2 names the day in the app's own date format, not a fixed locale", () => {
  const dates = vi.spyOn(Date.prototype, "toLocaleDateString");
  setupStep(
    deriveSetup({
      ...fresh,
      agentUpdate: {
        reference: "T-KQ27",
        editing_agent: "codex",
        reported_at: "2026-11-25T10:00:00Z",
      },
    }),
    "agent-update",
  );
  expect(dates).toHaveBeenCalledWith(undefined, expect.anything());
  dates.mockRestore();
});

test("step 3 names an extension connection even when gh is signed in without import rules", () => {
  const github = { ...githubIntegration(), repositories: [] };
  expect(
    setupStep(
      deriveSetup({ ...fresh, github, sources: [source("linear", "Linear")] }),
      "sources",
    ).description,
  ).toBe("Linear.");
});

test("steps 3 to 5 tick from GitHub issue import, sync and the system's permission", () => {
  const state = deriveSetup({
    ...fresh,
    github: githubIntegration(),
    sync: synced("s3"),
    notifications: { state: "allowed", reported: true, settings: true },
  });
  expect(setupStep(state, "sources").description).toBe(
    "GitHub, through your gh login.",
  );
  expect(setupStep(state, "sync").description).toBe("Synced through S3.");
  expect(setupStep(state, "notifications").done).toBe(true);
  // A connector that was never saved is not a connection.
  const unsaved = {
    connector: { provider: "linear", name: "Linear" },
    saved: null,
  } as unknown as SourceEntry;
  expect(
    setupStep(deriveSetup({ ...fresh, sources: [unsaved] }), "sources").done,
  ).toBe(false);
  // Blocked, or not connected, is not done.
  expect(
    setupStep(
      deriveSetup({
        ...fresh,
        sync: { connection: "choosing" } as SyncStatus,
        notifications: { state: "blocked", reported: true, settings: true },
      }),
      "sync",
    ).done,
  ).toBe(false);
});

test("the count, the step to do now, and when it is complete", () => {
  expect(deriveSetup(fresh).done).toBe(0);
  expect(deriveSetup(fresh).current).toBe("agents");
  const agentsReady = deriveSetup({ ...fresh, cli: cli(), skills: ready });
  expect(agentsReady.done).toBe(1);
  expect(agentsReady.current).toBe("agent-update");
  const required = deriveSetup({
    ...fresh,
    cli: cli(),
    skills: ready,
    agentUpdate: {
      reference: "T-KQ27",
      editing_agent: "codex",
      reported_at: "2026-11-25T10:00:00Z",
    },
  });
  // Only optional steps remain: nothing is "current".
  expect(required.current).toBeNull();
  expect(required.complete).toBe(false);
  const all = deriveSetup({
    cli: cli(),
    skills: ready,
    agentUpdate: {
      reference: "T-KQ27",
      editing_agent: "codex",
      reported_at: "2026-11-25T10:00:00Z",
    },
    sources: [source("linear", "Linear")],
    sync: synced(),
    notifications: { state: "allowed", reported: true, settings: true },
  });
  expect(all.done).toBe(5);
  expect(all.complete).toBe(true);
});
