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
import { LocationPage } from "./LocationPage";

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
  render(<LocationPage />);
  const loading = screen.getByRole("status", { name: "Reading the workspace" });
  expect(
    loading.querySelectorAll('[data-slot="skeleton"]').length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText("Tickets")).toBeNull();
});

test("the workspace file row names the file in its own line and its folder beneath", async () => {
  render(<LocationPage />);
  expect(await screen.findByText("Tickets")).toBeTruthy();
  const folder = screen.getByTitle(
    "/Users/ada/Library/Application Support/ticketd",
  );
  expect(folder.textContent).toBe("~/Library/Application Support/ticketd");
});

test("Contents lists the six facts from the workspace", async () => {
  render(<LocationPage />);
  await screen.findByText("Tickets");
  const contents = screen.getByRole("region", { name: "Contents" });
  const facts = Object.fromEntries(
    Array.from(contents.querySelectorAll("dt")).map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ]),
  );
  expect(facts).toEqual({
    Tickets: "42",
    Documents: "7",
    Projects: "3",
    "Active Plans": "2",
    "File size": "2.5 MB",
    "Format version": "20",
  });
});

test("the two-ways-in figure is one labelled image", async () => {
  render(<LocationPage />);
  const figure = await screen.findByRole("img", {
    name: /desktop app and the ticketd command line both read and write workspace\.sqlite3/,
  });
  expect(figure.textContent).toContain("reads and writes");
  expect(screen.getAllByRole("img")).toHaveLength(1);
});

test("Copy path copies the full path and confirms in the list footer", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<LocationPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Copy path" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(info.path));
  expect((await screen.findByRole("status", { name: "" })).textContent).toBe(
    "Path copied.",
  );
});

test("a failed copy says so in the footer", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  render(<LocationPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Copy path" }));
  expect(await screen.findByText(/Could not copy the path/)).toBeTruthy();
});

test("Show in the file manager reveals the file, and a failure lands in the footer", async () => {
  render(<LocationPage />);
  const show = await screen.findByRole("button", { name: /^Show in / });
  fireEvent.click(show);
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith(info.path),
  );
  vi.mocked(workspaceClient.reveal).mockRejectedValueOnce(new Error("nope"));
  fireEvent.click(show);
  expect(
    await screen.findByText(/Could not show the file: .*nope/),
  ).toBeTruthy();
});

test("a workspace that cannot be read shows an Alert, and Try again reads it again", async () => {
  vi.mocked(workspaceClient.info).mockRejectedValueOnce(new Error("locked"));
  render(<LocationPage />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Could not read the workspace");
  expect(alert.textContent).toContain("locked");
  expect(screen.queryByText("Contents")).toBeNull();
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Tickets")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
