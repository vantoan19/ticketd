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
import { workspaceClient } from "@/lib/api/workspace";
import { LocationSection } from "./LocationSection";

vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { info: vi.fn(), reveal: vi.fn() },
}));

const info = {
  path: "/Users/ada/Library/Application Support/ticketd/workspace.sqlite3",
  tickets: 42,
  documents: 7,
  projects: 3,
  active_plans: 2,
  size_bytes: 2_621_440,
  format_version: 20,
};

beforeEach(() => {
  vi.mocked(workspaceClient.info).mockResolvedValue(info);
  vi.mocked(workspaceClient.reveal).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("while the workspace is read the page shows skeletons, not facts", async () => {
  vi.mocked(workspaceClient.info).mockReturnValue(new Promise(() => {}));
  render(<LocationSection />);
  const loading = screen.getByRole("status", { name: "Reading the workspace" });
  expect(
    loading.querySelectorAll('[data-slot="skeleton"]').length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText("workspace.sqlite3")).toBeNull();
});

test("the workspace file row names the file in its own line and its folder beneath", async () => {
  render(<LocationSection />);
  expect(await screen.findByText("workspace.sqlite3")).toBeTruthy();
  // The full path is in the PathText tooltip, never a native title.
  const folder = document.querySelector<HTMLElement>(
    '[data-slot="path-text"]',
  )!;
  expect(folder.textContent).toBe("~/Library/Application Support/ticketd");
  expect(folder.getAttribute("title")).toBeNull();
  fireEvent.pointerMove(folder);
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "/Users/ada/Library/Application Support/ticketd",
  );
});

test("one footer line counts what is in the Workspace and names its format", async () => {
  render(<LocationSection />);
  await screen.findByText("workspace.sqlite3");
  const section = screen.getByRole("region", { name: "Location" });
  expect(section.textContent).toContain(
    "The app and the ticketd command both read and write this file.",
  );
  expect(section.querySelector(".settings-list-footer-text")?.textContent).toBe(
    "42 tickets · 7 Documents · 2 Plans · 2.5 MB · format 20",
  );
});

test("a Workspace of one says one", async () => {
  vi.mocked(workspaceClient.info).mockResolvedValue({
    ...info,
    tickets: 1,
    documents: 1,
    active_plans: 1,
  });
  render(<LocationSection />);
  await screen.findByText("workspace.sqlite3");
  expect(
    document.querySelector(".settings-list-footer-text")?.textContent,
  ).toBe("1 ticket · 1 Document · 1 Plan · 2.5 MB · format 20");
});

test("Copy path copies the full path and confirms on the button", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<LocationSection />);
  fireEvent.click(await screen.findByRole("button", { name: "Copy path" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(info.path));
  expect((await screen.findByText("Copied")).textContent).toBe("Copied");
});

test("a failed copy says so on the button", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  render(<LocationSection />);
  fireEvent.click(await screen.findByRole("button", { name: "Copy path" }));
  expect(
    await screen.findByRole("button", { name: "Copy unavailable" }),
  ).toBeTruthy();
});

test("Show in the file manager reveals the file, and a failure lands in the footer", async () => {
  render(<LocationSection />);
  const show = await screen.findByRole("button", { name: /^Show in / });
  fireEvent.click(show);
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith(info.path),
  );
  vi.mocked(workspaceClient.reveal).mockRejectedValueOnce(new Error("nope"));
  fireEvent.click(show);
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain("nope");
});

test("a workspace that cannot be read says so, and Retry reads it again", async () => {
  vi.mocked(workspaceClient.info).mockRejectedValueOnce(new Error("locked"));
  render(<LocationSection />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't read the workspace");
  await revealFailureDetails();
  expect(alert.textContent).toContain("locked");
  expect(screen.queryByText(/format 20/)).toBeNull();
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("workspace.sqlite3")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
