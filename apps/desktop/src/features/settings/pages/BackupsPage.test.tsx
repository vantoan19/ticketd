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
import { BackupsPage } from "@/features/settings/pages/BackupsPage";
import { workspaceClient } from "@/lib/api/workspace";
import { client } from "@/lib/api/client";

vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: {
    reveal: vi.fn(),
    lastBackup: vi.fn(),
    chooseSavePath: vi.fn(),
    chooseBackupFile: vi.fn(),
    inspectBackup: vi.fn(),
    safetyBackups: vi.fn(),
  },
}));
vi.mock("@/lib/api/client", () => ({
  client: { backupWorkspace: vi.fn(), restoreWorkspace: vi.fn() },
}));

const last = {
  path: "/Users/me/Backups/ticketd-backup-2026-11-01.sqlite3",
  completed_at: "2026-11-01T09:30:00.000Z",
};

beforeEach(() => {
  vi.mocked(workspaceClient.lastBackup).mockResolvedValue(null);
  vi.mocked(workspaceClient.safetyBackups).mockResolvedValue([]);
  vi.mocked(workspaceClient.reveal).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(onRestore: () => Promise<void> = async () => {}) {
  return render(<BackupsPage onRestore={onRestore} />);
}
const backUpButton = () =>
  screen.getByRole("button", { name: /^Back up now…|^Backing up…/ });

test("the last backup is a loading row with Back up now disabled until it is read", async () => {
  let resolve: (value: typeof last) => void = () => {};
  vi.mocked(workspaceClient.lastBackup).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  renderPage();
  expect(screen.getByRole("status", { name: "Checking for the last backup" }));
  expect((backUpButton() as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText("No backups yet")).toBeNull();
  resolve(last);
  expect(
    await screen.findByText("ticketd-backup-2026-11-01.sqlite3"),
  ).toBeTruthy();
  expect((backUpButton() as HTMLButtonElement).disabled).toBe(false);
});

test("no backup yet says so, with the first-backup sentence", async () => {
  renderPage();
  expect(await screen.findByText("No backups yet")).toBeTruthy();
  expect(
    screen.getByText("Your first backup will be listed here with its date."),
  ).toBeTruthy();
});

test("the last backup shows its file, folder and Checked, and can be revealed", async () => {
  vi.mocked(workspaceClient.lastBackup).mockResolvedValue(last);
  renderPage();
  const name = await screen.findByText("ticketd-backup-2026-11-01.sqlite3");
  const row = name.closest(".settings-list-row") as HTMLElement;
  expect(within(row).getByText("Checked")).toBeTruthy();
  expect(row.textContent).toContain("/Users/me/Backups");
  fireEvent.click(within(row).getByRole("button", { name: /^Show in / }));
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith(last.path),
  );
});

test("a failed read is its own state with Retry, not No backups yet", async () => {
  vi.mocked(workspaceClient.lastBackup).mockRejectedValueOnce(
    new Error("locked"),
  );
  renderPage();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't read the last backup");
  expect(alert.textContent).toContain(
    "The backups themselves are fine. Retry, or back up now.",
  );
  expect(screen.queryByText("No backups yet")).toBeNull();
  // Backing up still works without the status.
  expect((backUpButton() as HTMLButtonElement).disabled).toBe(false);
  vi.mocked(workspaceClient.lastBackup).mockResolvedValue(last);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("ticketd-backup-2026-11-01.sqlite3"),
  ).toBeTruthy();
});

test("Back up now shows the backing-up row, then the new last backup and a saved message", async () => {
  let finish: (recorded: boolean) => void = () => {};
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue(last.path);
  vi.mocked(client.backupWorkspace).mockReturnValue(
    new Promise((done) => {
      finish = done;
    }),
  );
  renderPage();
  await screen.findByText("No backups yet");
  fireEvent.click(backUpButton());
  expect(
    await screen.findByText("Backing up…", {
      selector: ".settings-list-row-title",
    }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Copying the workspace and its local attachment files, then checking the copy.",
    ),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Choose backup…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  vi.mocked(workspaceClient.lastBackup).mockResolvedValue(last);
  finish(true);
  expect(
    await screen.findByText("ticketd-backup-2026-11-01.sqlite3"),
  ).toBeTruthy();
  expect(screen.getByText("Backup saved and checked.")).toBeTruthy();
  expect(client.backupWorkspace).toHaveBeenCalledWith(last.path);
});

test("a refused backup is explained in the footer and keeps the previous status", async () => {
  vi.mocked(workspaceClient.lastBackup).mockResolvedValue(last);
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue("/tmp/taken");
  vi.mocked(client.backupWorkspace).mockRejectedValue("a file already exists");
  renderPage();
  await screen.findByText("ticketd-backup-2026-11-01.sqlite3");
  fireEvent.click(backUpButton());
  const failure = await screen.findByText("A file already exists.");
  expect(failure.textContent).toContain("Couldn't save the backup.");
  expect(failure.closest(".settings-list-footer")).toBeTruthy();
  expect(screen.getByText("ticketd-backup-2026-11-01.sqlite3")).toBeTruthy();
});

test("cancelling the save dialog changes nothing", async () => {
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue(null);
  renderPage();
  await screen.findByText("No backups yet");
  fireEvent.click(backUpButton());
  await waitFor(() =>
    expect(workspaceClient.chooseSavePath).toHaveBeenCalledTimes(1),
  );
  expect(client.backupWorkspace).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(await screen.findByText("No backups yet")).toBeTruthy();
});

test("a backup that could not update the status says so", async () => {
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue(last.path);
  vi.mocked(client.backupWorkspace).mockResolvedValue(false);
  renderPage();
  await screen.findByText("No backups yet");
  fireEvent.click(backUpButton());
  expect(
    await screen.findByText(
      "Backup saved and checked, but the Last backup status could not be updated.",
    ),
  ).toBeTruthy();
});

test("what a backup contains lists four items", async () => {
  renderPage();
  const section = screen.getByRole("region", {
    name: "What a backup contains",
  });
  expect(within(section).getAllByRole("listitem")).toHaveLength(4);
  expect(within(section).getByText("Files in Google Drive")).toBeTruthy();
  await screen.findByText("No backups yet");
});

test("Choose backup… opens the file chooser, then the review dialog", async () => {
  vi.mocked(workspaceClient.chooseBackupFile).mockResolvedValue("/b/x.sqlite3");
  vi.mocked(workspaceClient.inspectBackup).mockResolvedValue({
    path: "/b/x.sqlite3",
    current: {
      last_change: null,
      tickets: 1,
      documents: 0,
      activities: 0,
      evidence: 0,
      projects: 0,
      plans: 0,
    },
    check: { status: "not_ticketd" },
  });
  renderPage();
  await screen.findByText("No backups yet");
  fireEvent.click(screen.getByRole("button", { name: "Choose backup…" }));
  expect(
    await screen.findByRole("dialog", { name: "Restore from backup" }),
  ).toBeTruthy();
  expect(workspaceClient.chooseBackupFile).toHaveBeenCalledWith({
    title: "Choose a ticketd backup",
  });
});

test("a failed safety backup read is a message, never a count of 0", async () => {
  vi.mocked(workspaceClient.safetyBackups).mockRejectedValueOnce(
    new Error("no access"),
  );
  renderPage();
  const section = screen.getByRole("region", { name: "Safety backups" });
  const alert = await within(section).findByRole("alert");
  expect(alert.textContent).toContain("Couldn't list safety backups");
  expect(alert.textContent).toContain("No access.");
  expect(within(section).queryByText("No safety backups yet")).toBeNull();
  vi.mocked(workspaceClient.safetyBackups).mockResolvedValue([]);
  fireEvent.click(within(section).getByRole("button", { name: "Retry" }));
  expect(
    await within(section).findByText("No safety backups yet"),
  ).toBeTruthy();
});

test("safety backups are rows with kind, date, path and a reveal button", async () => {
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
  renderPage();
  const section = screen.getByRole("region", { name: "Safety backups" });
  expect(
    await within(section).findByText("/w/a.safety-1.sqlite3"),
  ).toBeTruthy();
  expect(within(section).getByText("Before a restore")).toBeTruthy();
  expect(within(section).getByText("Before an upgrade")).toBeTruthy();
  fireEvent.click(
    within(section).getByRole("button", {
      name: /Show \/w\/a\.pre-migration-2\.sqlite3 in /,
    }),
  );
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith(
      "/w/a.pre-migration-2.sqlite3",
    ),
  );
});
