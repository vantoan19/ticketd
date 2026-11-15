// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChatFeatureContext } from "@/features/chats/use-chats";
import { SettingsView } from "@/features/settings/SettingsView";
import { SettingsNav } from "@/features/settings/SettingsNav";
import { SettingsStateProvider } from "@/features/settings/settings-state";
import type { SettingsPageId } from "@/features/settings/settings-sections";
import { cliClient, type CliStatus } from "@/lib/api/cli";
import { agentSkillsClient } from "@/lib/api/agent-skills";
import { sourcesClient, type SourceEntry } from "@/lib/api/sources";
import { workspaceClient } from "@/lib/api/workspace";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(104857600),
}));
vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: {
    info: vi.fn(),
    reveal: vi.fn(),
    openLink: vi.fn(),
    lastBackup: vi.fn(),
    chooseSavePath: vi.fn(),
    chooseBackupFile: vi.fn(),
    inspectBackup: vi.fn(),
    safetyBackups: vi.fn(),
  },
}));
vi.mock("@/lib/api/cli", () => ({ cliClient: { check: vi.fn() } }));
vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn(), install: vi.fn() },
}));
vi.mock("@/lib/api/notifications", () => ({
  notificationClient: {
    permitted: vi.fn(),
    requestPermission: vi.fn(),
    notify: vi.fn(),
  },
}));
vi.mock("@/lib/api/client", () => ({
  client: { backupWorkspace: vi.fn(), exportWorkspace: vi.fn() },
}));
vi.mock("@/lib/api/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/sources")>()),
  sourcesClient: {
    list: vi.fn(),
    checkConnection: vi.fn(),
    options: vi.fn(),
    preview: vi.fn(),
    save: vi.fn(),
  },
}));

const installed: CliStatus = {
  found: true,
  on_path: true,
  path: "/usr/local/bin/ticketd",
  version: "0.1.0",
  version_matches: true,
  workspace_path: "/w",
  workspace_matches: true,
  app_version: "0.1.0",
  app_workspace_path: "/w",
  suggested_directory: "~/.local/bin",
};

const github = (saved: boolean) =>
  ({
    connector: {
      provider: "github",
      name: "GitHub",
      contract_version: 1,
      capabilities: ["discover", "fetch"],
      schema: { fields: [] },
    },
    saved,
  }) as unknown as SourceEntry;

beforeEach(() => {
  vi.mocked(cliClient.check).mockResolvedValue(installed);
  vi.mocked(agentSkillsClient.list).mockResolvedValue([]);
  vi.mocked(sourcesClient.list).mockResolvedValue([]);
  vi.mocked(workspaceClient.info).mockResolvedValue({
    path: "/w/workspace.sqlite3",
    tickets: 1,
    projects: 1,
    active_plans: 0,
    documents: 0,
    size_bytes: 10,
    format_version: 20,
  });
  vi.mocked(workspaceClient.lastBackup).mockResolvedValue(null);
  vi.mocked(workspaceClient.safetyBackups).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** Settings as the app mounts it: one state, a nav and the page it selects. */
function Settings({ initial = "appearance" }: { initial?: SettingsPageId }) {
  const [selected, setSelected] = useState<SettingsPageId>(initial);
  return (
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
        onOpenInbox={() => {}}
      />
    </SettingsStateProvider>
  );
}

/** A nav entry by the start of its name; a dot adds its label to the name. */
const navItem = (name: string | RegExp) =>
  within(screen.getByRole("complementary", { name: "Settings" })).getByRole(
    "button",
    { name: typeof name === "string" ? new RegExp(`^${name}`) : name },
  );

test("the nav lists the groups and sections in order; Experimental is said on Chat's page, not in the nav", async () => {
  render(<Settings />);
  await act(async () => {});
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  const groups = within(nav)
    .getAllByRole("group")
    .map((group) => [
      group.getAttribute("aria-label"),
      Array.from(group.querySelectorAll("li button")).map((button) =>
        (button.textContent ?? "").replace("Experimental", ""),
      ),
    ]);
  expect(groups).toEqual([
    ["Preferences", ["Appearance", "Attention"]],
    ["Workspace", ["Location", "Attachments", "Backups", "Export"]],
    ["Agents", ["Command line", "Agent skills", "Chat"]],
    ["Connections", ["Google Drive"]],
    ["Help", ["Keyboard shortcuts", "About"]],
  ]);
  expect(navItem(/^Chat/).textContent).not.toContain("Experimental");
  expect(navItem("Appearance").getAttribute("aria-current")).toBe("page");
});

test("Automations is listed under Agents, after Chat, only while Chat is on", async () => {
  const agents = () =>
    within(screen.getByRole("group", { name: "Agents" }))
      .getAllByRole("button")
      .map((button) => (button.textContent ?? "").replace("Experimental", ""));
  const { unmount } = render(<Settings />);
  await act(async () => {});
  expect(agents()).toEqual(["Command line", "Agent skills", "Chat"]);
  unmount();

  render(
    <ChatFeatureContext
      value={{
        enabled: true,
        setEnabled: async () => {},
        overview: { needs_you: 0, unread: 0, app_icon: 0, working: 0 },
        revision: 0,
        openRequest: null,
        chatRequest: null,
        requestChat: () => {},
      }}
    >
      <Settings />
    </ChatFeatureContext>,
  );
  await act(async () => {});
  expect(agents()).toEqual([
    "Command line",
    "Agent skills",
    "Chat",
    "Automations",
  ]);
  fireEvent.click(navItem("Automations"));
  expect(
    screen.getByRole("heading", { level: 1, name: "Automations" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("navigation", { name: "Breadcrumb" }).textContent,
  ).toBe("AgentsAutomations");
});

test("choosing a section opens only its page and moves focus to its title", async () => {
  render(<Settings />);
  await act(async () => {});
  expect(
    screen.getByRole("heading", { level: 1, name: "Appearance" }),
  ).toBeTruthy();
  fireEvent.click(navItem("Backups"));
  const title = screen.getByRole("heading", { level: 1, name: "Backups" });
  expect(document.activeElement).toBe(title);
  expect(navItem("Backups").getAttribute("aria-current")).toBe("page");
  expect(navItem("Appearance").getAttribute("aria-current")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Appearance" })).toBeNull();
  expect(
    screen.getByRole("navigation", { name: "Breadcrumb" }).textContent,
  ).toBe("WorkspaceBackups");
});

test("the Needs setup dot is read at startup, so Settings opens with it already shown", async () => {
  vi.mocked(cliClient.check).mockResolvedValue({ ...installed, found: false });
  const view = render(
    <SettingsStateProvider active={false}>{null}</SettingsStateProvider>,
  );
  await act(async () => {});
  expect(cliClient.check).toHaveBeenCalledTimes(1);
  // Opening reads again; the dot stays while that reading is still out.
  vi.mocked(cliClient.check).mockReturnValue(new Promise(() => {}));
  view.rerender(
    <SettingsStateProvider active>
      <SettingsNav onBack={() => {}} />
    </SettingsStateProvider>,
  );
  expect(cliClient.check).toHaveBeenCalledTimes(2);
  expect(
    within(navItem("Command line")).getByRole("img", { name: "Needs setup" }),
  ).toBeTruthy();
});

test("Command line and Agent skills carry a Needs setup dot until they are set up", async () => {
  vi.mocked(cliClient.check).mockResolvedValue({ ...installed, found: false });
  vi.mocked(agentSkillsClient.list).mockResolvedValue([
    {
      id: "claude",
      name: "Claude Code",
      detected: true,
      state: "not_installed",
      path: "/s",
    },
  ] as never);
  render(<Settings />);
  await act(async () => {});
  expect(
    within(navItem("Command line")).getByRole("img", { name: "Needs setup" }),
  ).toBeTruthy();
  expect(
    within(navItem("Agent skills")).getByRole("img", { name: "Needs setup" }),
  ).toBeTruthy();
  expect(within(navItem("Attention")).queryByRole("img")).toBeNull();
});

test("a set-up command line shows no dot", async () => {
  render(<Settings />);
  await act(async () => {});
  expect(within(navItem("Command line")).queryByRole("img")).toBeNull();
});

test("a source with a saved configuration shows a Connected dot under Connections", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([github(true)]);
  render(<Settings />);
  await act(async () => {});
  expect(
    within(navItem("GitHub")).getByRole("img", { name: "Connected" }),
  ).toBeTruthy();
});

test("below 768px the nav is a sheet opened from the page name in the panel bar", async () => {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === "(max-width: 767px)",
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  render(<Settings />);
  await act(async () => {});
  // No strip of chips above the page: the nav waits in the sheet.
  expect(screen.queryByRole("complementary", { name: "Settings" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: /^Appearance, Settings sections/ }),
  );
  const sheet = await screen.findByRole("dialog", { name: "Settings" });
  fireEvent.click(within(sheet).getByRole("button", { name: /^Backups/ }));
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  expect(
    screen.getByRole("button", { name: /^Backups, Settings sections/ }),
  ).toBeTruthy();
});

function onPlatform(platform: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
}

test("on macOS only Cmd+F opens Search; Ctrl+F stays the terminal's forward-one-character", async () => {
  onPlatform("MacIntel");
  render(<Settings initial="about" />);
  await act(async () => {});
  fireEvent.keyDown(window, { key: "f", ctrlKey: true });
  expect(navItem(/Search settings/).getAttribute("aria-current")).toBeNull();
  fireEvent.keyDown(window, { key: "f", metaKey: true });
  expect(navItem(/Search settings/).getAttribute("aria-current")).toBe("page");
});

test("elsewhere only Ctrl+F opens Search; the Windows key does not", async () => {
  onPlatform("Win32");
  render(<Settings initial="about" />);
  await act(async () => {});
  fireEvent.keyDown(window, { key: "f", metaKey: true });
  expect(navItem(/Search settings/).getAttribute("aria-current")).toBeNull();
  fireEvent.keyDown(window, { key: "f", ctrlKey: true });
  expect(navItem(/Search settings/).getAttribute("aria-current")).toBe("page");
});

test("Search settings shows the query and Ctrl+F opens it from any page", async () => {
  onPlatform("Linux x86_64");
  render(<Settings initial="about" />);
  await act(async () => {});
  expect(navItem(/Search settings/)).toBeTruthy();
  fireEvent.keyDown(window, { key: "f", ctrlKey: true });
  expect(navItem(/Search settings/).getAttribute("aria-current")).toBe("page");
  const input = screen.getByRole("searchbox", { name: "Search settings" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "backup" } });
  expect(navItem(/backup/).getAttribute("aria-current")).toBe("page");
});
