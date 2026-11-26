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
import { workspaceClient } from "@/lib/api/workspace";
import { fileManagerName } from "@/lib/platform";
import { revealFailureDetails } from "@/test/failure-details";

// The Tauri commands the Diagnostics page calls, answered by name.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { chooseSavePath: vi.fn(), reveal: vi.fn() },
}));
// Settings reads these for the nav's setup dots; this page ignores them.
vi.mock("@/lib/api/cli", () => ({
  cliClient: { check: vi.fn(() => new Promise(() => {})) },
}));
vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn(async () => []) },
}));

type Level = { level: string; debug: boolean; env_override: string | null };
type Group = {
  target: string;
  kind: string;
  level: "ERROR" | "WARN";
  count: number;
  first_seen: string;
  last_seen: string;
};

const quiet: Level = { level: "info", debug: false, env_override: null };
let level: Level;
let errors: Group[];
const writeText = vi.fn();

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
      case "diagnostics_set_debug":
        level = {
          ...level,
          level: (args as { enabled: boolean }).enabled ? "debug" : "info",
          debug: (args as { enabled: boolean }).enabled,
        };
        return level;
      case "diagnostics_recent_errors":
        return errors;
      case "diagnostics_export_file_name":
        return "ticketd-diagnostics-2026-11-19.zip";
      case "diagnostics_summary":
        return "ticketd 0.1.0\nmacos 15.1 aarch64";
      case "diagnostics_export":
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
  answer();
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue(
    "/Users/me/Desktop/ticketd-diagnostics-2026-11-19.zip",
  );
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderPage() {
  render(<SettingsView selected="diagnostics" onRestore={async () => {}} />);
  // The page reads the level and the recent errors when it opens.
  await screen.findByText(/Level: |sets the level/);
  await screen.findAllByText(/No recent errors|Error in|Warning in/);
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

test("the Debug logging switch shows the level and changes it right away", async () => {
  await renderPage();
  const toggle = screen.getByRole("switch", { name: "Debug logging" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText(/Level: info\./)).toBeTruthy();
  expect(screen.getByText(/until ticketd restarts/)).toBeTruthy();

  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(calls("diagnostics_set_debug")).toEqual([
    ["diagnostics_set_debug", { enabled: true }],
  ]);
  await screen.findByText(/Level: debug\./);

  fireEvent.click(toggle);
  await waitFor(() =>
    expect(toggle.getAttribute("aria-checked")).toBe("false"),
  );
  expect(calls("diagnostics_set_debug")[1]).toEqual([
    "diagnostics_set_debug",
    { enabled: false },
  ]);
});

test("Debug logging that is already on when the page opens is shown as on", async () => {
  level = { level: "debug", debug: true, env_override: null };
  answer();
  await renderPage();
  expect(
    screen
      .getByRole("switch", { name: "Debug logging" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("a TICKETD_LOG override is shown and the switch is disabled", async () => {
  level = {
    level: "ticketd=trace",
    debug: false,
    env_override: "ticketd=trace",
  };
  answer();
  await renderPage();
  expect(screen.getByText("TICKETD_LOG=ticketd=trace")).toBeTruthy();
  expect(screen.getByText(/sets the level for this launch/)).toBeTruthy();
  const toggle = screen.getByRole("switch", { name: "Debug logging" });
  expect(toggle.hasAttribute("disabled")).toBe(true);
  fireEvent.click(toggle);
  expect(calls("diagnostics_set_debug")).toEqual([]);
});

test("a switch that cannot change the level says why and stays where it was", async () => {
  answer({
    diagnostics_set_debug: () => Promise.reject("The logs are closed"),
  });
  await renderPage();
  const toggle = screen.getByRole("switch", { name: "Debug logging" });
  fireEvent.click(toggle);
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain(
    "The logs are closed",
  );
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.hasAttribute("disabled")).toBe(false);
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

test("Export diagnostics… saves the zip where the dialog says and names it", async () => {
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics…" }));
  const saved = await screen.findByText(
    /Saved ticketd-diagnostics-2026-11-19\.zip/,
  );
  expect(saved.textContent).toBe(
    `Saved ticketd-diagnostics-2026-11-19.zip and showed it in ${fileManagerName()}.`,
  );
  expect(workspaceClient.chooseSavePath).toHaveBeenCalledWith(
    expect.objectContaining({
      defaultPath: "ticketd-diagnostics-2026-11-19.zip",
      extension: "zip",
    }),
  );
  expect(calls("diagnostics_export")).toEqual([
    [
      "diagnostics_export",
      { destination: "/Users/me/Desktop/ticketd-diagnostics-2026-11-19.zip" },
    ],
  ]);
});

test("the footer warns that a public GitHub issue is public", async () => {
  await renderPage();
  expect(
    screen.getByText(
      "Files attached to a public GitHub issue can be read by anyone.",
    ),
  ).toBeTruthy();
});

test("cancelling the save dialog writes nothing and shows no error", async () => {
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue(null);
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics…" }));
  await waitFor(() =>
    expect(workspaceClient.chooseSavePath).toHaveBeenCalledTimes(1),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Export diagnostics…" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(calls("diagnostics_export")).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/Saved ticketd-diagnostics/)).toBeNull();
});

test("a failed export says why and Retry reopens the save dialog", async () => {
  answer({ diagnostics_export: () => Promise.reject("disk full") });
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics…" }));
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain("disk full");
  expect(screen.queryByText(/Saved ticketd-diagnostics/)).toBeNull();

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

test("Copy summary puts the summary on the clipboard and says Copied", async () => {
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Copy summary" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("ticketd 0.1.0\nmacos 15.1 aarch64"),
  );
  await screen.findByRole("button", { name: "Copied" });
  expect(calls("diagnostics_summary")).toHaveLength(1);
});

test("a summary that cannot be read is reported and nothing is copied", async () => {
  answer({ diagnostics_summary: () => Promise.reject("The logs are closed") });
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Copy summary" }));
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain(
    "The logs are closed",
  );
  expect(writeText).not.toHaveBeenCalled();
});

test("a clipboard that refuses is reported", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  await renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Copy summary" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't copy summary",
    ),
  );
});

test("Recent errors lists each kind with how often and when it last happened", async () => {
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
  expect(rows[0]?.textContent).toContain("Warning in Workspace sync");
  expect(rows[0]?.textContent).toContain("3 times, last");
  expect(rows[1]?.textContent).toContain("Previous session ended unexpectedly");
  expect(rows[1]?.textContent).toContain("Warning in App");
  expect(rows[1]?.textContent).toContain("1 time, last");
  expect(rows[2]?.textContent).toContain("TypeError");
  expect(rows[2]?.textContent).toContain("Error in App");
  expect(rows[2]?.textContent).toContain("12 times, last");
  expect(screen.queryByText("No recent errors")).toBeNull();
});

test("Recent errors names the area of the app, not the module", async () => {
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
  ["Workspace sync", "Automations", "Chats", "Sources", "Reminders"].forEach(
    (area, index) =>
      expect(rows[index]?.textContent).toContain(`Warning in ${area}`),
  );
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
  expect(screen.getByRole("switch", { name: "Debug logging" })).toBeTruthy();

  answer();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });
  await screen.findByText("No recent errors");
  expect(screen.queryByRole("alert")).toBeNull();
});
