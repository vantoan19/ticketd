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
import { SettingsNav } from "@/features/settings/SettingsNav";
import { loadPreferences } from "@/lib/preferences";
import { workspaceClient } from "@/lib/api/workspace";
import { client } from "@/lib/api/client";
import { notificationClient } from "@/lib/api/notifications";
import { cliClient } from "@/lib/api/cli";

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
vi.mock("@/lib/api/notifications", () => ({
  notificationClient: {
    permitted: vi.fn(),
    requestPermission: vi.fn(),
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
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  const checked = (name: string | RegExp) =>
    screen.getByRole("radio", { name }).getAttribute("aria-checked");
  expect(checked("System")).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  fireEvent.click(screen.getByRole("radio", { name: /Full width/ }));
  expect(checked("Dark")).toBe("true");
  expect(checked(/Full width/)).toBe("true");
  expect(loadPreferences()).toMatchObject({
    theme: "dark",
    openTickets: "expanded",
  });
});

test("the section list only offers sections that have cards", () => {
  render(
    <>
      <SettingsNav onBack={() => {}} />
      <SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />
    </>,
  );
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  const labels = Array.from(nav.querySelectorAll("li button")).map(
    (button) => button.textContent ?? "",
  );
  expect(labels).toEqual([
    "Appearance",
    "Attention",
    "Location",
    "Backups",
    "Export",
    "Command line",
    "Keyboard shortcuts",
    "About",
  ]);
  for (const label of labels)
    expect(screen.getByRole("region", { name: label })).toBeTruthy();
});

test("the Location card shows the path, counts, size, and format version", async () => {
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  expect((await screen.findByLabelText("Workspace path")).textContent).toBe(
    info.path,
  );
  const text = screen.getByRole("region", { name: "Location" }).textContent;
  expect(text).toContain("Tickets42");
  expect(text).toContain("Projects3");
  expect(text).toContain("Active Plans2");
  expect(text).toContain("File size2.5 MB");
  expect(text).toContain("Workspace format version20");
});

test("Copy path puts the workspace path on the clipboard", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Copy path" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(info.path));
  expect(await screen.findByText("Path copied.")).toBeTruthy();
});

test("Show in the file manager reveals the workspace file", async () => {
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /^Show in / }));
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith(info.path),
  );
});

test("a workspace that cannot be read shows an error instead of counts", async () => {
  vi.mocked(workspaceClient.info).mockRejectedValue(new Error("locked"));
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  expect((await screen.findByRole("alert")).textContent).toContain("locked");
  expect(screen.queryByLabelText("Workspace path")).toBeNull();
});

test("the About links open Documentation and the issue tracker", async () => {
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Documentation" }));
  fireEvent.click(screen.getByRole("button", { name: "Report an issue" }));
  await waitFor(() =>
    expect(workspaceClient.openLink).toHaveBeenCalledTimes(2),
  );
  const urls = vi.mocked(workspaceClient.openLink).mock.calls.map(([u]) => u);
  expect(urls.every((url) => url.startsWith("https://"))).toBe(true);
});

const lastBackup = {
  path: "/Users/me/Backups/ticketd-backup-2026-11-01.sqlite3",
  completed_at: "2026-11-01T09:30:00.000Z",
};

test("Back up now saves to the chosen file and shows it as the checked last backup", async () => {
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue(lastBackup.path);
  vi.mocked(client.backupWorkspace).mockImplementation(async () => {
    vi.mocked(workspaceClient.lastBackup).mockResolvedValue(lastBackup);
    return true;
  });
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  expect(screen.queryByLabelText(/Backup file path/)).toBeNull();
  expect(screen.getByText("No backup has been made yet.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back up now…" }));
  expect((await screen.findByLabelText("Last backup path")).textContent).toBe(
    lastBackup.path,
  );
  expect(workspaceClient.chooseSavePath).toHaveBeenCalledWith(
    expect.objectContaining({
      defaultPath: expect.stringMatching(
        /^ticketd-backup-\d{4}-\d{2}-\d{2}\.sqlite3$/,
      ),
    }),
  );
  expect(client.backupWorkspace).toHaveBeenCalledWith(lastBackup.path);
  expect(
    screen.getByRole("group", { name: "Last backup" }).textContent,
  ).toContain("Checked");
});

test("the last backup, including one made with the CLI, shows on load and can be revealed", async () => {
  vi.mocked(workspaceClient.lastBackup).mockResolvedValue(lastBackup);
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  expect((await screen.findByLabelText("Last backup path")).textContent).toBe(
    lastBackup.path,
  );
  const group = screen.getByRole("group", { name: "Last backup" });
  fireEvent.click(group.querySelector("button") as HTMLButtonElement);
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith(lastBackup.path),
  );
});

test("a refused backup explains itself and keeps the previous status", async () => {
  vi.mocked(workspaceClient.lastBackup).mockResolvedValue(lastBackup);
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue(
    "/tmp/taken.sqlite3",
  );
  vi.mocked(client.backupWorkspace).mockRejectedValue(
    "a file already exists at /tmp/taken.sqlite3; ticketd never replaces an existing file, so choose a new name",
  );
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  await screen.findByLabelText("Last backup path");
  fireEvent.click(screen.getByRole("button", { name: "Back up now…" }));
  const alert = await screen.findByText(/The backup was not saved/);
  expect(alert.textContent).toContain("a file already exists at");
  expect(alert.textContent).not.toContain("nothing was left");
  expect(screen.getByLabelText("Last backup path").textContent).toBe(
    lastBackup.path,
  );
});

test("cancelling a save dialog changes nothing and shows no error", async () => {
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Back up now…" }));
  await waitFor(() =>
    expect(workspaceClient.chooseSavePath).toHaveBeenCalledTimes(1),
  );
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  await waitFor(() =>
    expect(workspaceClient.chooseSavePath).toHaveBeenCalledTimes(2),
  );
  expect(client.backupWorkspace).not.toHaveBeenCalled();
  expect(client.exportWorkspace).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("Export… writes to the chosen file and Copy puts the CLI command on the clipboard", async () => {
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue("/tmp/out.json");
  vi.mocked(client.exportWorkspace).mockResolvedValue(undefined);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  expect(
    await screen.findByText("Export saved to /tmp/out.json."),
  ).toBeTruthy();
  expect(client.exportWorkspace).toHaveBeenCalledWith("/tmp/out.json");
  fireEvent.click(screen.getByRole("button", { name: "Copy export command" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("ticketd export --file PATH"),
  );
});

test("Follow tickets I create is on by default and the choice persists", () => {
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  const follow = screen.getByRole("switch", {
    name: "Follow tickets I create",
  });
  expect(follow.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(follow);
  expect(follow.getAttribute("aria-checked")).toBe("false");
  expect(loadPreferences().followCreated).toBe(false);
});

test("turning on reminder notifications asks for permission and keeps the switch on when granted", async () => {
  vi.mocked(notificationClient.requestPermission).mockResolvedValue(true);
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  const notify = screen.getByRole("switch", {
    name: "Notify me when a reminder is due",
  });
  expect(notify.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(notify);
  await waitFor(() => expect(loadPreferences().notifyReminders).toBe(true));
  expect(notify.getAttribute("aria-checked")).toBe("true");
});

test("denied permission leaves the switch off and explains how to allow notifications", async () => {
  vi.mocked(notificationClient.requestPermission).mockResolvedValue(false);
  render(<SettingsView onRestore={async () => {}} onOpenInbox={() => {}} />);
  const notify = screen.getByRole("switch", {
    name: "Notify me when a reminder is due",
  });
  fireEvent.click(notify);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "notification settings",
  );
  expect(notify.getAttribute("aria-checked")).toBe("false");
  expect(loadPreferences().notifyReminders).toBe(false);
});

test("the Attention footer opens the inbox", () => {
  const openInbox = vi.fn();
  render(<SettingsView onRestore={async () => {}} onOpenInbox={openInbox} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Open the Attention inbox" }),
  );
  expect(openInbox).toHaveBeenCalled();
});
