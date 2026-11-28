// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SettingsNav } from "@/features/settings/SettingsNav";
import { setDetailedLogging } from "@/features/settings/detailed-logging";
import {
  SettingsStateContext,
  type SettingsState,
} from "@/features/settings/use-settings-state";
import { SyncStatusContext } from "@/features/sync/sync-status";
import { syncStatus } from "@/features/sync/sync-fixtures";
import { SourceActivityContext } from "@/features/tickets/source-activity";
import {
  UpdatesContext,
  initialUpdateState,
} from "@/features/updates/update-state";
import type { UpdateSnapshot } from "@/features/updates/client";
import type { SourceEntry, SourceStatus } from "@/lib/api/sources";
import type { SyncStatus } from "@/lib/sync-api";
import type { GithubIntegration } from "@/lib/api/github";
import { beaconSource, githubIntegration } from "@/test/source-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(() => setDetailedLogging(null));
afterEach(cleanup);

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

/** The Settings nav over what the app reads; every reading is optional. */
function nav({
  needsSetup = {},
  sync = syncStatus(),
  entries = [],
  health = [],
  github = null,
  update = initialUpdateState,
}: {
  needsSetup?: SettingsState["needsSetup"];
  sync?: SyncStatus;
  entries?: SourceEntry[];
  health?: SourceStatus[];
  github?: GithubIntegration | null;
  update?: UpdateSnapshot;
} = {}) {
  const wrap = (children: ReactNode) => (
    <SettingsStateContext.Provider
      value={{
        query: "",
        setQuery: () => {},
        openPage: () => {},
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
        <SourceActivityContext.Provider
          value={{
            refreshing: false,
            sources: health,
            entries,
            github,
            intervalSecs: null,
            openSettings: () => {},
            refreshAll: async () => {},
          }}
        >
          <UpdatesContext.Provider
            value={{
              snapshot: update,
              setAutomatic: async () => {},
              openRestart: () => {},
              dismiss: async () => {},
            }}
          >
            {children}
          </UpdatesContext.Provider>
        </SourceActivityContext.Provider>
      </SyncStatusContext.Provider>
    </SettingsStateContext.Provider>
  );
  render(wrap(<SettingsNav onBack={() => {}} />));
}

const page = (id: string) =>
  within(
    screen
      .getByRole("navigation", { name: "Settings sections" })
      .querySelector(`[data-responsive-navigation="settings-section:${id}"]`)!,
  );
const marks = () =>
  within(
    screen.getByRole("navigation", { name: "Settings sections" }),
  ).queryAllByRole("img");

test("when everything is healthy no page carries a mark", () => {
  nav();
  expect(marks()).toHaveLength(0);
});

test("a stopped sync marks Workspace sync, in the words its status row uses, and nothing else", () => {
  nav({
    sync: syncStatus({
      state: "needs_attention",
      recovery: "authorization_expired",
    }),
  });
  expect(
    page("workspace-sync").getByRole("img", { name: "Signed out" }),
  ).toBeTruthy();
  expect(marks()).toHaveLength(1);
});

test("sync that is offline or slowed down mends itself, so it asks for nothing", () => {
  nav({ sync: syncStatus({ state: "saved_locally", recovery: "offline" }) });
  expect(marks()).toHaveLength(0);
});

test("a source that needs sign-in marks Ticket sources", () => {
  nav({ github: githubIntegration("not_signed_in") });
  expect(
    page("ticket-sources").getByRole("img", { name: "Needs sign-in" }),
  ).toBeTruthy();
  expect(marks()).toHaveLength(1);
});

test("a connection whose extension is missing marks Ticket sources as unavailable", () => {
  nav({ entries: [{ ...beaconSource, unavailable: true }] });
  expect(
    page("ticket-sources").getByRole("img", { name: "Unavailable" }),
  ).toBeTruthy();
});

test("the command line and the skills each mark their own page", () => {
  nav({ needsSetup: { "command-line": true, "agent-skills": false } });
  expect(
    page("command-line").getByRole("img", { name: "Needs setup" }),
  ).toBeTruthy();
  expect(page("agent-skills").queryByRole("img")).toBeNull();
});

test("an update the person put off marks About, and one still announced does not", () => {
  nav({ update: ready });
  expect(page("about").getByRole("img", { name: "Update ready" })).toBeTruthy();
  cleanup();
  nav({ update: { ...ready, dismissed: false } });
  expect(marks()).toHaveLength(0);
});

test("detailed logging marks Diagnostics while a report is open", () => {
  setDetailedLogging(new Date().toISOString());
  nav();
  expect(
    page("diagnostics").getByRole("img", { name: "Detailed logging is on" }),
  ).toBeTruthy();
});

test("several problems each mark only their own page", () => {
  nav({
    needsSetup: { "command-line": true },
    sync: syncStatus({ state: "needs_attention", recovery: "folder_missing" }),
    github: githubIntegration("not_signed_in"),
  });
  expect(marks().map((mark) => mark.getAttribute("aria-label"))).toEqual([
    "Folder missing",
    "Needs setup",
    "Needs sign-in",
  ]);
  expect(screen.queryByRole("img", { name: "Update ready" })).toBeNull();
});
