import { revealFailureDetails } from "@/test/failure-details";
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
  workspaceClient,
  type RestorePoint,
  type RestorePointList,
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

const summary = {
  last_change: null,
  tickets: 26,
  activities: 0,
  documents: 5,
  evidence: 0,
  projects: 0,
  plans: 0,
};

/** A restore point saved `days` days ago at 08:52 local time. */
function point(days: number, over: Partial<RestorePoint> = {}): RestorePoint {
  const saved = new Date();
  saved.setDate(saved.getDate() - days);
  saved.setHours(8, 52, 0, 0);
  return {
    path: `/w/workspace.sqlite3.restore-points/day-${days}.sqlite3`,
    kind: "daily",
    saved_at: saved.toISOString(),
    size_bytes: 1000,
    summary,
    problem: null,
    ...over,
  };
}
const listOf = (
  points: RestorePoint[],
  total_bytes = 1000,
): RestorePointList => ({ points, total_bytes });

beforeEach(() => {
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue(listOf([]));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(onRestore: () => Promise<void> = async () => {}) {
  return render(<BackupsSection onRestore={onRestore} />);
}
const backUpButton = () =>
  screen.getByRole("button", { name: /^Back up now|^Backing up…/ });

test("the list is a loading row until the points are read", async () => {
  let resolve: (value: RestorePointList) => void = () => {};
  vi.mocked(workspaceClient.restorePoints).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  renderPage();
  expect(screen.getByRole("status", { name: "Listing the restore points" }));
  expect(screen.queryByText("No restore points yet")).toBeNull();
  resolve(listOf([point(0)]));
  expect(await screen.findByText(/^Today, /)).toBeTruthy();
});

test("with none yet it says when the first one is saved", async () => {
  renderPage();
  expect(await screen.findByText("No restore points yet")).toBeTruthy();
  expect(
    screen.getByText("One is saved the first time ticketd opens each day."),
  ).toBeTruthy();
});

test("points are rows, newest first, with their counts and Restore…", async () => {
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue(
    listOf([point(0), point(1), point(2)]),
  );
  renderPage();
  const section = screen.getByRole("region", { name: "Restore points" });
  const rows = await within(section).findAllByRole("button", {
    name: /^Restore…/,
  });
  expect(rows).toHaveLength(3);
  const titles = [...section.querySelectorAll(".settings-list-row-title")].map(
    (title) => title.textContent,
  );
  expect(titles[0]).toMatch(/^Today, /);
  expect(titles[1]).toMatch(/^Yesterday, /);
  expect(titles[2]).toMatch(/, /);
  expect(within(section).getAllByText("26 tickets · 5 Documents")).toHaveLength(
    3,
  );
  expect(
    within(section).getByText(
      "Copies to come back to, saved on this computer every day. The last 7 are kept.",
    ),
  ).toBeTruthy();
});

test("a copy that was not a daily one carries its label", async () => {
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue(
    listOf([
      point(0, { kind: "manual" }),
      point(1, { kind: "pre_migration", update_version: "0.1.0" }),
      point(2, { kind: "safety" }),
      point(3, { kind: "pre_migration" }),
    ]),
  );
  renderPage();
  await screen.findByText("Saved by you");
  fireEvent.click(screen.getByRole("button", { name: "Show all" }));
  expect(screen.getByText("Before the 0.1.0 update")).toBeTruthy();
  expect(screen.getByText("Before restoring")).toBeTruthy();
  expect(screen.getByText("Before an update")).toBeTruthy();
});

test("three rows show; the footer counts the older ones and Show all lists them", async () => {
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue(
    listOf([0, 1, 2, 3, 4, 5, 6, 7].map((days) => point(days))),
  );
  renderPage();
  const section = screen.getByRole("region", { name: "Restore points" });
  await within(section).findAllByRole("button", { name: /^Restore…/ });
  expect(
    within(section).getAllByRole("button", { name: /^Restore…/ }),
  ).toHaveLength(3);
  const footer = section.querySelector(
    ".settings-list-footer-text",
  ) as HTMLElement;
  expect(footer.textContent).toMatch(/^5 older, back to .+ · Show all$/);
  fireEvent.click(within(footer).getByRole("button", { name: "Show all" }));
  expect(
    within(section).getAllByRole("button", { name: /^Restore…/ }),
  ).toHaveLength(8);
  fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
  expect(
    within(section).getAllByRole("button", { name: /^Restore…/ }),
  ).toHaveLength(3);
});

test("the footer shows the disk the points use only past 1 GB", async () => {
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue(
    listOf([point(0)], 900 * 1024 ** 2),
  );
  const { unmount } = renderPage();
  await screen.findByText(/^Today, /);
  expect(
    document.querySelector(".settings-list-footer-text")?.textContent,
  ).toBe("");
  unmount();
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue(
    listOf([point(0)], 2.5 * 1024 ** 3),
  );
  renderPage();
  await screen.findByText("2.5 GB");
});

test("a point that failed its check says it can't be restored, with the reason, and has no Restore…", async () => {
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue(
    listOf([
      point(0, {
        summary: null,
        problem: "this backup is damaged: foreign key check failed",
      }),
    ]),
  );
  renderPage();
  expect(await screen.findByText("Can't be restored")).toBeTruthy();
  expect(
    screen.getByText("This backup is damaged: foreign key check failed."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Restore…/ })).toBeNull();
});

test("Back up now saves a point with no file dialog and shows it", async () => {
  vi.mocked(workspaceClient.restorePoints).mockResolvedValueOnce(listOf([]));
  let finish: (saved: RestorePoint) => void = () => {};
  vi.mocked(workspaceClient.saveRestorePoint).mockReturnValue(
    new Promise((done) => {
      finish = done;
    }),
  );
  renderPage();
  await screen.findByText("No restore points yet");
  fireEvent.click(backUpButton());
  expect(screen.getByRole("button", { name: "Backing up…" })).toHaveProperty(
    "disabled",
    true,
  );
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue(
    listOf([point(0, { kind: "manual" })]),
  );
  finish(point(0, { kind: "manual" }));
  expect(await screen.findByText("Saved by you")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Restore point saved.");
  expect(workspaceClient.saveRestorePoint).toHaveBeenCalledTimes(1);
  expect(backUpButton()).toHaveProperty("disabled", false);
});

test("a failed Back up now says why and keeps the list", async () => {
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue(
    listOf([point(0)]),
  );
  vi.mocked(workspaceClient.saveRestorePoint).mockRejectedValue(
    new Error("disk is full"),
  );
  renderPage();
  await screen.findByText(/^Today, /);
  fireEvent.click(backUpButton());
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't save a restore point");
  await revealFailureDetails(alert);
  expect(alert.textContent).toContain("disk is full");
  expect(screen.getByText(/^Today, /)).toBeTruthy();
});

test("a failed read is its own state with Retry, never No restore points yet", async () => {
  vi.mocked(workspaceClient.restorePoints).mockRejectedValueOnce(
    new Error("no access"),
  );
  renderPage();
  const section = screen.getByRole("region", { name: "Restore points" });
  const alert = await within(section).findByRole("alert");
  expect(alert.textContent).toContain("Couldn't list the restore points");
  expect(within(section).queryByText("No restore points yet")).toBeNull();
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue(
    listOf([point(0)]),
  );
  fireEvent.click(within(section).getByRole("button", { name: "Retry" }));
  expect(await within(section).findByText(/^Today, /)).toBeTruthy();
});

test("Restore… opens today's review for that point's file", async () => {
  const saved = point(0);
  vi.mocked(workspaceClient.restorePoints).mockResolvedValue(listOf([saved]));
  vi.mocked(workspaceClient.inspectBackup).mockReturnValue(
    new Promise(() => {}),
  );
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: /^Restore…/ }));
  expect(
    await screen.findByRole("dialog", { name: "Replace this workspace?" }),
  ).toBeTruthy();
  expect(workspaceClient.inspectBackup).toHaveBeenCalledWith(saved.path);
  expect(workspaceClient.chooseBackupFile).not.toHaveBeenCalled();
});

test("Restore from a file… chooses a file first, then opens the same review", async () => {
  vi.mocked(workspaceClient.chooseBackupFile).mockResolvedValue("/b/x.sqlite3");
  vi.mocked(workspaceClient.inspectBackup).mockResolvedValue({
    path: "/b/x.sqlite3",
    current: summary,
    check: { status: "not_ticketd" },
  });
  renderPage();
  await screen.findByText("No restore points yet");
  fireEvent.click(screen.getByRole("button", { name: "Restore from a file…" }));
  expect(
    await screen.findByRole("dialog", { name: "Replace this workspace?" }),
  ).toBeTruthy();
  expect(workspaceClient.chooseBackupFile).toHaveBeenCalledWith({
    title: "Choose a ticketd backup",
  });
  await waitFor(() =>
    expect(workspaceClient.inspectBackup).toHaveBeenCalledWith("/b/x.sqlite3"),
  );
});

test("cancelling the file dialog opens nothing and shows no error", async () => {
  vi.mocked(workspaceClient.chooseBackupFile).mockResolvedValue(null);
  renderPage();
  await screen.findByText("No restore points yet");
  fireEvent.click(screen.getByRole("button", { name: "Restore from a file…" }));
  await waitFor(() =>
    expect(workspaceClient.chooseBackupFile).toHaveBeenCalledTimes(1),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
