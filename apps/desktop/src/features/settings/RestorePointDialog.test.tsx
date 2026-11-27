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
import { BackupsSection } from "@/features/settings/pages/BackupsSection";
import {
  SyncStatusContext,
  type SyncStatusValue,
} from "@/features/sync/sync-status";
import { notConnected, syncStatus } from "@/features/sync/sync-fixtures";
import { client } from "@/lib/api/client";
import { restorePointWhen } from "@/features/settings/settings-format";
import {
  workspaceClient,
  type BackupInspection,
  type RestorePoint,
} from "@/lib/api/workspace";

vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: {
    reveal: vi.fn(),
    restorePoints: vi.fn(),
    saveRestorePoint: vi.fn(),
    chooseBackupFile: vi.fn(),
    inspectBackup: vi.fn(),
  },
}));
vi.mock("@/lib/api/client", () => ({
  client: { restoreWorkspace: vi.fn() },
}));

/** Local time, so the labels read the same whatever the machine's zone. */
function at(daysAgo: number, hours: number, minutes: number) {
  const moment = new Date();
  moment.setDate(moment.getDate() - daysAgo);
  moment.setHours(hours, minutes, 0, 0);
  return moment.toISOString();
}

const POINT: RestorePoint = {
  path: "/w/workspace.sqlite3.restore-points/today.sqlite3",
  kind: "daily",
  saved_at: at(0, 8, 52),
  size_bytes: 1000,
  summary: {
    last_change: at(0, 8, 50),
    tickets: 24,
    activities: 198,
    documents: 5,
    evidence: 0,
    projects: 1,
    plans: 1,
  },
  problem: null,
};
const INSPECTION: BackupInspection = {
  path: POINT.path,
  current: {
    last_change: at(0, 11, 42),
    tickets: 26,
    activities: 214,
    documents: 5,
    evidence: 0,
    projects: 1,
    plans: 1,
  },
  check: {
    status: "valid",
    format_version: 104,
    summary: POINT.summary as NonNullable<RestorePoint["summary"]>,
  },
};

/** The labels as the app words them, in this machine's locale. */
const label = (moment: string) => restorePointWhen(moment);
const lower = (text: string) =>
  `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

const refresh = vi.fn();
const apply = vi.fn();
function renderPage(status: SyncStatusValue["status"], onRestore = vi.fn()) {
  const onOpenSync = vi.fn();
  render(
    <SyncStatusContext.Provider
      value={{
        status,
        apply,
        refresh,
        openSettings: () => {},
        openReview: () => {},
      }}
    >
      <BackupsSection
        onRestore={async () => onRestore()}
        onOpenSync={onOpenSync}
      />
    </SyncStatusContext.Provider>,
  );
  return { onRestore, onOpenSync };
}
async function openDialog() {
  fireEvent.click(await screen.findByRole("button", { name: /^Restore…/ }));
  const dialog = await screen.findByRole("dialog", {
    name: "Replace this Workspace?",
  });
  await within(dialog).findByRole("table");
  return dialog;
}

beforeEach(() => {
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue({
    points: [POINT],
    total_bytes: 1000,
  });
  vi.mocked(workspaceClient.inspectBackup).mockResolvedValue(INSPECTION);
  refresh.mockResolvedValue(syncStatus());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("Restore… on a point says what it replaces: now beside the point, in four rows", async () => {
  renderPage(notConnected());
  const dialog = await openDialog();

  expect(
    within(dialog).getByText(
      `With the restore point from ${lower(label(POINT.saved_at))}. Changes made since then are replaced.`,
    ),
  ).toBeTruthy();
  const table = within(dialog).getByRole("table");
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent),
  ).toEqual(["Now", label(POINT.saved_at)]);
  const row = (name: string) =>
    within(within(table).getByRole("row", { name: new RegExp(name) }))
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
  expect(row("Tickets")).toEqual(["26", "24"]);
  expect(row("Documents")).toEqual(["5", "5"]);
  expect(row("Activities")).toEqual(["214", "198"]);
  expect(row("Last change")).toEqual([
    label(INSPECTION.current.last_change as string),
    label(POINT.summary?.last_change as string),
  ]);
  expect(within(table).getAllByRole("row")).toHaveLength(5);
  // What differs is marked; what matches is not.
  const differs = (name: string) =>
    within(table)
      .getByRole("row", { name: new RegExp(name) })
      .querySelector('td[data-differs="true"]')?.textContent;
  expect(differs("Tickets")).toBe("24");
  expect(differs("Documents")).toBeUndefined();
  expect(workspaceClient.inspectBackup).toHaveBeenCalledWith(POINT.path);
});

test("the dialog says what else goes and that the current Workspace is saved first", async () => {
  renderPage(notConnected());
  const dialog = await openDialog();

  expect(within(dialog).getByText("Also replaced")).toBeTruthy();
  expect(
    within(dialog).getByText("Follows, reminders and Inbox state"),
  ).toBeTruthy();
  expect(
    within(dialog).getByText(
      "What is here now is saved first, as a restore point.",
    ),
  ).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "Replace Workspace" }),
  ).toBeTruthy();
  // A restore point needs no file path and no file check.
  expect(within(dialog).queryByLabelText("Chosen backup file")).toBeNull();
  expect(within(dialog).queryByText(/Integrity checked/)).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "Choose another…" }),
  ).toBeNull();
});

test("Workspace sync is named only while it is on", async () => {
  const consequence =
    "Turns off here, so your other computers keep their copy. You choose later whether this one rejoins them.";
  renderPage(notConnected());
  let dialog = await openDialog();
  expect(within(dialog).queryByText("Workspace sync")).toBeNull();
  expect(within(dialog).queryByText(consequence)).toBeNull();
  cleanup();

  renderPage(syncStatus());
  dialog = await openDialog();
  expect(within(dialog).getByText("Workspace sync")).toBeTruthy();
  expect(within(dialog).getByText(consequence)).toBeTruthy();
});

test("Cancel leaves everything as it was", async () => {
  renderPage(syncStatus());
  const dialog = await openDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(client.restoreWorkspace).not.toHaveBeenCalled();
});

test("replacing restores that point, refreshes sync, reloads the list and offers the way to rejoin", async () => {
  vi.mocked(client.restoreWorkspace).mockResolvedValue({
    safety_path: "/w/workspace.sqlite3.safety-1.sqlite3",
  });
  const { onRestore, onOpenSync } = renderPage(syncStatus());
  const dialog = await openDialog();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Replace Workspace" }),
  );

  await within(dialog).findByText("Workspace restored");
  expect(client.restoreWorkspace).toHaveBeenCalledWith(POINT.path);
  // The copy of what was replaced joins the list, so the list is read again.
  expect(workspaceClient.restorePoints).toHaveBeenCalledTimes(2);
  expect(onRestore).toHaveBeenCalledTimes(1);
  // Sync is off now: the page that offers Reconnect must not show the old status.
  expect(refresh).toHaveBeenCalled();
  expect(
    within(dialog).getByText(
      "Workspace sync is off on this computer. It offers to rejoin on the Workspace sync page.",
    ),
  ).toBeTruthy();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Open Workspace sync" }),
  );
  expect(onOpenSync).toHaveBeenCalledTimes(1);
});

test("after a restore with sync off, nothing is said about rejoining", async () => {
  vi.mocked(client.restoreWorkspace).mockResolvedValue({
    safety_path: "/w/workspace.sqlite3.safety-1.sqlite3",
  });
  renderPage(notConnected());
  const dialog = await openDialog();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Replace Workspace" }),
  );
  await within(dialog).findByText("Workspace restored");
  expect(within(dialog).queryByText(/rejoin/)).toBeNull();
});

test("a point from an earlier day names its date", async () => {
  const earlier = at(3, 17, 40);
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue({
    points: [{ ...POINT, saved_at: earlier }],
    total_bytes: 1000,
  });
  renderPage(notConnected());
  const dialog = await openDialog();
  const when = restorePointWhen(earlier);
  expect(
    within(dialog).getByText(
      `With the restore point from ${when}. Changes made since then are replaced.`,
    ),
  ).toBeTruthy();
  expect(
    within(dialog)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent),
  ).toEqual(["Now", when]);
});

test("Restore from a file… keeps the file review", async () => {
  vi.mocked(workspaceClient.chooseBackupFile).mockResolvedValue("/b/other.db");
  vi.mocked(workspaceClient.inspectBackup).mockResolvedValue({
    ...INSPECTION,
    path: "/b/other.db",
  });
  renderPage(syncStatus());
  await screen.findByRole("button", { name: /^Restore…/ });
  fireEvent.click(screen.getByRole("button", { name: "Restore from a file…" }));

  const dialog = await screen.findByRole("dialog", {
    name: "Replace this workspace?",
  });
  await within(dialog).findByText(/Integrity checked/);
  expect(within(dialog).getByLabelText("Chosen backup file")).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "Replace workspace" }),
  ).toBeTruthy();
});

test("a point that cannot be restored hands over to the file review when another file is chosen", async () => {
  vi.mocked(workspaceClient.inspectBackup).mockResolvedValueOnce({
    ...INSPECTION,
    check: { status: "not_ticketd" },
  });
  renderPage(notConnected());
  fireEvent.click(await screen.findByRole("button", { name: /^Restore…/ }));
  const dialog = await screen.findByRole("dialog", { name: "Review backup" });

  // Cancelling the picker keeps the point.
  vi.mocked(workspaceClient.chooseBackupFile).mockResolvedValueOnce(null);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Choose another file…" }),
  );
  await waitFor(() =>
    expect(workspaceClient.chooseBackupFile).toHaveBeenCalledTimes(1),
  );

  vi.mocked(workspaceClient.chooseBackupFile).mockResolvedValueOnce(
    "/b/other.db",
  );
  vi.mocked(workspaceClient.inspectBackup).mockResolvedValueOnce({
    ...INSPECTION,
    path: "/b/other.db",
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Choose another file…" }),
  );

  const file = await screen.findByRole("dialog", {
    name: "Replace this workspace?",
  });
  await within(file).findByText(/Integrity checked/);
  expect(
    within(file).getByLabelText("Chosen backup file").textContent,
  ).toContain("other.db");
  expect(file.textContent).not.toContain("With the restore point from");
});
