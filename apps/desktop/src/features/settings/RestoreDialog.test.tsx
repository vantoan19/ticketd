// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SettingsView } from "@/features/settings/SettingsView";
import { workspaceClient, type BackupInspection } from "@/lib/api/workspace";
import { client } from "@/lib/api/client";

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
vi.mock("@/lib/api/client", () => ({
  client: {
    backupWorkspace: vi.fn(),
    exportWorkspace: vi.fn(),
    restoreWorkspace: vi.fn(),
  },
}));

const BACKUP = "/Users/me/Backups/ticketd-2026-10-31.sqlite3";
const current = {
  last_change: "2026-11-01T09:41:00Z",
  tickets: 128,
  notes: 361,
  evidence: 54,
  projects: 4,
  efforts: 3,
};
const valid: BackupInspection = {
  path: BACKUP,
  current,
  check: {
    status: "valid",
    format_version: 19,
    summary: {
      last_change: "2026-10-31T18:04:00Z",
      tickets: 121,
      notes: 342,
      evidence: 50,
      projects: 4,
      efforts: 3,
    },
  },
};

beforeEach(() => {
  vi.mocked(workspaceClient.info).mockResolvedValue({
    path: "/w/workspace.sqlite3",
    tickets: 1,
    projects: 1,
    active_efforts: 1,
    size_bytes: 10,
    format_version: 20,
  });
  vi.mocked(workspaceClient.lastBackup).mockResolvedValue(null);
  vi.mocked(workspaceClient.reveal).mockResolvedValue(undefined);
  vi.mocked(workspaceClient.safetyBackups).mockResolvedValue([]);
  vi.mocked(workspaceClient.chooseBackupFile).mockResolvedValue(BACKUP);
  vi.mocked(workspaceClient.inspectBackup).mockResolvedValue(valid);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openReview(onRestore: () => Promise<void> = async () => {}) {
  render(<SettingsView hidden={false} onRestore={onRestore} />);
  fireEvent.click(screen.getByRole("button", { name: "Restore from backup…" }));
  return screen.findByRole("dialog", { name: "Restore from a backup" });
}

function replaceButton(dialog: HTMLElement) {
  return within(dialog).getByRole("button", {
    name: "Replace workspace",
  }) as HTMLButtonElement;
}

test("cancelling the file picker opens nothing and restores nothing", async () => {
  vi.mocked(workspaceClient.chooseBackupFile).mockResolvedValue(null);
  render(<SettingsView hidden={false} onRestore={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Restore from backup…" }));
  await waitFor(() =>
    expect(workspaceClient.chooseBackupFile).toHaveBeenCalled(),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(workspaceClient.inspectBackup).not.toHaveBeenCalled();
});

test("a valid backup shows both sides' counts and what replacing means", async () => {
  const dialog = await openReview();
  expect(await within(dialog).findByText("Backup checked.")).toBeTruthy();
  expect(within(dialog).getByLabelText("Chosen backup file").textContent).toBe(
    "ticketd-2026-10-31.sqlite3",
  );
  expect(within(dialog).getByLabelText("Backup folder").textContent).toBe(
    "/Users/me/Backups",
  );
  expect(dialog.textContent).toContain("Workspace format version 19");
  const row = (name: string) =>
    within(within(dialog).getByRole("row", { name: new RegExp(name) }))
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
  expect(row("Tickets")).toEqual(["128", "121"]);
  expect(row("Notes")).toEqual(["361", "342"]);
  expect(row("Implementation evidence")).toEqual(["54", "50"]);
  expect(row("Projects")).toEqual(["4", "4"]);
  expect(row("Efforts")).toEqual(["3", "3"]);
  expect(dialog.textContent).toContain(
    "The backup has 7 fewer tickets, 19 fewer notes and 4 fewer evidence items.",
  );
  expect(dialog.textContent).toContain("follows, reminders, and inbox state");
  expect(dialog.textContent).toContain("safety backup");
  expect(dialog.textContent).toContain("Pause ticketd CLI commands");
  expect(replaceButton(dialog).disabled).toBe(false);
  expect(client.restoreWorkspace).not.toHaveBeenCalled();
});

test.each([
  [
    "a newer format",
    { status: "newer_format", backup_version: 21, supported_version: 20 },
    /newer ticketd \(workspace format 21; this app reads up to 20\)\. Update ticketd/,
  ],
  [
    "a file that is not a ticketd backup",
    { status: "not_ticketd" },
    /isn't a ticketd backup/,
  ],
  [
    "missing tables",
    { status: "missing_tables", tables: ["notes", "evidence"] },
    /missing tables ticketd needs: notes, evidence/,
  ],
  [
    "the current workspace",
    { status: "current_workspace" },
    /This is the current workspace/,
  ],
] as const)(
  "%s is explained and cannot be restored",
  async (_name, check, expected) => {
    vi.mocked(workspaceClient.inspectBackup).mockResolvedValue({
      path: BACKUP,
      current,
      check,
    });
    const dialog = await openReview();
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(expected);
    expect(alert.textContent).toContain("Your workspace hasn't changed.");
    expect(replaceButton(dialog).disabled).toBe(true);
    expect(client.restoreWorkspace).not.toHaveBeenCalled();
  },
);

test("Choose another checks the new file and keeps the old one when cancelled", async () => {
  const dialog = await openReview();
  await within(dialog).findByText("Backup checked.");
  vi.mocked(workspaceClient.chooseBackupFile).mockResolvedValueOnce(null);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Choose another…" }),
  );
  await waitFor(() =>
    expect(workspaceClient.chooseBackupFile).toHaveBeenCalledTimes(2),
  );
  expect(workspaceClient.inspectBackup).toHaveBeenCalledTimes(1);
  vi.mocked(workspaceClient.chooseBackupFile).mockResolvedValueOnce(
    "/other/newer.sqlite3",
  );
  vi.mocked(workspaceClient.inspectBackup).mockResolvedValueOnce({
    path: "/other/newer.sqlite3",
    current,
    check: { status: "not_ticketd" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Choose another…" }),
  );
  await within(dialog).findByRole("alert");
  expect(within(dialog).getByLabelText("Chosen backup file").textContent).toBe(
    "newer.sqlite3",
  );
});

test("Replace workspace shows the safety backup, reloads views, and lists it afterward", async () => {
  const safety = "/w/workspace.sqlite3.safety-3f2c9a1e.sqlite3";
  vi.mocked(client.restoreWorkspace).mockResolvedValue(safety);
  const reload = vi.fn(async () => {});
  const write = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText: write } });
  const dialog = await openReview(reload);
  await within(dialog).findByText("Backup checked.");
  fireEvent.click(replaceButton(dialog));
  expect(
    (await within(dialog).findByLabelText("Safety backup path")).textContent,
  ).toBe(safety);
  expect(client.restoreWorkspace).toHaveBeenCalledWith(BACKUP);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(dialog.textContent).toContain("121 tickets, 342 notes");
  fireEvent.click(within(dialog).getByRole("button", { name: "Copy path" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith(safety));
  fireEvent.click(within(dialog).getByRole("button", { name: /^Show in / }));
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith(safety),
  );

  vi.mocked(workspaceClient.safetyBackups).mockResolvedValue([
    {
      path: safety,
      kind: "safety",
      saved_at: "2026-11-01T10:00:00Z",
      size_bytes: 100,
    },
  ]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show safety backups" }));
  const region = await screen.findByRole("region", { name: "Safety backups" });
  expect(await within(region).findByText(safety)).toBeTruthy();
  expect(within(region).getByText("Before a restore")).toBeTruthy();
});

test("a failed restore keeps the review open and says so", async () => {
  vi.mocked(client.restoreWorkspace).mockRejectedValue(
    new Error("workspace is in use"),
  );
  const reload = vi.fn(async () => {});
  const dialog = await openReview(reload);
  await within(dialog).findByText("Backup checked.");
  fireEvent.click(replaceButton(dialog));
  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "workspace is in use",
  );
  expect(reload).not.toHaveBeenCalled();
});

test("Show safety backups lists pre-migration and safety copies with their times", async () => {
  vi.mocked(workspaceClient.safetyBackups).mockResolvedValue([
    {
      path: "/w/a.safety-1.sqlite3",
      kind: "safety",
      saved_at: "2026-11-01T10:00:00Z",
      size_bytes: 1,
    },
    {
      path: "/w/a.pre-migration-2.sqlite3",
      kind: "pre_migration",
      saved_at: "2026-10-01T10:00:00Z",
      size_bytes: 1,
    },
  ]);
  render(<SettingsView hidden={false} onRestore={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Show safety backups" }));
  const region = await screen.findByRole("region", { name: "Safety backups" });
  expect(await within(region).findByText("/w/a.safety-1.sqlite3")).toBeTruthy();
  expect(within(region).getByText("Before an upgrade")).toBeTruthy();
  fireEvent.click(
    within(region).getByRole("button", {
      name: /Show \/w\/a\.pre-migration-2\.sqlite3 in /,
    }),
  );
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith(
      "/w/a.pre-migration-2.sqlite3",
    ),
  );
});
