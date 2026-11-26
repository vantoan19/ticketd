// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SyncStatusContext } from "@/features/sync/sync-status";
import { SettingsNav } from "@/features/settings/SettingsNav";
import { SettingsView } from "@/features/settings/SettingsView";
import { SettingsStateProvider } from "@/features/settings/settings-state";
import type { SettingsPageId } from "@/features/settings/settings-sections";
import { ChatFeatureContext } from "@/features/chats/use-chats";
import { SetupActionsContext } from "@/features/setup/setup-actions";
import { agentSkillsClient, type AgentSkill } from "@/lib/api/agent-skills";
import { client } from "@/lib/api/client";
import { cliClient, type CliStatus } from "@/lib/api/cli";
import { notificationClient } from "@/lib/api/notifications";
import { sourcesClient } from "@/lib/api/sources";
import { workspaceClient } from "@/lib/api/workspace";
import { resetNotificationPermission } from "@/lib/notification-permission";
import { loadPreferences } from "@/lib/preferences";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";
import type { SyncStatus } from "@/lib/sync-api";
import { githubSource } from "@/test/source-fixtures";

const coffee = vi.hoisted(() => ({ url: null as string | null }));
vi.mock("@/lib/support-links", () => ({
  REPOSITORY_URL: "https://github.com/vantoan19/ticketd",
  get BUY_ME_A_COFFEE_URL() {
    return coffee.url;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(104857600),
}));
vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { info: vi.fn(), openLink: vi.fn() },
}));
vi.mock("@/lib/api/cli", () => ({
  cliClient: { check: vi.fn(), install: vi.fn(), installInUserBin: vi.fn() },
}));
vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn(), install: vi.fn() },
}));
vi.mock("@/lib/api/notifications", () => ({
  notificationClient: {
    permission: vi.fn(),
    ask: vi.fn(),
    openSettings: vi.fn(),
    notify: vi.fn(),
  },
}));
vi.mock("@/lib/api/client", () => ({
  client: {
    firstAgentUpdate: vi.fn(),
    findTicketRows: vi.fn(),
    exportWorkspace: vi.fn(),
  },
}));
vi.mock("@/lib/api/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/sources")>()),
  sourcesClient: {
    list: vi.fn(),
    checkConnection: vi.fn(),
    configurationSummary: vi.fn(),
    repositoryRoutes: vi.fn().mockResolvedValue([]),
    options: vi.fn(),
    preview: vi.fn(),
    save: vi.fn(),
  },
}));

const withCommand: CliStatus = {
  found: true,
  on_path: true,
  path: "/usr/local/bin/ticketd",
  version: "0.2.0",
  version_matches: true,
  workspace_path: "/w",
  workspace_matches: true,
  app_version: "0.2.0",
  app_workspace_path: "/w",
  suggested_directory: "/usr/local/bin",
  bundled: { platform: "macos", installed: true, in_the_way: null },
};
const noCommand: CliStatus = {
  ...withCommand,
  found: false,
  on_path: false,
  path: null,
  version: null,
  version_matches: null,
  workspace_path: null,
  workspace_matches: null,
  bundled: { platform: "macos", installed: false, in_the_way: null },
};
const skill = (
  id: string,
  name: string,
  state: AgentSkill["state"],
): AgentSkill => ({
  id,
  name,
  path: `~/.${id}/skills/ticketd`,
  detected: true,
  state,
  error: null,
});
const skillsReady = [
  skill("claude-code", "Claude Code", "installed"),
  skill("codex", "Codex", "installed"),
];
const skillsMissing = [
  skill("claude-code", "Claude Code", "not_installed"),
  skill("codex", "Codex", "not_installed"),
];
const agentUpdate = {
  reference: "T-KQ27",
  editing_agent: "codex",
  reported_at: "2026-11-25T10:00:00Z",
};
const connectedSource = {
  ...githubSource,
  saved: {
    id: "github",
    name: "GitHub",
    provider: "github",
    config: {},
    account: "octo",
    saved_at: "2026-01-01T00:00:00Z",
  },
};
const synced = {
  connection: "connected",
  provider: "google_drive",
} as SyncStatus;
const allowed = { state: "allowed", reported: true, settings: true } as const;

/** Settings as the app mounts it, with the sync status the shell would hold. */
function Settings({
  initial = "setup",
  sync = null,
  revision = 0,
  chats = false,
}: {
  initial?: SettingsPageId;
  sync?: SyncStatus | null;
  revision?: number;
  chats?: boolean;
}) {
  const [selected, setSelected] = useState<SettingsPageId>(initial);
  return (
    <WorkspaceChangeProvider value={revision}>
      <ChatFeatureContext.Provider
        value={{
          enabled: chats,
          setEnabled: async () => {},
          overview: { needs_you: 0, unread: 0, app_icon: 0, working: 0 },
          revision: 0,
          openRequest: null,
          chatRequest: null,
          requestChat: () => {},
        }}
      >
        <SyncStatusContext.Provider
          value={{
            status: sync,
            apply: () => {},
            refresh: () => Promise.reject(new Error("unused")),
            openSettings: () => {},
            openReview: () => {},
          }}
        >
          <SettingsStateProvider onOpenPage={setSelected}>
            <SettingsNav
              selected={selected}
              onSelect={setSelected}
              onBack={() => {}}
            />
            <SettingsView
              selected={selected}
              onSelect={setSelected}
              onRestore={async () => {}}
            />
          </SettingsStateProvider>
        </SyncStatusContext.Provider>
      </ChatFeatureContext.Provider>
    </WorkspaceChangeProvider>
  );
}

beforeEach(() => {
  resetNotificationPermission();
  coffee.url = null;
  vi.mocked(cliClient.check).mockResolvedValue(withCommand);
  vi.mocked(agentSkillsClient.list).mockResolvedValue(skillsReady);
  vi.mocked(client.firstAgentUpdate).mockResolvedValue(null);
  vi.mocked(client.findTicketRows).mockResolvedValue([
    { reference: "T-KQ27" },
  ] as never);
  vi.mocked(sourcesClient.list).mockResolvedValue([]);
  vi.mocked(notificationClient.permission).mockResolvedValue({
    state: "not_asked",
    reported: true,
    settings: true,
  });
  vi.mocked(workspaceClient.openLink).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

const nav = () => screen.getByRole("complementary", { name: "Settings" });
const setupRow = () => within(nav()).queryByRole("button", { name: /^Set up/ });
const step = (title: RegExp | string) =>
  screen
    .getByText(title, { selector: ".font-medium" })
    .closest("[data-slot=step]") as HTMLElement;
const settle = () => act(async () => {});

test("every step ticks from what is true on this computer, and the row counts them", async () => {
  vi.mocked(client.firstAgentUpdate).mockResolvedValue(agentUpdate);
  vi.mocked(sourcesClient.list).mockResolvedValue([connectedSource]);
  vi.mocked(notificationClient.permission).mockResolvedValue(allowed);
  render(<Settings sync={synced} />);
  await settle();
  const steps = screen
    .getAllByRole("listitem")
    .filter((item) => item.getAttribute("data-slot") === "step");
  expect(steps.map((item) => item.getAttribute("data-state"))).toEqual([
    "done",
    "done",
    "done",
    "done",
    "done",
  ]);
  expect(step("Agents can use ticketd").textContent).toContain(
    "Claude Code and Codex have the ticketd command and skill.",
  );
  expect(step("An agent has picked up a ticket").textContent).toMatch(
    /Codex updated T-KQ27 on /,
  );
  expect(step(/^Bring in GitHub or Linear issues/).textContent).toContain(
    "GitHub, through your gh login.",
  );
  expect(step(/^Keep it on your other computers/).textContent).toContain(
    "Synced through Google Drive.",
  );
  expect(step(/^Get notified/).textContent).toContain(
    "Notifications are allowed.",
  );
  expect(setupRow()?.textContent).toBe("Set up ticketd 5 of 5");
  // Finished: the page reads as a summary with one quiet line, and no Hide.
  expect(screen.queryByRole("button", { name: "Hide checklist" })).toBeNull();
  expect(screen.getByText(/ticketd is free and open source/).textContent).toBe(
    "ticketd is free and open source. If it helps you, Star on GitHub.",
  );
});

test("the finished line opens the repository, and Buy me a coffee only once the maintainer has a name", async () => {
  vi.mocked(client.firstAgentUpdate).mockResolvedValue(agentUpdate);
  vi.mocked(sourcesClient.list).mockResolvedValue([connectedSource]);
  vi.mocked(notificationClient.permission).mockResolvedValue(allowed);
  coffee.url = "https://buymeacoffee.com/maintainer";
  render(<Settings sync={synced} />);
  await settle();
  expect(screen.getByText(/ticketd is free and open source/).textContent).toBe(
    "ticketd is free and open source. If it helps you, Star on GitHub or Buy me a coffee.",
  );
  fireEvent.click(screen.getByRole("link", { name: "Star on GitHub" }));
  expect(workspaceClient.openLink).toHaveBeenCalledWith(
    "https://github.com/vantoan19/ticketd",
  );
  fireEvent.click(screen.getByRole("link", { name: "Buy me a coffee" }));
  expect(workspaceClient.openLink).toHaveBeenLastCalledWith(
    "https://buymeacoffee.com/maintainer",
  );
});

test("step 2 names the newest Ready ticket in a prompt to copy, once agents can use ticketd", async () => {
  render(<Settings />);
  await settle();
  const second = step("An agent has picked up a ticket");
  expect(second.getAttribute("data-state")).toBe("current");
  expect(second.textContent).toContain(
    "Paste this into Claude Code or Codex, then wait for its first update.",
  );
  expect(
    within(second).getByText(
      "Use ticketd to pick up T-KQ27, then post an update on it.",
    ),
  ).toBeTruthy();
  expect(
    within(second).getByRole("button", { name: "Copy the prompt" }),
  ).toBeTruthy();
  expect(client.findTicketRows).toHaveBeenCalledWith(
    expect.objectContaining({
      availability: "Ready",
      order: "Newest",
      limit: 1,
    }),
  );
  expect(setupRow()?.textContent).toBe("Set up ticketd 1 of 5");
});

test("with no ticket yet, step 2 offers New ticket, and Start a Chat while Chats are on", async () => {
  vi.mocked(client.findTicketRows).mockResolvedValue([]);
  const newTicket = vi.fn();
  const startChat = vi.fn();
  render(
    <SetupActionsContext.Provider
      value={{ newTicket, startChat, newTicketDisabledReason: null }}
    >
      <Settings chats />
    </SetupActionsContext.Provider>,
  );
  await settle();
  const second = step("An agent has picked up a ticket");
  expect(
    within(second).queryByRole("button", { name: "Copy the prompt" }),
  ).toBeNull();
  fireEvent.click(within(second).getByRole("button", { name: "New ticket" }));
  expect(newTicket).toHaveBeenCalledWith(expect.any(HTMLButtonElement));
  fireEvent.click(within(second).getByRole("button", { name: "Start a Chat" }));
  expect(startChat).toHaveBeenCalledTimes(1);
});

test("step 2 ticks on the first update an agent writes, while Settings is open", async () => {
  const { rerender } = render(<Settings revision={0} />);
  await settle();
  expect(
    step("An agent has picked up a ticket").getAttribute("data-state"),
  ).toBe("current");
  vi.mocked(client.firstAgentUpdate).mockResolvedValue(agentUpdate);
  rerender(<Settings revision={1} />);
  await settle();
  expect(
    step("An agent has picked up a ticket").getAttribute("data-state"),
  ).toBe("done");
  expect(setupRow()?.textContent).toBe("Set up ticketd 2 of 5");
});

test("step 1 never ticks while the command is missing, though the skills are there", async () => {
  vi.mocked(cliClient.check).mockResolvedValue(noCommand);
  render(<Settings />);
  await settle();
  const first = step("Agents can use ticketd");
  expect(first.getAttribute("data-state")).toBe("current");
  expect(first.textContent).toContain(
    "Found Claude Code and Codex. Installs the command; your Mac asks for your password once.",
  );
});

test("one button installs the command and every skill, and the password is asked once", async () => {
  const order: string[] = [];
  let status = noCommand;
  let skills = skillsMissing;
  vi.mocked(cliClient.check).mockImplementation(async () => status);
  vi.mocked(agentSkillsClient.list).mockImplementation(async () => skills);
  vi.mocked(cliClient.install).mockImplementation(async () => {
    order.push("command");
    status = withCommand;
    return {
      outcome: "installed",
      directory: "/usr/local/bin",
      next_step: null,
    };
  });
  vi.mocked(agentSkillsClient.install).mockImplementation(async (agent) => {
    order.push(agent);
    skills = skillsReady;
    return { backup: null };
  });
  render(<Settings />);
  await settle();
  const first = step("Agents can use ticketd");
  expect(first.textContent).toContain(
    "Installs the command and their skills; your Mac asks for your password once.",
  );
  fireEvent.click(
    within(first).getByRole("button", {
      name: "Install for Claude Code and Codex",
    }),
  );
  await waitFor(() =>
    expect(step("Agents can use ticketd").getAttribute("data-state")).toBe(
      "done",
    ),
  );
  expect(order).toEqual(["command", "claude-code", "codex"]);
  expect(cliClient.install).toHaveBeenCalledTimes(1);
  expect(cliClient.install).toHaveBeenCalledWith(null);
  // The check after the install re-reads PATH.
  expect(cliClient.check).toHaveBeenLastCalledWith(true);
  expect(setupRow()?.textContent).toBe("Set up ticketd 1 of 5");
});

test("a declined password changes nothing, and offers the folder that needs none", async () => {
  vi.mocked(cliClient.check).mockResolvedValue(noCommand);
  vi.mocked(agentSkillsClient.list).mockResolvedValue(skillsMissing);
  vi.mocked(cliClient.install).mockResolvedValue({
    outcome: "declined",
    directory: "/Users/mira/.local/bin",
    next_step: null,
  });
  vi.mocked(cliClient.installInUserBin).mockResolvedValue({
    outcome: "installed",
    directory: "/Users/mira/.local/bin",
    next_step: "add_to_path",
  });
  vi.mocked(agentSkillsClient.install).mockResolvedValue({ backup: null });
  render(<Settings />);
  await settle();
  fireEvent.click(
    screen.getByRole("button", { name: "Install for Claude Code and Codex" }),
  );
  const instead = await screen.findByRole("button", {
    name: "Use ~/.local/bin instead",
  });
  expect(step("Agents can use ticketd").textContent).toContain(
    "Nothing changed. A link in your own folder needs no password.",
  );
  expect(agentSkillsClient.install).not.toHaveBeenCalled();
  fireEvent.click(instead);
  await waitFor(() =>
    expect(agentSkillsClient.install).toHaveBeenCalledTimes(2),
  );
  expect(cliClient.installInUserBin).toHaveBeenCalledTimes(1);
  expect(cliClient.install).toHaveBeenCalledTimes(1);
});

test("a skill that fails to install is reported, and the others still install", async () => {
  vi.mocked(cliClient.check).mockResolvedValue(withCommand);
  vi.mocked(agentSkillsClient.list).mockResolvedValue(skillsMissing);
  vi.mocked(agentSkillsClient.install).mockImplementation(async (agent) => {
    if (agent === "claude-code") throw new Error("permission denied");
    return { backup: null };
  });
  render(<Settings />);
  await settle();
  fireEvent.click(
    screen.getByRole("button", { name: "Install for Claude Code and Codex" }),
  );
  await waitFor(() =>
    expect(agentSkillsClient.install).toHaveBeenCalledTimes(2),
  );
  expect(cliClient.install).not.toHaveBeenCalled();
  expect(
    await within(step("Agents can use ticketd")).findByText(
      /install the skill for Claude Code/i,
    ),
  ).toBeTruthy();
});

test("a step un-ticks before the checklist is finished when its state breaks", async () => {
  render(<Settings />);
  await settle();
  expect(step("Agents can use ticketd").getAttribute("data-state")).toBe(
    "done",
  );
  vi.mocked(cliClient.check).mockResolvedValue(noCommand);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await settle();
  expect(step("Agents can use ticketd").getAttribute("data-state")).toBe(
    "current",
  );
  expect(setupRow()?.textContent).toBe("Set up ticketd 0 of 5");
});

test("step 5 asks for notifications here, once, and ticks", async () => {
  vi.mocked(client.firstAgentUpdate).mockResolvedValue(agentUpdate);
  vi.mocked(notificationClient.ask).mockResolvedValue(allowed);
  render(<Settings />);
  await settle();
  const last = step(/^Get notified/);
  // Only optional steps remain: their buttons are outline, not ghost.
  const button = within(last).getByRole("button", {
    name: "Allow notifications",
  });
  expect(button.getAttribute("data-variant")).toBe("outline");
  fireEvent.click(button);
  await waitFor(() =>
    expect(step(/^Get notified/).getAttribute("data-state")).toBe("done"),
  );
  expect(notificationClient.ask).toHaveBeenCalledTimes(1);
});

test("optional buttons are ghost while a required step waits, and each opens its page", async () => {
  vi.mocked(cliClient.check).mockResolvedValue(noCommand);
  render(<Settings />);
  await settle();
  const source = within(step(/^Bring in/)).getByRole("button", {
    name: "Add a source",
  });
  expect(source.getAttribute("data-variant")).toBe("ghost");
  fireEvent.click(source);
  expect(
    await screen.findByRole("heading", { level: 1, name: "Ticket sources" }),
  ).toBeTruthy();
});

test("Set up sync opens Workspace sync", async () => {
  vi.mocked(workspaceClient.info).mockResolvedValue({
    path: "/w/workspace.sqlite3",
    tickets: 1,
    projects: 0,
    active_plans: 0,
    documents: 0,
    size_bytes: 10,
    format_version: 20,
  });
  render(
    <Settings
      sync={
        { connection: "not_connected", provider: "google_drive" } as SyncStatus
      }
    />,
  );
  await settle();
  fireEvent.click(
    within(step(/^Keep it on your other computers/)).getByRole("button", {
      name: "Set up sync",
    }),
  );
  expect(
    await screen.findByRole("heading", { level: 1, name: "Workspace sync" }),
  ).toBeTruthy();
});

test("Hide checklist removes the row, and Search still finds the page", async () => {
  render(<Settings />);
  await settle();
  expect(setupRow()).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Hide checklist" }));
  expect(setupRow()).toBeNull();
  expect(loadPreferences().setupHidden).toBe(true);
  // The page stays, without the button that hid it.
  expect(
    screen.getByRole("heading", { level: 1, name: "Set up ticketd" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Hide checklist" })).toBeNull();
  for (const query of ["set up", "checklist", "onboarding"]) {
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search settings" }),
      { target: { value: query } },
    );
    const group = await screen.findByRole("region", { name: "Set up ticketd" });
    expect(
      within(group).getByRole("link", { name: /^Set up ticketd/ }),
    ).toBeTruthy();
  }
  // Choosing the result opens the page again.
  fireEvent.click(
    within(screen.getByRole("region", { name: "Set up ticketd" })).getByRole(
      "link",
    ),
  );
  expect(
    await screen.findByRole("heading", { level: 1, name: "Set up ticketd" }),
  ).toBeTruthy();
  expect(setupRow()).toBeNull();
});

test("once every step ticked, the row stays until Settings is closed and then leaves for good", async () => {
  vi.mocked(client.firstAgentUpdate).mockResolvedValue(agentUpdate);
  vi.mocked(sourcesClient.list).mockResolvedValue([connectedSource]);
  vi.mocked(notificationClient.permission).mockResolvedValue(allowed);
  const first = render(<Settings sync={synced} />);
  await settle();
  expect(loadPreferences().setupFinished).toBe(true);
  // Still there under the person's eyes.
  expect(setupRow()?.textContent).toBe("Set up ticketd 5 of 5");
  first.unmount();
  // Settings opened again: finished before it opened, so no row.
  render(<Settings sync={synced} initial="appearance" />);
  await settle();
  expect(setupRow()).toBeNull();
});

test("after finishing, a broken step goes to the pages that need it and never brings the row back", async () => {
  vi.mocked(client.firstAgentUpdate).mockResolvedValue(agentUpdate);
  vi.mocked(sourcesClient.list).mockResolvedValue([connectedSource]);
  vi.mocked(notificationClient.permission).mockResolvedValue(allowed);
  const first = render(<Settings sync={synced} />);
  await settle();
  first.unmount();
  vi.mocked(cliClient.check).mockResolvedValue(noCommand);
  render(<Settings sync={synced} initial="appearance" />);
  await settle();
  expect(setupRow()).toBeNull();
  expect(loadPreferences().setupFinished).toBe(true);
});
