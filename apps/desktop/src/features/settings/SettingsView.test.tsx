import { revealFailureDetails } from "@/test/failure-details";
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SettingsView } from "@/features/settings/SettingsView";
import { loadPreferences } from "@/lib/preferences";
import { workspaceClient } from "@/lib/api/workspace";
import { client } from "@/lib/api/client";
import { cliClient } from "@/lib/api/cli";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi
    .fn()
    .mockImplementation(async (command: string) =>
      command === "attachment_upload_destination"
        ? { kind: "local" }
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
  agentSkillsClient: { list: vi.fn(async () => []), install: vi.fn() },
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
  client: {
    backupWorkspace: vi.fn(),
    exportWorkspace: vi.fn(),
    restoreWorkspace: vi.fn(),
  },
}));

const info = {
  path: "/Users/me/Library/Application Support/ticketd/workspace.sqlite3",
  tickets: 42,
  projects: 3,
  active_plans: 2,
  documents: 0,
  size_bytes: 2_621_440,
  format_version: 20,
};

beforeEach(() => {
  vi.mocked(cliClient.check).mockResolvedValue({
    found: false,
    on_path: false,
    path: null,
    version: null,
    version_matches: null,
    workspace_path: null,
    workspace_matches: null,
    app_version: "0.1.0",
    app_workspace_path: null,
    suggested_directory: "~/.local/bin",
  });
  vi.mocked(workspaceClient.info).mockResolvedValue(info);
  vi.mocked(workspaceClient.safetyBackups).mockResolvedValue([]);
  vi.mocked(workspaceClient.reveal).mockResolvedValue(undefined);
  vi.mocked(workspaceClient.openLink).mockResolvedValue(undefined);
  vi.mocked(workspaceClient.lastBackup).mockResolvedValue(null);
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

test("choosing Dark or Full width is stored and exposed as selected", () => {
  render(<SettingsView selected="appearance" onRestore={async () => {}} />);
  const checked = (name: string | RegExp) =>
    screen.getByRole("radio", { name }).getAttribute("aria-checked");
  expect(checked(/^System/)).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: /^Dark/ }));
  fireEvent.click(screen.getByRole("radio", { name: /Full width/ }));
  expect(checked(/^Dark/)).toBe("true");
  expect(checked(/Full width/)).toBe("true");
  expect(loadPreferences()).toMatchObject({
    theme: "dark",
    openTickets: "expanded",
  });
});

test("a page opens at its top, not where the previous page was scrolled", () => {
  const view = render(
    <SettingsView selected="appearance" onRestore={async () => {}} />,
  );
  const scroller = view.container.querySelector(".settings-page")!;
  scroller.scrollTop = 600;
  view.rerender(<SettingsView selected="files" onRestore={async () => {}} />);
  expect(scroller.scrollTop).toBe(0);
});

test("the removed Google Drive page opens Files, where Drive is chosen for new uploads", () => {
  render(<SettingsView selected="google-drive" onRestore={async () => {}} />);
  expect(screen.getByRole("heading", { level: 1, name: "Files" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Appearance" })).toBeNull();
});

test("Workspace sync opens as its own page, apart from Files", () => {
  render(<SettingsView selected="workspace-sync" onRestore={async () => {}} />);
  expect(
    screen.getByRole("heading", { level: 1, name: "Workspace sync" }),
  ).toBeTruthy();
  expect(screen.queryByRole("heading", { level: 1, name: "Files" })).toBeNull();
});

test("Backups & export shows the Workspace file, its counts, size and format version", async () => {
  render(<SettingsView selected="backups-export" onRestore={async () => {}} />);
  await screen.findAllByText("workspace.sqlite3");
  // The full path is in the PathText tooltip, not a native title.
  const folder = document.querySelector<HTMLElement>(
    '[data-slot="path-text"]',
  )!;
  expect(folder.textContent).toBe("~/Library/Application Support/ticketd");
  fireEvent.pointerMove(folder);
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "/Users/me/Library/Application Support/ticketd",
  );
  fireEvent.keyDown(document.body, { key: "Escape" });
  const text = screen
    .getByRole("region", { name: "Location" })
    .querySelector(".settings-list-footer-text")?.textContent;
  expect(text).toBe("42 tickets · 0 Documents · 2 Plans · 2.5 MB · format 20");
});

test("Copy path puts the workspace path on the clipboard", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<SettingsView selected="backups-export" onRestore={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Copy path" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(info.path));
  expect(await screen.findByText("Copied")).toBeTruthy();
});

test("Show in the file manager reveals the workspace file", async () => {
  render(<SettingsView selected="backups-export" onRestore={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /^Show in / }));
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith(info.path),
  );
});

test("a workspace that cannot be read shows an error instead of counts", async () => {
  vi.mocked(workspaceClient.info).mockRejectedValue(new Error("locked"));
  render(<SettingsView selected="backups-export" onRestore={async () => {}} />);
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain("locked");
  expect(screen.queryByLabelText("Workspace path")).toBeNull();
});

test("cancelling a save dialog changes nothing and shows no error", async () => {
  const props = { onRestore: async () => {} };
  render(<SettingsView selected="backups-export" {...props} />);
  await screen.findByText("No backups yet");
  fireEvent.click(screen.getByRole("button", { name: "Back up now…" }));
  await waitFor(() =>
    expect(workspaceClient.chooseSavePath).toHaveBeenCalledTimes(1),
  );
  expect(client.backupWorkspace).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("Follow tickets I create is on by default and the choice persists", () => {
  render(<SettingsView selected="attention" onRestore={async () => {}} />);
  const follow = screen.getByRole("switch", {
    name: "Follow tickets I create",
  });
  expect(follow.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(follow);
  expect(follow.getAttribute("aria-checked")).toBe("false");
  expect(loadPreferences().followCreated).toBe(false);
});

test("Location, Backups and Export are one page in that order", async () => {
  render(<SettingsView selected="backups-export" onRestore={async () => {}} />);
  await screen.findAllByText("workspace.sqlite3");
  expect(
    screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent)
      .filter((text) => ["Location", "Backups", "Export"].includes(text ?? "")),
  ).toEqual(["Location", "Backups", "Export"]);
});
