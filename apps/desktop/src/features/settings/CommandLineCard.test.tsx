// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CommandLineCard } from "@/features/settings/CommandLineCard";
import {
  SettingsStateContext,
  type SettingsState,
} from "@/features/settings/use-settings-state";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

const base = {
  found: true,
  on_path: true,
  path: "/Users/a/.local/bin/ticketd",
  version: "0.1.0",
  version_matches: true,
  workspace_path: "/data/workspace.sqlite3",
  workspace_matches: true,
  app_version: "0.1.0",
  app_workspace_path: "/data/workspace.sqlite3",
  suggested_directory: "~/.local/bin",
};

test("shows Installed with version and path when everything matches", async () => {
  invoke.mockResolvedValue(base);
  render(<CommandLineCard />);
  expect(await screen.findByText("Installed")).toBeTruthy();
  // The path once, as PathText (never split mid-word), not again in prose.
  expect(
    document.querySelector('[data-slot="path-text"]')?.textContent,
  ).toContain(".local/bin/ticketd");
  expect(screen.queryByText(/Found at/)).toBeNull();
  expect(screen.getByText(/Uses this workspace/)).toBeTruthy();
});

test("reports a version mismatch and a different workspace distinctly", async () => {
  invoke.mockResolvedValueOnce({
    ...base,
    version: "0.0.9",
    version_matches: false,
  });
  const view = render(<CommandLineCard />);
  expect(await screen.findByText(/does not match this app/)).toBeTruthy();
  expect(screen.queryByText(/It uses a different workspace/)).toBeNull();
  view.unmount();

  invoke.mockResolvedValueOnce({
    ...base,
    workspace_matches: false,
    workspace_path: "/other.sqlite3",
  });
  render(<CommandLineCard />);
  expect(await screen.findByText(/It uses a different workspace/)).toBeTruthy();
  expect(screen.queryByText(/does not match this app/)).toBeNull();
});

test("a missing CLI shows guidance, and Check again finds a later install", async () => {
  invoke.mockResolvedValueOnce({
    ...base,
    found: false,
    path: null,
    version: null,
    version_matches: null,
    workspace_path: null,
    workspace_matches: null,
  });
  render(<CommandLineCard />);
  expect(await screen.findByText("Not found")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Installation guide" }),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();

  invoke.mockResolvedValueOnce(base);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByText("Installed")).toBeTruthy();
});

test("an installation guide that cannot open says so", async () => {
  invoke.mockResolvedValue({ ...base, on_path: false });
  vi.mocked(openUrl).mockRejectedValueOnce(new Error("No browser"));
  render(<CommandLineCard />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Installation guide" }),
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(
    "Couldn't open the installation guide. No browser.",
  );
  expect(alert.textContent).not.toContain("Error:");
  // Retry opens the guide again and clears the failure when it succeeds.
  vi.mocked(openUrl).mockResolvedValueOnce(undefined);
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("copies a quick-reference command", async () => {
  invoke.mockResolvedValue(base);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(<CommandLineCard />);
  fireEvent.click(
    screen.getByRole("button", { name: /Copy: List Ready tickets/ }),
  );
  expect(writeText).toHaveBeenCalledWith(
    "ticketd list --project PROJECT_ID --availability ready",
  );
  expect(await screen.findByText("Copied")).toBeTruthy();
});

test("a ticketd found only in a fallback folder is not called installed", async () => {
  invoke.mockResolvedValue({ ...base, on_path: false });
  render(<CommandLineCard />);
  expect(await screen.findByText("Found, but not on your PATH")).toBeTruthy();
  expect(screen.queryByText("Installed")).toBeNull();
  expect(screen.getByText(/that folder isn.t on your PATH/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Installation guide" }),
  ).toBeTruthy();
});

test("a different workspace is named, and a version mismatch links the guide", async () => {
  invoke.mockResolvedValueOnce({
    ...base,
    workspace_matches: false,
    workspace_path: "/other.sqlite3",
  });
  const view = render(<CommandLineCard />);
  expect(await screen.findByText("Uses a different workspace")).toBeTruthy();
  expect(screen.queryByText("Not confirmed")).toBeNull();
  view.unmount();
  invoke.mockResolvedValueOnce({
    ...base,
    version: "0.0.9",
    version_matches: false,
  });
  render(<CommandLineCard />);
  await screen.findByText(/does not match this app/);
  expect(
    screen.getByRole("button", { name: "Installation guide" }),
  ).toBeTruthy();
});

const missing = {
  ...base,
  found: false,
  path: null,
  version: null,
  version_matches: null,
  workspace_path: null,
  workspace_matches: null,
};

test("a missing CLI walks through three steps with the suggested folder", async () => {
  invoke.mockResolvedValueOnce(missing);
  render(<CommandLineCard />);
  await screen.findByText("Not found");
  const steps = screen.getByRole("list");
  expect(
    within(steps)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([
    expect.stringContaining("Get the ticketd executable"),
    expect.stringContaining("~/.local/bin"),
    expect.stringContaining("Choose Check again"),
  ]);
});

test("Check again sits in the Status section and is disabled while checking", async () => {
  invoke.mockResolvedValueOnce(base);
  render(<CommandLineCard />);
  const status = screen.getByRole("region", { name: "Status" });
  const button = within(status).getByRole("button", { name: "Checking…" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(within(status).getByRole("status")).toBeTruthy();
  await screen.findByText("Installed");
  expect((button as HTMLButtonElement).disabled).toBe(false);
});

test("details name a version difference and the workspace as a status", async () => {
  invoke.mockResolvedValueOnce({
    ...base,
    version: "0.0.9",
    version_matches: false,
  });
  render(<CommandLineCard />);
  await screen.findByText("Installed, needs attention");
  expect(screen.getByText("differs from this app")).toBeTruthy();
  expect(screen.getByText("Uses this workspace")).toBeTruthy();
});

test("the footer sends people to Agent skills", async () => {
  invoke.mockResolvedValue(base);
  const openPage = vi.fn();
  const state: SettingsState = {
    query: "",
    setQuery: () => {},
    openPage,
    needsSetup: {},
    refreshIndicators: () => {},
  };
  render(
    <SettingsStateContext.Provider value={state}>
      <CommandLineCard />
    </SettingsStateContext.Provider>,
  );
  expect(
    screen.getByRole("button", { name: "Set up Agent skills" }).dataset.slot,
  ).toBe("settings-link");
  fireEvent.click(screen.getByRole("button", { name: "Set up Agent skills" }));
  expect(openPage).toHaveBeenCalledWith("agent-skills");
});
