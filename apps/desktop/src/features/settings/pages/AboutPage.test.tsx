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

test("three tiles state what ticketd promises", () => {
  renderPage();
  const tiles = within(
    screen.getByRole("list", { name: "How ticketd works" }),
  ).getAllByRole("listitem");
  expect(tiles.map((tile) => tile.textContent)).toEqual([
    "No accountticketd has no account to sign up for.",
    "Works offlineEverything you do runs on this computer.",
    "Stays on this computerNo analytics or crash uploads. Only update checks and the integrations you turn on, such as Google Drive and GitHub, go online.",
  ]);
});

test.each([
  ["Documentation", "https://github.com/vantoan19/ticketd#readme"],
  ["Report an issue", "https://github.com/vantoan19/ticketd/issues"],
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

test("the issue row asks for the version", () => {
  renderPage();
  expect(
    screen.getByRole("link", { name: /Include the version above\./ }),
  ).toBeTruthy();
});

test("Keyboard shortcuts opens that page", () => {
  const openPage = renderPage();
  fireEvent.click(screen.getByRole("button", { name: /^Keyboard shortcuts/ }));
  expect(openPage).toHaveBeenCalledWith("keyboard-shortcuts");
});
