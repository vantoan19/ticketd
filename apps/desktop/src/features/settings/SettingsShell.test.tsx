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
import { sourcesClient } from "@/lib/api/sources";
import { workspaceClient } from "@/lib/api/workspace";
import { githubSource } from "@/test/source-fixtures";

const connected = {
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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(104857600),
}));
vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: {
    info: vi.fn(),
    reveal: vi.fn(),
    openLink: vi.fn(),
    restorePoints: vi.fn(),
    saveRestorePoint: vi.fn(),
    chooseSavePath: vi.fn(),
    chooseBackupFile: vi.fn(),
    inspectBackup: vi.fn(),
  },
}));
vi.mock("@/lib/api/cli", () => ({ cliClient: { check: vi.fn() } }));
vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn(), install: vi.fn() },
}));
vi.mock("@/lib/api/notifications", () => ({
  notificationClient: {
    permission: vi.fn(async () => ({
      state: "allowed",
      reported: true,
      settings: true,
    })),
    notify: vi.fn(),
  },
}));
vi.mock("@/lib/api/client", () => ({
  client: { exportWorkspace: vi.fn() },
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
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue({
    points: [],
    total_bytes: 0,
  });
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

test("the nav lists the decided groups and pages in order, with no entry per connection", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([connected]);
  render(<Settings />);
  await act(async () => {});
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  const groups = within(nav)
    .getAllByRole("group")
    .map((group) => [
      group.getAttribute("aria-label"),
      Array.from(group.querySelectorAll("li button")).map(
        (button) => button.textContent,
      ),
    ]);
  expect(groups).toEqual([
    ["Preferences", ["Appearance", "Attention"]],
    ["Workspace", ["Workspace sync", "Files", "Backups & export"]],
    ["AI", ["Command line", "Agent skills", "Agents"]],
    ["Connections", ["Ticket sources"]],
    ["Help", ["Keyboard shortcuts", "Diagnostics", "About"]],
  ]);
  // The search field sits above the groups and is a field, not a row.
  expect(
    screen.getByRole("searchbox", { name: "Search settings" }),
  ).toBeTruthy();
  fireEvent.click(navItem("Agents"));
  expect(
    screen.getByRole("heading", { level: 1, name: "Agents" }),
  ).toBeTruthy();
  expect(navItem("Agents").getAttribute("aria-current")).toBe("page");
  expect(
    screen.getByRole("navigation", { name: "Breadcrumb" }).textContent,
  ).toBe("AIAgents");
});

test("every page opens with its title and one job line, and no page says changes apply right away", async () => {
  render(<Settings />);
  await act(async () => {});
  const jobs: [string, string][] = [
    ["Appearance", "How ticketd looks on this computer."],
    ["Attention", "What reaches your Inbox, and when ticketd notifies you."],
    ["Files", "Where files you attach to tickets and Documents are kept."],
    [
      "Backups & export",
      "Where this Workspace lives, copies you can go back to, and how to take it with you.",
    ],
    [
      "Agent skills",
      "Teaches the agents on this computer to use ticketd without being told.",
    ],
    ["Ticket sources", "Bring issues from your other trackers in as tickets."],
    ["Keyboard shortcuts", "Every keyboard shortcut in one list."],
  ];
  for (const [name, job] of jobs) {
    fireEvent.click(navItem(name));
    await screen.findByRole("heading", { level: 1, name });
    expect(document.querySelector(".settings-page-lede")?.textContent).toBe(
      job,
    );
    expect(screen.queryByText("Changes apply right away")).toBeNull();
  }
});

test("Automations is listed under AI, after Agents, only while Chats are on", async () => {
  const ai = () =>
    within(screen.getByRole("group", { name: "AI" }))
      .getAllByRole("button")
      .map((button) => button.textContent);
  const { unmount } = render(<Settings />);
  await act(async () => {});
  expect(ai()).toEqual(["Command line", "Agent skills", "Agents"]);
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
  expect(ai()).toEqual([
    "Command line",
    "Agent skills",
    "Agents",
    "Automations",
  ]);
  fireEvent.click(navItem("Automations"));
  expect(
    screen.getByRole("heading", { level: 1, name: "Automations" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("navigation", { name: "Breadcrumb" }).textContent,
  ).toBe("AIAutomations");
});

test("choosing a page opens only it and moves focus to its title", async () => {
  render(<Settings />);
  await act(async () => {});
  expect(
    screen.getByRole("heading", { level: 1, name: "Appearance" }),
  ).toBeTruthy();
  fireEvent.click(navItem("Backups & export"));
  const title = screen.getByRole("heading", {
    level: 1,
    name: "Backups & export",
  });
  expect(document.activeElement).toBe(title);
  expect(navItem("Backups & export").getAttribute("aria-current")).toBe("page");
  expect(navItem("Appearance").getAttribute("aria-current")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Appearance" })).toBeNull();
  expect(
    screen.getByRole("navigation", { name: "Breadcrumb" }).textContent,
  ).toBe("WorkspaceBackups & export");
});

test("the old page names land on the page that replaced them", async () => {
  const landings: [SettingsPageId | string, string][] = [
    ["attachments", "Files"],
    ["google-drive", "Files"],
    ["location", "Backups & export"],
    ["backups", "Backups & export"],
    ["export", "Backups & export"],
    ["chat", "Agents"],
    ["sources", "Ticket sources"],
  ];
  for (const [old, page] of landings) {
    const { unmount } = render(<Settings initial={old as SettingsPageId} />);
    await act(async () => {});
    expect(screen.getByRole("heading", { level: 1, name: page })).toBeTruthy();
    expect(navItem(page).getAttribute("aria-current")).toBe("page");
    unmount();
  }
});

test("opening a connection shows it in place under Ticket sources, and Back and Escape return to the list", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([connected]);
  vi.mocked(sourcesClient.configurationSummary).mockResolvedValue([]);
  vi.mocked(sourcesClient.checkConnection).mockResolvedValue({
    account: "octo",
  });
  render(<Settings initial="ticket-sources" />);
  await act(async () => {});
  fireEvent.click(await screen.findByRole("button", { name: /^GitHub/ }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "GitHub" }),
  ).toBeTruthy();
  // The sidebar keeps the parent selected and gains no entry of its own.
  expect(navItem("Ticket sources").getAttribute("aria-current")).toBe("page");
  expect(
    screen.getByRole("navigation", { name: "Breadcrumb" }).textContent,
  ).toBe("ConnectionsTicket sourcesGitHub");
  fireEvent.click(
    screen.getByRole("button", { name: "Back to Ticket sources" }),
  );
  expect(
    await screen.findByRole("heading", { level: 1, name: "Ticket sources" }),
  ).toBeTruthy();

  fireEvent.click(await screen.findByRole("button", { name: /^GitHub/ }));
  await screen.findByRole("heading", { level: 1, name: "GitHub" });
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(
    await screen.findByRole("heading", { level: 1, name: "Ticket sources" }),
  ).toBeTruthy();
  expect(navItem("Ticket sources").getAttribute("aria-current")).toBe("page");
});

test("a link that names a connection lands on it in place, under Ticket sources", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([connected]);
  vi.mocked(sourcesClient.configurationSummary).mockResolvedValue([]);
  vi.mocked(sourcesClient.checkConnection).mockResolvedValue({
    account: "octo",
  });
  render(<Settings initial="source-github" />);
  await act(async () => {});
  expect(
    await screen.findByRole("heading", { level: 1, name: "GitHub" }),
  ).toBeTruthy();
  expect(navItem("Ticket sources").getAttribute("aria-current")).toBe("page");
  expect(
    screen.getByRole("button", { name: "Back to Ticket sources" }),
  ).toBeTruthy();
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
    screen.getByRole("button", {
      name: /^Backups & export, Settings sections/,
    }),
  ).toBeTruthy();
});

function onPlatform(platform: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
}

const field = () => screen.getByRole("searchbox", { name: "Search settings" });

test("on macOS only Cmd+F focuses the search field; Ctrl+F stays the terminal's forward-one-character", async () => {
  onPlatform("MacIntel");
  render(<Settings initial="about" />);
  await act(async () => {});
  fireEvent.keyDown(window, { key: "f", ctrlKey: true });
  expect(document.activeElement).not.toBe(field());
  fireEvent.keyDown(window, { key: "f", metaKey: true });
  expect(document.activeElement).toBe(field());
});

test("elsewhere only Ctrl+F focuses the search field; the Windows key does not", async () => {
  onPlatform("Win32");
  render(<Settings initial="about" />);
  await act(async () => {});
  fireEvent.keyDown(window, { key: "f", metaKey: true });
  expect(document.activeElement).not.toBe(field());
  fireEvent.keyDown(window, { key: "f", ctrlKey: true });
  expect(document.activeElement).toBe(field());
});

test("typing in the search field shows the results in place of the page and selects no entry", async () => {
  render(<Settings initial="about" />);
  await act(async () => {});
  fireEvent.change(field(), { target: { value: "backup" } });
  expect(
    await screen.findByRole("region", { name: "Backups & export" }),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("navigation", { name: "Settings sections" }))
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-current") === "page"),
  ).toHaveLength(0);
});
