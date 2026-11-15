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
  documents: 8,
  activities: 361,
  evidence: 54,
  projects: 4,
  plans: 3,
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
      documents: 7,
      activities: 342,
      evidence: 50,
      projects: 4,
      plans: 3,
    },
  },
};

beforeEach(() => {
  vi.mocked(workspaceClient.info).mockResolvedValue({
    path: "/w/workspace.sqlite3",
    tickets: 1,
    documents: 0,
    projects: 1,
    active_plans: 1,
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
  render(
    <SettingsView
      selected="backups"
      onRestore={onRestore}
      onOpenInbox={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose backup…" }));
  return screen.findByRole("dialog");
}

function replaceButton(dialog: HTMLElement) {
  return within(dialog).getByRole("button", {
    name: "Replace workspace",
  }) as HTMLButtonElement;
}

test("the comparison names what will be replaced, current workspace first", async () => {
  const dialog = await openReview();
  await within(dialog).findByText(/Integrity checked/);
  const headers = within(within(dialog).getByRole("table"))
    .getAllByRole("columnheader")
    .map((cell) => cell.textContent);
  expect(headers).toEqual(["This workspace", "Backup"]);
});

test("restore review reports complete retained local files and remote reference limits", async () => {
  vi.mocked(workspaceClient.inspectBackup).mockResolvedValue({
    ...valid,
    attachment_content: {
      container_version: 1,
      local_snapshots: 2,
      retained_files: 3,
      retained_bytes: 1024,
      remote_references: 1,
    },
  });
  const dialog = await openReview();
  // Secondary details wait behind one disclosure.
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Attachment details" }),
  );
  expect(
    within(dialog).getByText(
      /Local attachment files in the backup are complete/,
    ).textContent,
  ).toContain("1,024 bytes");
  expect(
    within(dialog).getByText(/1 file in Google Drive/).textContent,
  ).toContain("links and their details only");
  expect(
    within(dialog).getByText(/Restoring does not check Google Drive access/)
      .textContent,
  ).toContain("choose the file again");
  expect(replaceButton(dialog).disabled).toBe(false);
});

test("the consequence comes first, before the comparison (set BK-05)", async () => {
  const dialog = await openReview();
  await within(dialog).findByText(/Integrity checked/);
  const consequence = within(dialog).getByRole("note");
  expect(consequence.textContent).toContain(
    "This replaces everything in this workspace",
  );
  const table = within(dialog).getByRole("table");
  expect(
    consequence.compareDocumentPosition(table) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("cancelling the file picker opens nothing and restores nothing", async () => {
  vi.mocked(workspaceClient.chooseBackupFile).mockResolvedValue(null);
  render(
    <SettingsView
      selected="backups"
      onRestore={async () => {}}
      onOpenInbox={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose backup…" }));
  await waitFor(() =>
    expect(workspaceClient.chooseBackupFile).toHaveBeenCalled(),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(workspaceClient.inspectBackup).not.toHaveBeenCalled();
});

test("a valid backup shows both sides' counts and what replacing means", async () => {
  const dialog = await openReview();
  expect(await within(dialog).findByText(/Integrity checked/)).toBeTruthy();
  expect(
    within(dialog).getByLabelText("Chosen backup file").textContent,
  ).toContain("ticketd-2026-10-31.sqlite3");
  expect(dialog.textContent).toContain("Integrity checked · format 19");
  const row = (name: string) =>
    within(within(dialog).getByRole("row", { name: new RegExp(name) }))
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
  expect(row("Tickets")).toEqual(["128", "121"]);
  expect(row("Documents")).toEqual(["8", "7"]);
  expect(row("Activities")).toEqual(["361", "342"]);
  expect(row("Implementation evidence")).toEqual(["54", "50"]);
  expect(row("Projects")).toEqual(["4", "4"]);
  expect(row("Plans")).toEqual(["3", "3"]);
  expect(dialog.textContent).toContain(
    "The backup has 7 fewer tickets, 1 fewer Document, 19 fewer activities and 4 fewer evidence items.",
  );
  expect(dialog.textContent).toContain("follows, reminders and inbox state");
  expect(dialog.textContent).toContain("safety backup");
  expect(dialog.textContent).toContain("Pause ticketd commands");
  expect(replaceButton(dialog).disabled).toBe(false);
  expect(client.restoreWorkspace).not.toHaveBeenCalled();
});

test.each([
  [
    "a newer format",
    { status: "newer_format", backup_version: 21, supported_version: 20 },
    /newer ticketd.*workspace format 21; this app reads up to 20\. Update ticketd/,
  ],
  [
    "a file that is not a ticketd backup",
    { status: "not_ticketd" },
    /Not a ticketd backup/,
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
      check: check as unknown as BackupInspection["check"],
    });
    const dialog = await openReview();
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(expected);
    expect(screen.getByRole("dialog", { name: "Review backup" })).toBe(dialog);
    expect(alert.textContent).toContain("Your workspace hasn't changed.");
    // No dead destructive button: the way forward is another file (set BK-06).
    expect(
      within(dialog).queryByRole("button", {
        name: "Replace workspace",
      }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Choose another file…" }),
    ).toBeTruthy();
    expect(client.restoreWorkspace).not.toHaveBeenCalled();
  },
);

test("Choose another checks the new file and keeps the old one when cancelled", async () => {
  const dialog = await openReview();
  await within(dialog).findByText(/Integrity checked/);
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
  expect(
    within(dialog).getByLabelText("Chosen backup file").textContent,
  ).toContain("newer.sqlite3");
});

test("Replace workspace shows the safety backup, reloads views, and lists it afterward", async () => {
  const safety = "/w/workspace.sqlite3.safety-3f2c9a1e.sqlite3";
  vi.mocked(client.restoreWorkspace).mockResolvedValue({
    safety_path: safety,
  });
  const reload = vi.fn(async () => {});
  const write = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText: write } });
  vi.mocked(workspaceClient.safetyBackups).mockResolvedValue([
    {
      path: safety,
      kind: "safety",
      saved_at: "2026-11-01T10:00:00Z",
      size_bytes: 100,
    },
  ]);
  const dialog = await openReview(reload);
  await within(dialog).findByText(/Integrity checked/);
  fireEvent.click(replaceButton(dialog));
  const copy = await within(dialog).findByRole("button", {
    name: `Copy path ${safety}`,
  });
  expect(client.restoreWorkspace).toHaveBeenCalledWith(BACKUP);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(dialog.textContent).toContain("121 tickets, 342 activities");
  fireEvent.click(copy);
  await waitFor(() => expect(write).toHaveBeenCalledWith(safety));
  fireEvent.click(within(dialog).getByRole("button", { name: /^Show in / }));
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith(safety),
  );

  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const region = await screen.findByRole("region", { name: "Safety backups" });
  expect(
    await within(region).findByText(
      "workspace.sqlite3.safety-3f2c9a1e.sqlite3",
    ),
  ).toBeTruthy();
  expect(within(region).getByText("Before a restore")).toBeTruthy();
});

test("a restore that happened with something unconfirmed is a success with a warning", async () => {
  const safety = "/w/workspace.sqlite3.safety-3f2c9a1e.sqlite3";
  const warning =
    "Stopping 1 Chat(s) could not be confirmed; a harness process may still be running.";
  vi.mocked(client.restoreWorkspace).mockResolvedValue({
    safety_path: safety,
    warning,
  });
  const reload = vi.fn(async () => {});
  const dialog = await openReview(reload);
  await within(dialog).findByText(/Integrity checked/);
  fireEvent.click(replaceButton(dialog));

  // The data was replaced: views reload and the safety copy is shown, as for any
  // restore, and the warning is said beside them.
  expect(
    await within(dialog).findByRole("button", { name: `Copy path ${safety}` }),
  ).toBeTruthy();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(dialog.textContent).toContain("Workspace restored");
  expect(dialog.textContent).not.toContain("Restore failed");
  expect(within(dialog).getByRole("alert").textContent).toBe(warning);
});

test("a failed restore keeps the review open and says so", async () => {
  vi.mocked(client.restoreWorkspace).mockRejectedValue(
    new Error("workspace is in use"),
  );
  const reload = vi.fn(async () => {});
  const dialog = await openReview(reload);
  await within(dialog).findByText(/Integrity checked/);
  fireEvent.click(replaceButton(dialog));
  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "Workspace is in use.",
  );
  expect(reload).not.toHaveBeenCalled();
});

test("only the final action is destructive; Cancel is quiet and the safety note is in the footer", async () => {
  const dialog = await openReview();
  await within(dialog).findByText(/Integrity checked/);
  expect(replaceButton(dialog).className).toContain("ui-button-destructive");
  const others = within(dialog)
    .getAllByRole("button")
    .filter((button) => button !== replaceButton(dialog));
  expect(
    others.some((button) => button.className.includes("destructive")),
  ).toBe(false);
  expect(
    within(dialog).getByText(
      "A safety backup of this workspace is saved first. Pause ticketd commands until it finishes.",
    ),
  ).toBeTruthy();
});

test("differing backup values are marked and matching ones are not", async () => {
  const dialog = await openReview();
  await within(dialog).findByText(/Integrity checked/);
  const cells = (name: string) =>
    within(within(dialog).getByRole("row", { name: new RegExp(name) }))
      .getAllByRole("cell")
      .map((cell) => cell.getAttribute("data-differs"));
  expect(cells("Tickets")).toEqual([null, "true"]);
  expect(cells("Projects")).toEqual([null, "false"]);
});

test("an unreadable file is an error with the unchanged reassurance and no way to replace", async () => {
  vi.mocked(workspaceClient.inspectBackup).mockRejectedValue(
    new Error("disk error"),
  );
  const dialog = await openReview();
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain("Couldn't read this backup");
  expect(screen.getByRole("dialog", { name: "Review backup" })).toBe(dialog);
  expect(alert.textContent).toContain("Your workspace hasn't changed.");
  expect(
    within(dialog).queryByRole("button", {
      name: "Replace workspace",
    }),
  ).toBeNull();
});
