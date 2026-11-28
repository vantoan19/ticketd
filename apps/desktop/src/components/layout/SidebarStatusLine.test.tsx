// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SourceStatusFooter } from "@/components/layout/SourceStatusFooter";
import { setDetailedLogging } from "@/features/settings/detailed-logging";
import {
  SettingsStateContext,
  type SettingsState,
} from "@/features/settings/use-settings-state";
import {
  SyncStatusContext,
  type SyncStatusValue,
} from "@/features/sync/sync-status";
import { syncStatus } from "@/features/sync/sync-fixtures";
import {
  SourceActivityContext,
  type SourceActivity,
} from "@/features/tickets/source-activity";
import { UpdatesContext } from "@/features/updates/update-state";
import { initialUpdateState } from "@/features/updates/update-state";
import type { UpdateSnapshot } from "@/features/updates/client";
import type { SourceEntry, SourceStatus } from "@/lib/api/sources";
import { SettingsNavigation } from "@/lib/settings-navigation";
import {
  beaconSource,
  githubIntegration,
  githubSource,
} from "@/test/source-fixtures";

// The line reads what the app already holds; nothing here reaches a real bridge.
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(() => {
  vi.clearAllMocks();
  setDetailedLogging(null);
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "diagnostics_log_level"
      ? {
          level: "info",
          debug: false,
          env_override: null,
          report_started_at: null,
        }
      : [],
  );
});
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

const openPage = vi.fn();
const openSourceSettings = vi.fn();
const refreshAll = vi.fn(async () => {});
const openRestart = vi.fn();

const connection: SourceEntry = {
  ...githubSource,
  saved: {
    id: "work-github",
    name: "Work GitHub",
    provider: "github",
    config: { repositories: ["acme/api"] },
    account: "sam",
    saved_at: "2026-01-01T00:00:00Z",
  },
};

const health = (overrides: Partial<SourceStatus> = {}): SourceStatus => ({
  provider: "github",
  connection_id: "work-github",
  health: "synced",
  last_attempt_at: null,
  last_refreshed_at: new Date(Date.now() - 120_000).toISOString(),
  error: null,
  failing_since: null,
  retry_after: null,
  unavailable_tickets: 0,
  partial_message: null,
  ...overrides,
});

/** The app's own readings, as the status line sees them. */
function line({
  needsSetup = {},
  sync = null,
  sources = [],
  entries = [],
  github = null,
  update = initialUpdateState,
}: {
  needsSetup?: SettingsState["needsSetup"];
  sync?: SyncStatusValue["status"];
  sources?: SourceStatus[];
  entries?: SourceEntry[];
  github?: SourceActivity["github"];
  update?: UpdateSnapshot;
} = {}) {
  const activity: SourceActivity = {
    refreshing: false,
    sources,
    entries,
    github,
    intervalSecs: 300,
    openSettings: openSourceSettings,
    refreshAll,
  };
  const wrap = (children: ReactNode) => (
    <SettingsNavigation.Provider value={openPage}>
      <SettingsStateContext.Provider
        value={{
          query: "",
          setQuery: () => {},
          openPage,
          needsSetup,
          refreshIndicators: () => {},
        }}
      >
        <SyncStatusContext.Provider
          value={{
            status: sync,
            apply: () => {},
            refresh: () => Promise.reject(new Error("not read")),
            openSettings: () => {},
            openReview: () => {},
          }}
        >
          <SourceActivityContext.Provider value={activity}>
            <UpdatesContext.Provider
              value={{
                snapshot: update,
                setAutomatic: async () => {},
                openRestart,
                dismiss: async () => {},
              }}
            >
              {children}
            </UpdatesContext.Provider>
          </SourceActivityContext.Provider>
        </SyncStatusContext.Provider>
      </SettingsStateContext.Provider>
    </SettingsNavigation.Provider>
  );
  return render(wrap(<SourceStatusFooter />));
}

const ready: UpdateSnapshot = {
  ...initialUpdateState,
  status: "ready",
  dismissed: true,
  update: {
    version: "0.3.0",
    release_url: "https://example.com/releases/0.3.0",
    upgrades_workspace: false,
  },
};

test("with nothing to fix and nothing connected, the status line says nothing", () => {
  const { container } = line();
  expect(container.textContent).toBe("");
});

test("a missing command is one line with one action that opens the Command line page", () => {
  line({ needsSetup: { "command-line": true } });
  expect(screen.getByText("Command needs setup")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Set up the command line" }),
  );
  expect(openPage).toHaveBeenLastCalledWith("command-line");
  // Agent skills are healthy: nothing is said about them.
  expect(screen.queryByText(/Agent skills/)).toBeNull();
});

test("an agent without the skill is its own line and opens Agent skills", () => {
  line({ needsSetup: { "agent-skills": true } });
  fireEvent.click(screen.getByRole("button", { name: /Skills need setup/ }));
  expect(openPage).toHaveBeenLastCalledWith("agent-skills");
  fireEvent.click(screen.getByRole("button", { name: "Set up agent skills" }));
  expect(openPage).toHaveBeenLastCalledWith("agent-skills");
});

test("a Chats problem is marked in Settings but not in the sidebar's status line", () => {
  const { container } = line({ needsSetup: { agents: true } });
  expect(container.textContent).toBe("");
});

test("an update the person put off keeps a line, and Restart asks before installing", () => {
  line({ update: ready });
  expect(screen.getByText("Update ready")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
  expect(openRestart).toHaveBeenCalledWith(
    ready.status === "ready" && ready.update,
  );
});

test("an update still announced by its notice is not said twice", () => {
  const { container } = line({ update: { ...ready, dismissed: false } });
  expect(container.textContent).toBe("");
});

test("an update that needs a manual download opens About", () => {
  line({
    update: {
      ...initialUpdateState,
      status: "manual_install",
      dismissed: true,
      update: ready.status === "ready" ? ready.update : (undefined as never),
    },
  });
  expect(screen.getByText("Update available")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open About" }));
  expect(openPage).toHaveBeenLastCalledWith("about");
});

test("detailed logging is a line that opens Diagnostics", async () => {
  const since = new Date(Date.now() - 120_000).toISOString();
  bridge.invoke.mockImplementation(async () => ({
    level: "debug",
    debug: true,
    env_override: null,
    report_started_at: since,
  }));
  line();
  fireEvent.click(await screen.findByRole("button", { name: "Save report" }));
  expect(openPage).toHaveBeenLastCalledWith("diagnostics");
});

test("GitHub with an expired sign-in opens its integration page", () => {
  line({
    entries: [githubSource],
    github: githubIntegration("not_signed_in"),
    sources: [
      health({
        connection_id: null,
        health: "unavailable",
        error: { code: "unauthenticated", message: "Bad credentials" },
      }),
    ],
  });
  expect(screen.getByText("GitHub needs sign-in")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sign in to GitHub" }));
  expect(openSourceSettings).toHaveBeenLastCalledWith("github");
  expect(refreshAll).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("a source that is only unreachable still offers Retry", () => {
  line({
    entries: [connection],
    sources: [
      health({
        health: "unavailable",
        error: { code: "network", message: "Offline" },
      }),
    ],
  });
  expect(screen.getByText("Work GitHub unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(refreshAll).toHaveBeenCalledTimes(1);
});

test("the folded rail drops the Retry word, as it drops Sign in", () => {
  line({
    entries: [connection],
    sources: [
      health({
        health: "unavailable",
        error: { code: "network", message: "Offline" },
      }),
    ],
  });
  expect(
    screen
      .getByRole("button", { name: "Retry" })
      .hasAttribute("data-rail-hidden"),
  ).toBe(true);
});

test("a connection whose extension is missing gets a line of its own, once", () => {
  line({
    entries: [
      {
        ...beaconSource,
        saved: {
          id: "work-beacon",
          name: "Work Beacon",
          provider: "beacon",
          config: {},
          account: "sam",
          saved_at: "2026-01-01T00:00:00Z",
        },
        unavailable: true,
      },
    ],
  });
  expect(screen.getAllByText("Work Beacon unavailable")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Open Work Beacon" }));
  expect(openSourceSettings).toHaveBeenLastCalledWith("work-beacon");
});

test("sync that stopped stays the one sync line, with its fix a click away", () => {
  line({
    sync: syncStatus({
      state: "needs_attention",
      recovery: "authorization_expired",
    }),
  });
  expect(screen.getAllByText("Drive sign-in expired")).toHaveLength(1);
});

test("problems from several places each get their own line", () => {
  line({
    needsSetup: { "command-line": true, "agent-skills": true },
    update: ready,
  });
  expect(screen.getAllByRole("button", { name: /^Set up/ })).toHaveLength(2);
  expect(
    screen.getByRole("button", { name: "Restart to update" }),
  ).toBeTruthy();
  expect(screen.getByRole("group", { name: "Status" })).toBeTruthy();
});
