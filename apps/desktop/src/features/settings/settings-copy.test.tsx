// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChatClientContext } from "@/features/chats/client";
import { createMockChatClient } from "@/features/chats/mock-client";
import { ChatFeatureContext } from "@/features/chats/use-chats";
import { SyncStatusProvider } from "@/features/sync/SyncStatusProvider";
import { syncSettings, syncStatus } from "@/features/sync/sync-fixtures";
import { SettingsView } from "@/features/settings/SettingsView";
import {
  SETTINGS_ENTRIES,
  sourceEntries,
} from "@/features/settings/settings-search";
import { SETTINGS_SECTIONS } from "@/features/settings/settings-sections";
import { agentSkillsClient } from "@/lib/api/agent-skills";
import { cliClient } from "@/lib/api/cli";
import { diagnosticsClient } from "@/lib/api/diagnostics";
import { notificationClient } from "@/lib/api/notifications";
import { sourcesClient } from "@/lib/api/sources";
import { workspaceClient } from "@/lib/api/workspace";
import { syncApi } from "@/lib/sync-api";
import { TestReads } from "@/lib/workspace-reads/testing";
import { githubSource } from "@/test/source-fixtures";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockImplementation(async (command: string) =>
    command === "attachment_upload_destination"
      ? {
          kind: "google_drive",
          destination: {
            connection_id: "account",
            folder_id: "folder",
            resource_key: null,
          },
          folder_name: "Specs",
        }
      : 104857600,
  ),
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
vi.mock("@/lib/api/diagnostics", async (original) => {
  const actual = await original<typeof import("@/lib/api/diagnostics")>();
  return {
    ...actual,
    diagnosticsClient: {
      ...actual.diagnosticsClient,
      logLevel: vi.fn(),
      recentErrors: vi.fn(),
    },
  };
});
vi.mock("@/lib/api/sources", async (original) => ({
  ...(await original<typeof import("@/lib/api/sources")>()),
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
vi.mock("@/lib/sync-api", async (original) => ({
  ...(await original<typeof import("@/lib/sync-api")>()),
  syncApi: {
    status: vi.fn(),
    settings: vi.fn(),
    setSettings: vi.fn(),
    setupOptions: vi.fn(),
    flushOnExit: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(notificationClient.permitted).mockResolvedValue(true);
  vi.mocked(cliClient.check).mockResolvedValue({
    found: false,
    on_path: false,
    path: null,
    version: null,
    version_matches: null,
    workspace_path: null,
    workspace_matches: null,
    app_version: "0.1.0",
    app_workspace_path: "/w",
    suggested_directory: "~/.local/bin",
  });
  vi.mocked(agentSkillsClient.list).mockResolvedValue([]);
  vi.mocked(diagnosticsClient.logLevel).mockResolvedValue({
    level: "info",
    debug: false,
    env_override: null,
  });
  vi.mocked(diagnosticsClient.recentErrors).mockResolvedValue([]);
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
  vi.mocked(syncApi.status).mockResolvedValue(syncStatus());
  vi.mocked(syncApi.settings).mockResolvedValue(syncSettings());
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** Text as people read it: one case, one kind of quote, one run of spaces. */
const plain = (text: string) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim()
    .toLowerCase();

const CHAT_ON = {
  enabled: true,
  setEnabled: async () => {},
  overview: { needs_you: 0, unread: 0, app_icon: 0, working: 0 },
  revision: 0,
  openRequest: null,
  chatRequest: null,
  requestChat: () => {},
};

test("Chat settings show harness names only in the catalog", async () => {
  const client = createMockChatClient({
    harnesses: [{ id: "antigravity", name: "Antigravity", status: "ready" }],
  });
  const page = (enabled: boolean) => (
    <ChatClientContext value={client}>
      <ChatFeatureContext value={{ ...CHAT_ON, enabled }}>
        <TestReads>
          <SyncStatusProvider>
            <SettingsView
              selected="chat"
              onSelect={() => {}}
              onRestore={async () => {}}
              onOpenInbox={() => {}}
            />
          </SyncStatusProvider>
        </TestReads>
      </ChatFeatureContext>
    </ChatClientContext>
  );
  const harnessNames = /Claude Code|Codex|Antigravity/i;
  const { rerender } = render(page(false));
  expect(screen.queryByText(harnessNames)).toBeNull();

  rerender(page(true));
  const catalog = await screen.findByRole("list", { name: "Harnesses" });
  expect(screen.getAllByText(harnessNames)).toEqual([
    within(catalog).getByText("Antigravity"),
  ]);
});

test("every search entry's title and description are on the page it opens", async () => {
  const drifted: string[] = [];
  for (const section of SETTINGS_SECTIONS) {
    const { unmount } = render(
      <ChatFeatureContext value={CHAT_ON}>
        <TestReads>
          <SyncStatusProvider>
            <SettingsView
              selected={section.id}
              onSelect={() => {}}
              onRestore={async () => {}}
              onOpenInbox={() => {}}
            />
          </SyncStatusProvider>
        </TestReads>
      </ChatFeatureContext>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const page = plain(document.body.textContent ?? "");
    for (const entry of SETTINGS_ENTRIES.filter(
      (candidate) => candidate.section === section.id,
    )) {
      if (!page.includes(plain(entry.title)))
        drifted.push(`${section.id}: title "${entry.title}"`);
      if (!page.includes(plain(entry.description)))
        drifted.push(
          `${section.id}: "${entry.title}" description "${entry.description}"`,
        );
    }
    unmount();
  }
  expect(drifted).toEqual([]);
}, 30_000);

test("a source page carries the title and description of its search entries", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([githubSource]);
  vi.mocked(sourcesClient.configurationSummary).mockResolvedValue([]);
  vi.mocked(sourcesClient.checkConnection).mockResolvedValue({
    account: "octo",
  });
  render(
    <ChatFeatureContext value={CHAT_ON}>
      <TestReads>
        <SyncStatusProvider>
          <SettingsView
            selected="source-github"
            onSelect={() => {}}
            onRestore={async () => {}}
            onOpenInbox={() => {}}
          />
        </SyncStatusProvider>
      </TestReads>
    </ChatFeatureContext>,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  const page = plain(document.body.textContent ?? "");
  for (const entry of sourceEntries("github", "GitHub")) {
    expect(page, entry.title).toContain(plain(entry.title));
    expect(page, entry.description).toContain(plain(entry.description));
  }
}, 30_000);
