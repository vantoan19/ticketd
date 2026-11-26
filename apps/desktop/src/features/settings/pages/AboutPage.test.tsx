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
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { UpdatesProvider } from "@/features/updates/UpdatesProvider";
import { workspaceClient } from "@/lib/api/workspace";
import { APP_VERSION } from "@/lib/app-version";
import { AboutPage } from "@/features/settings/pages/AboutPage";
import { SettingsStateProvider } from "@/features/settings/settings-state";
import { SyncStatusContext } from "@/features/sync/sync-status";
import type { SyncStatus } from "@/lib/sync-api";

vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { openLink: vi.fn() },
}));
// Settings reads the CLI for its nav dot at startup; these pages ignore it.
vi.mock("@/lib/api/cli", () => ({
  cliClient: { check: vi.fn(() => new Promise(() => {})) },
}));
vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn(async () => []) },
}));

beforeEach(() => {
  vi.mocked(workspaceClient.openLink).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  clearMocks();
  vi.clearAllMocks();
});

function renderPage(onOpenPage = vi.fn()) {
  render(
    <SettingsStateProvider active={false} onOpenPage={onOpenPage}>
      <AboutPage />
    </SettingsStateProvider>,
  );
  return onOpenPage;
}

test("the wordmark is the h1, with the version and what ticketd is", () => {
  renderPage();
  const heading = screen.getByRole("heading", { level: 1 });
  expect(heading.textContent).toBe("ticketd");
  expect(screen.getByText(`Version ${APP_VERSION}`)).toBeTruthy();
  expect(screen.getByText("Desktop app and command line")).toBeTruthy();
});

test("About offers an update check and an enabled-by-default automatic check switch", () => {
  renderPage();
  expect(screen.getByRole("heading", { name: "Updates" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Check for updates" }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("switch", { name: "Check for updates automatically" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("a verified update asks before stopping work and upgrading the workspace", async () => {
  const install = vi.fn();
  mockIPC(
    (command) => {
      if (command === "updates_state")
        return {
          revision: 1,
          automatic: true,
          dismissed: true,
          install_on_quit: true,
          status: "ready",
          update: {
            version: "0.2.0",
            release_url:
              "https://github.com/vantoan19/ticketd/releases/tag/v0.2.0",
            upgrades_workspace: true,
          },
        };
      if (command === "updates_restart_details") return { chats: 2, runs: 1 };
      if (command === "updates_install") install();
    },
    { shouldMockEvents: true },
  );
  render(
    <UpdatesProvider beforeInstall={async () => {}}>
      <SettingsStateProvider active={false} onOpenPage={() => {}}>
        <AboutPage />
      </SettingsStateProvider>
    </UpdatesProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Restart to update" }),
  );
  const dialog = within(
    screen.getByRole("dialog", { name: /Restart to update to ticketd 0.2.0/ }),
  );
  expect(
    await dialog.findByText("2 Chats and 1 Automation run are going"),
  ).toBeTruthy();
  expect(dialog.getByText("This update upgrades your workspace")).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Not now" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(install).not.toHaveBeenCalled();
});

test.each([
  ["Documentation", "https://github.com/vantoan19/ticketd#readme"],
  ["Privacy", "https://github.com/vantoan19/ticketd/blob/main/PRIVACY.md"],
  [
    "Third-party notices",
    "https://github.com/vantoan19/ticketd/blob/main/THIRD_PARTY_NOTICES.md",
  ],
])("%s opens its page in the browser", async (name, url) => {
  renderPage();
  fireEvent.click(screen.getByRole("link", { name: new RegExp(`^${name}`) }));
  await waitFor(() =>
    expect(workspaceClient.openLink).toHaveBeenCalledWith(url),
  );
});

test("a link that cannot open says so", async () => {
  vi.mocked(workspaceClient.openLink).mockRejectedValue("no browser");
  renderPage();
  fireEvent.click(screen.getByRole("link", { name: /^Documentation/ }));
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain("no browser");
});

test("Report an issue opens GitHub's bug form with the version and system filled in", async () => {
  mockIPC((command) => {
    if (command === "diagnostics_issue_details")
      return {
        version: "0.2.0 (commit 361b5938)",
        environment: "macOS 15.1 aarch64, desktop app",
      };
  });
  renderPage();
  expect(
    screen.getByText("Opens GitHub’s bug form with your version filled in."),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: /^Report an issue/ }));
  await waitFor(() => expect(workspaceClient.openLink).toHaveBeenCalled());
  const url = new URL(vi.mocked(workspaceClient.openLink).mock.calls[0]![0]);
  expect(url.origin + url.pathname).toBe(
    "https://github.com/vantoan19/ticketd/issues/new",
  );
  expect(url.searchParams.get("template")).toBe("bug_report.yml");
  expect(url.searchParams.get("version")).toBe("0.2.0 (commit 361b5938)");
});

test("the header is the version and one promise line, and Help holds the four links", () => {
  renderPage();
  expect(
    screen.getByText("No account · Works offline · No analytics"),
  ).toBeTruthy();
  expect(screen.queryByRole("list", { name: "How ticketd works" })).toBeNull();
  expect(screen.queryByText(/Keyboard shortcuts/)).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Privacy and notices" }),
  ).toBeNull();
  const help = screen
    .getByRole("heading", { name: "Help" })
    .closest("section")!;
  expect(
    within(help)
      .getAllByRole("link")
      .map((link) => link.querySelector(".about-link-title")?.textContent),
  ).toEqual([
    "Documentation",
    "Report an issue",
    "Privacy",
    "Third-party notices",
  ]);
});

test("About ends with a Support ticketd section that stars the repository", async () => {
  renderPage();
  expect(screen.getByRole("heading", { name: "Support ticketd" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Star on GitHub" }));
  await waitFor(() =>
    expect(workspaceClient.openLink).toHaveBeenCalledWith(
      "https://github.com/vantoan19/ticketd",
    ),
  );
});

const update = (upgrades_workspace: boolean) => ({
  version: "0.3.0",
  release_url: "https://github.com/vantoan19/ticketd/releases/tag/v0.3.0",
  upgrades_workspace,
});

function renderUpdates(snapshot: object, syncing = false) {
  mockIPC(
    (command) => {
      if (command === "updates_state")
        return {
          revision: 1,
          automatic: true,
          dismissed: false,
          install_on_quit: false,
          ...snapshot,
        };
    },
    { shouldMockEvents: true },
  );
  const status = syncing
    ? ({ connection: "connected" } as SyncStatus)
    : ({ connection: "not_connected" } as SyncStatus);
  render(
    <SyncStatusContext
      value={{
        status,
        apply: () => {},
        refresh: () => Promise.resolve(status),
        openSettings: () => {},
        openReview: () => {},
      }}
    >
      <UpdatesProvider beforeInstall={async () => {}}>
        <SettingsStateProvider active={false} onOpenPage={() => {}}>
          <AboutPage />
        </SettingsStateProvider>
      </UpdatesProvider>
    </SyncStatusContext>,
  );
}

test("up to date says so, when it last checked, and what the automatic check sends", async () => {
  renderUpdates({
    status: "up_to_date",
    checked_at: Math.floor(Date.now() / 1000) - 3600,
  });
  expect(
    await screen.findByText(`ticketd ${APP_VERSION} is up to date`),
  ).toBeTruthy();
  expect(screen.getByText(/^Checked /)).toBeTruthy();
  expect(
    screen.getByText(
      "Once a day, from GitHub. Nothing about you or your Workspace is sent.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Check for updates" }),
  ).toBeTruthy();
});

test("an ordinary update installs when ticketd restarts and has no warning", async () => {
  renderUpdates({
    status: "ready",
    install_on_quit: true,
    update: update(false),
  });
  expect(await screen.findByText("ticketd 0.3.0 is ready")).toBeTruthy();
  expect(
    screen.getByText(
      "Downloaded and checked. It installs when ticketd restarts.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/older versions can’t open it/)).toBeNull();
  expect(screen.getByRole("link", { name: "What’s new" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Restart to update" }),
  ).toBeTruthy();
});

test("an update that raises the format warns first, never installs on quit, and asks to update the other computers while syncing", async () => {
  renderUpdates(
    { status: "ready", install_on_quit: true, update: update(true) },
    true,
  );
  expect(
    await screen.findByText(
      "It upgrades your Workspace, and older versions can’t open it after. Update your other computers too.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/installs when ticketd restarts/)).toBeNull();
  expect(
    screen.getByRole("button", { name: "Restart to update" }),
  ).toBeTruthy();
});

test("without sync, the format warning doesn't ask about other computers", async () => {
  renderUpdates({ status: "ready", update: update(true) });
  expect(
    await screen.findByText(
      "It upgrades your Workspace, and older versions can’t open it after.",
    ),
  ).toBeTruthy();
});
