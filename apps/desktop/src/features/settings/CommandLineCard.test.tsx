// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CommandLineCard } from "@/features/settings/CommandLineCard";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

const base = {
  found: true,
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
  expect(screen.getByText("/Users/a/.local/bin/ticketd")).toBeTruthy();
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
  expect(screen.queryByText(/different workspace/)).toBeNull();
  view.unmount();

  invoke.mockResolvedValueOnce({
    ...base,
    workspace_matches: false,
    workspace_path: "/other.sqlite3",
  });
  render(<CommandLineCard />);
  expect(await screen.findByText(/different workspace/)).toBeTruthy();
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
  expect(screen.getByRole("link", { name: "Installation guide" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();

  invoke.mockResolvedValueOnce(base);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByText("Installed")).toBeTruthy();
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
    "ticketd list --project PROJECT --availability ready",
  );
  expect(await screen.findByText("Copied")).toBeTruthy();
});
