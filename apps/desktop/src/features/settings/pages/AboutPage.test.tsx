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
import { workspaceClient } from "@/lib/api/workspace";
import { APP_VERSION } from "@/lib/app-version";
import { AboutPage } from "@/features/settings/pages/AboutPage";
import { SettingsStateProvider } from "@/features/settings/settings-state";

vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { openLink: vi.fn() },
}));
vi.mock("@/lib/api/cli", () => ({ cliClient: { check: vi.fn() } }));
vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn(async () => []) },
}));

beforeEach(() => {
  vi.mocked(workspaceClient.openLink).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
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

test("three tiles state what ticketd promises", () => {
  renderPage();
  const tiles = within(
    screen.getByRole("list", { name: "How ticketd works" }),
  ).getAllByRole("listitem");
  expect(tiles.map((tile) => tile.textContent)).toEqual([
    "No accountticketd has no account to sign up for.",
    "Works offlineEverything you do runs on this computer.",
    "Stays on this computerNo analytics or crash uploads. Only integrations you turn on, such as Google Drive and GitHub, go online.",
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
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't open the documentation. No browser.",
  );
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
