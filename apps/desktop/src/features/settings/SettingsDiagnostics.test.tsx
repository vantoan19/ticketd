// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SettingsView } from "@/features/settings/SettingsView";
import { SettingsStateContext } from "@/features/settings/use-settings-state";
import { setDetailedLogging } from "@/features/settings/detailed-logging";
import { workspaceClient } from "@/lib/api/workspace";
import { revealFailureDetails } from "@/test/failure-details";

// The Tauri commands the Diagnostics page calls, answered by name.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: {
    chooseSavePath: vi.fn(),
    reveal: vi.fn(),
    openLink: vi.fn(),
  },
}));
// Settings reads these for the nav's setup dots; this page ignores them.
vi.mock("@/lib/api/cli", () => ({
  cliClient: { check: vi.fn(() => new Promise(() => {})) },
}));
vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn(async () => []) },
}));

type Level = {
  level: string;
  debug: boolean;
  env_override: string | null;
  report_started_at: string | null;
};
type Group = {
  target: string;
  kind: string;
  level: "ERROR" | "WARN";
  count: number;
  first_seen: string;
  last_seen: string;
};

const quiet: Level = {
  level: "info",
  debug: false,
  env_override: null,
  report_started_at: null,
};
const reporting: Level = {
  level: "debug",
  debug: true,
  env_override: null,
  report_started_at: "2026-11-19T07:58:00.000Z",
};
let level: Level;
let errors: Group[];

function group(overrides: Partial<Group> = {}): Group {
  return {
    target: "ticketd_desktop_lib::sync_scheduler",
    kind: "sync pass failed",
    level: "WARN",
    count: 3,
    first_seen: "2026-11-18T08:00:00.000Z",
    last_seen: "2026-11-19T08:00:00.000Z",
    ...overrides,
  };
}

/** Answers each command; `overrides` replaces one with a rejection or another value. */
function answer(overrides: Record<string, () => unknown> = {}) {
  vi.mocked(invoke).mockImplementation(async (command: string, args) => {
    const override = overrides[command];
    if (override) return override();
    switch (command) {
      case "diagnostics_log_level":
        return level;
      case "diagnostics_start_report":
        level = { ...reporting, report_started_at: new Date().toISOString() };
        return level;
      case "diagnostics_cancel_report":
        level = quiet;
        return level;
      case "diagnostics_recent_errors":
        return errors;
      case "diagnostics_export_file_name":
        return "ticketd-diagnostics-2026-11-19.zip";
      case "diagnostics_issue_details":
        return {
          version: "0.2.0 (commit 361b5938)",
          environment: "macOS 15.1 aarch64, desktop app",
        };
      case "diagnostics_save_report":
        // Saving ends the report.
        level = quiet;
        return {
          path: (args as { destination: string }).destination,
          bytes: 2048,
        };
      case "diagnostics_open_logs_folder":
        return null;
      default:
        return [];
    }
  });
}

beforeEach(() => {
  level = quiet;
  errors = [];
  setDetailedLogging(null);
  answer();
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue(
    "/Users/me/Desktop/ticketd-diagnostics-2026-11-19.zip",
  );
  vi.mocked(workspaceClient.reveal).mockResolvedValue(undefined);
  vi.mocked(workspaceClient.openLink).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderPage() {
  render(<SettingsView selected="diagnostics" onRestore={async () => {}} />);
  // The page reads the level and the recent errors when it opens.
  await screen.findByText(/Detailed logging/);
  await screen.findAllByText(/No recent errors| · \d+ times?, last/);
}

const calls = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

test("Diagnostics is a Help page with its own heading", async () => {
  await renderPage();
  expect(
    screen.getByRole("heading", { level: 1, name: "Diagnostics" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("navigation", { name: "Breadcrumb" }).textContent,
  ).toBe("HelpDiagnostics");
});

test("at rest the page offers Start, and no switch, export or copy button", async () => {
  await renderPage();
  expect(screen.getByText("Report a problem")).toBeTruthy();
  expect(
    screen.getByText(
      "Turn it on, repeat what went wrong, then save a report to attach to a GitHub issue.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
  expect(screen.getByText("Kept for 7 days on this computer.")).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Copy summary|Export/ }),
  ).toBeNull();
  expect(
    screen.getByText(
      "Reports never hold the text of your tickets. Anyone can read files on a public GitHub issue.",
    ),
  ).toBeTruthy();
});

test("Start turns detailed logging on and the row says so", async () => {
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("Detailed logging is on");
  expect(calls("diagnostics_start_report")).toHaveLength(1);
  expect(
    screen.getByText(/Repeat what went wrong, then save the report\./),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save report…" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
});

test("a report left open by the last run is still open when the page opens", async () => {
  // The app was restarted since Start: the level it reads carries the report along.
  level = reporting;
  answer();
  render(<SettingsView selected="diagnostics" onRestore={async () => {}} />);
  await screen.findByText("Detailed logging is on");
  expect(screen.getByRole("button", { name: "Save report…" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  expect(calls("diagnostics_start_report")).toEqual([]);
});

test("Cancel ends the report and returns to Start", async () => {
  level = reporting;
  answer();
  render(<SettingsView selected="diagnostics" onRestore={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await screen.findByRole("button", { name: "Start" });
  expect(calls("diagnostics_cancel_report")).toHaveLength(1);
  expect(screen.queryByText("Detailed logging is on")).toBeNull();
  // Nothing was saved or opened.
  expect(calls("diagnostics_save_report")).toEqual([]);
  expect(workspaceClient.chooseSavePath).not.toHaveBeenCalled();
});

test("a report that cannot start says why and stays at rest", async () => {
  answer({
    diagnostics_start_report: () => Promise.reject("The logs are closed"),
  });
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain(
    "The logs are closed",
  );
  expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
});

test("a TICKETD_LOG override is named and Start is disabled", async () => {
  level = {
    level: "ticketd=trace",
    debug: false,
    env_override: "ticketd=trace",
    report_started_at: null,
  };
  answer();
  await renderPage();
  expect(screen.getByText("TICKETD_LOG=ticketd=trace")).toBeTruthy();
  expect(screen.getByText(/sets the level for this launch/)).toBeTruthy();
  const start = screen.getByRole("button", { name: "Start" });
  expect(start.hasAttribute("disabled")).toBe(true);
  fireEvent.click(start);
  expect(calls("diagnostics_start_report")).toEqual([]);
});

test("Save report… writes the zip where the dialog says, ends the report and names the file", async () => {
  level = reporting;
  answer();
  render(<SettingsView selected="diagnostics" onRestore={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Save report…" }));
  const saved = await screen.findByText(
    /Saved ticketd-diagnostics-2026-11-19\.zip/,
  );
  expect(saved.textContent).toBe("Saved ticketd-diagnostics-2026-11-19.zip");
  expect(workspaceClient.chooseSavePath).toHaveBeenCalledWith(
    expect.objectContaining({
      defaultPath: "ticketd-diagnostics-2026-11-19.zip",
      extension: "zip",
    }),
  );
  expect(calls("diagnostics_save_report")).toEqual([
    [
      "diagnostics_save_report",
      { destination: "/Users/me/Desktop/ticketd-diagnostics-2026-11-19.zip" },
    ],
  ]);
  // The report is over: logging detail is off again.
  expect(screen.queryByText("Detailed logging is on")).toBeNull();
  expect(screen.getByRole("button", { name: /Show in/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Open an issue/ })).toBeTruthy();
});

test("Show in Finder reveals the saved file", async () => {
  level = reporting;
  answer();
  render(<SettingsView selected="diagnostics" onRestore={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Save report…" }));
  fireEvent.click(await screen.findByRole("button", { name: /Show in/ }));
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith(
      "/Users/me/Desktop/ticketd-diagnostics-2026-11-19.zip",
    ),
  );
});

test("Open an issue opens GitHub's bug form with the version and system filled in", async () => {
  level = reporting;
  answer();
  render(<SettingsView selected="diagnostics" onRestore={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Save report…" }));
  fireEvent.click(await screen.findByRole("button", { name: /Open an issue/ }));
  await waitFor(() =>
    expect(workspaceClient.openLink).toHaveBeenCalledTimes(1),
  );
  const url = new URL(
    vi.mocked(workspaceClient.openLink).mock.calls[0]?.[0] ?? "",
  );
  expect(`${url.origin}${url.pathname}`).toBe(
    "https://github.com/vantoan19/ticketd/issues/new",
  );
  expect(url.searchParams.get("template")).toBe("bug_report.yml");
  expect(url.searchParams.get("version")).toBe("0.2.0 (commit 361b5938)");
  expect(url.searchParams.get("environment")).toBe(
    "macOS 15.1 aarch64, desktop app",
  );
});

test("an issue form that cannot open says why", async () => {
  level = reporting;
  answer();
  vi.mocked(workspaceClient.openLink).mockRejectedValue(
    new Error("no browser"),
  );
  render(<SettingsView selected="diagnostics" onRestore={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Save report…" }));
  fireEvent.click(await screen.findByRole("button", { name: /Open an issue/ }));
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain("no browser");
});

test("cancelling the save dialog writes nothing and keeps the report open", async () => {
  level = reporting;
  answer();
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue(null);
  render(<SettingsView selected="diagnostics" onRestore={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Save report…" }));
  await waitFor(() =>
    expect(workspaceClient.chooseSavePath).toHaveBeenCalledTimes(1),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Save report…" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(calls("diagnostics_save_report")).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Detailed logging is on")).toBeTruthy();
  expect(calls("diagnostics_cancel_report")).toEqual([]);
});

test("a report that cannot be saved says why, stays open and Retry reopens the save dialog", async () => {
  level = reporting;
  answer({ diagnostics_save_report: () => Promise.reject("disk full") });
  render(<SettingsView selected="diagnostics" onRestore={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Save report…" }));
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain("disk full");
  expect(screen.queryByText(/Saved ticketd-diagnostics/)).toBeNull();
  expect(screen.getByText("Detailed logging is on")).toBeTruthy();

  answer();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(/Saved ticketd-diagnostics-2026-11-19\.zip/);
  expect(workspaceClient.chooseSavePath).toHaveBeenCalledTimes(2);
  // The second dialog starts where the first one wrote.
  expect(workspaceClient.chooseSavePath).toHaveBeenLastCalledWith(
    expect.objectContaining({
      defaultPath: "/Users/me/Desktop/ticketd-diagnostics-2026-11-19.zip",
    }),
  );
});

test("Open logs folder asks the app to show the folder", async () => {
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Open logs folder" }));
  await waitFor(() =>
    expect(calls("diagnostics_open_logs_folder")).toHaveLength(1),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a folder that cannot be opened is reported", async () => {
  answer({
    diagnostics_open_logs_folder: () =>
      Promise.reject("There is no logs folder on this computer"),
  });
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Open logs folder" }));
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain(
    "There is no logs folder",
  );
});

test("Recent errors lists each kind with its setting, how often and when it last happened", async () => {
  errors = [
    group({ count: 3 }),
    group({
      target: "ticketd_diagnostics",
      kind: "previous session ended unexpectedly",
      count: 1,
      level: "WARN",
    }),
    group({
      target: "ticketd::webview",
      kind: "TypeError",
      level: "ERROR",
      count: 12,
    }),
  ];
  answer();
  await renderPage();
  const list = screen.getByRole("list", { name: "Recent errors" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows).toHaveLength(3);
  expect(rows[0]?.textContent).toContain("Sync pass failed");
  expect(rows[0]?.textContent).toContain("Workspace sync · 3 times, last");
  expect(rows[1]?.textContent).toContain("Previous session ended unexpectedly");
  expect(rows[1]?.textContent).toContain("App · 1 time, last");
  expect(rows[2]?.textContent).toContain("TypeError");
  expect(rows[2]?.textContent).toContain("App · 12 times, last");
  expect(screen.queryByText("No recent errors")).toBeNull();
});

test("Recent errors names the setting of the app, not the module", async () => {
  errors = [
    "ticketd_desktop_lib::sync_scheduler",
    "ticketd_automation_runner",
    "ticketd_chat_host::supervisor",
    "ticketd_core::source::tracking",
    "ticketd_core::inbox",
  ].map((target, index) => group({ target, kind: `kind ${index}` }));
  answer();
  await renderPage();
  const list = screen.getByRole("list", { name: "Recent errors" });
  const rows = within(list).getAllByRole("listitem");
  [
    "Workspace sync",
    "Automations",
    "Agents",
    "Ticket sources",
    "Attention",
  ].forEach((page, index) =>
    expect(rows[index]?.textContent).toContain(`${page} · `),
  );
});

test("a recent error opens the setting it names", async () => {
  errors = [
    group({ kind: "the remote file changed" }),
    group({ target: "ticketd_core::source::tracking", kind: "refresh timed out" }),
    group({ target: "ticketd::webview", kind: "TypeError" }),
  ];
  answer();
  const openPage = vi.fn();
  render(
    <SettingsStateContext.Provider
      value={{
        query: "",
        setQuery: () => {},
        openPage,
        needsSetup: {},
        refreshIndicators: () => {},
      }}
    >
      <SettingsView selected="diagnostics" onRestore={async () => {}} />
    </SettingsStateContext.Provider>,
  );
  const rows = within(
    await screen.findByRole("list", { name: "Recent errors" }),
  ).getAllByRole("listitem");
  fireEvent.click(
    within(rows[0] as HTMLElement).getByRole("button", {
      name: /Open Workspace sync/,
    }),
  );
  expect(openPage).toHaveBeenLastCalledWith("workspace-sync");
  fireEvent.click(
    within(rows[1] as HTMLElement).getByRole("button", {
      name: /Open Ticket sources/,
    }),
  );
  expect(openPage).toHaveBeenLastCalledWith("ticket-sources");
  // An error of the app itself has no setting to open.
  expect(within(rows[2] as HTMLElement).queryByRole("button")).toBeNull();
  expect(openPage).toHaveBeenCalledTimes(2);
});

test("Recent errors shows only the five most recent kinds", async () => {
  errors = Array.from({ length: 8 }, (_, index) =>
    group({ kind: `kind ${index}` }),
  );
  answer();
  await renderPage();
  const rows = within(
    screen.getByRole("list", { name: "Recent errors" }),
  ).getAllByRole("listitem");
  expect(rows.map((row) => row.textContent?.slice(0, 6))).toEqual([
    "Kind 0",
    "Kind 1",
    "Kind 2",
    "Kind 3",
    "Kind 4",
  ]);
});

test("with no errors Recent errors is one muted line", async () => {
  await renderPage();
  expect(screen.getByText("No recent errors")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Recent errors" })).toBeNull();
});

test("recent errors that cannot be read offer Retry without hiding the rest", async () => {
  answer({ diagnostics_recent_errors: () => Promise.reject("busy") });
  render(<SettingsView selected="diagnostics" onRestore={async () => {}} />);
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain("busy");
  expect(screen.getByText("Detailed logging")).toBeTruthy();

  answer();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });
  await screen.findByText("No recent errors");
  expect(screen.queryByRole("alert")).toBeNull();
});
