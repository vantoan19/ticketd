// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SettingsView } from "@/features/settings/SettingsView";
import { SettingsNav } from "@/features/settings/SettingsNav";
import { loadPreferences } from "@/lib/preferences";
import { workspaceClient } from "@/lib/api/workspace";

vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: {
    info: vi.fn(),
    reveal: vi.fn(),
    openLink: vi.fn(),
  },
}));

const info = {
  path: "/Users/me/Library/Application Support/ticketd/workspace.sqlite3",
  tickets: 42,
  projects: 3,
  active_efforts: 2,
  size_bytes: 2_621_440,
  format_version: 19,
};

beforeEach(() => {
  vi.mocked(workspaceClient.info).mockResolvedValue(info);
  vi.mocked(workspaceClient.reveal).mockResolvedValue(undefined);
  vi.mocked(workspaceClient.openLink).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

test("choosing Dark or Full width is stored and exposed as selected", () => {
  render(<SettingsView hidden={false} onRestore={async () => {}} />);
  const checked = (name: string | RegExp) =>
    screen.getByRole("radio", { name }).getAttribute("aria-checked");
  expect(checked("System")).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  fireEvent.click(screen.getByRole("radio", { name: /Full width/ }));
  expect(checked("Dark")).toBe("true");
  expect(checked(/Full width/)).toBe("true");
  expect(loadPreferences()).toEqual({ theme: "dark", openTickets: "expanded" });
});

test("the section list only offers sections that have cards", () => {
  render(
    <>
      <SettingsNav onBack={() => {}} />
      <SettingsView hidden={false} onRestore={async () => {}} />
    </>,
  );
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  const labels = Array.from(nav.querySelectorAll("li button")).map(
    (button) => button.textContent ?? "",
  );
  expect(labels).toEqual([
    "Appearance",
    "Location",
    "Backups",
    "Export",
    "Keyboard shortcuts",
    "About",
  ]);
  for (const label of labels)
    expect(screen.getByRole("region", { name: label })).toBeTruthy();
});

test("the Location card shows the path, counts, size, and format version", async () => {
  render(<SettingsView hidden={false} onRestore={async () => {}} />);
  expect((await screen.findByLabelText("Workspace path")).textContent).toBe(
    info.path,
  );
  const text = screen.getByRole("region", { name: "Location" }).textContent;
  expect(text).toContain("Tickets42");
  expect(text).toContain("Projects3");
  expect(text).toContain("Active Efforts2");
  expect(text).toContain("File size2.5 MB");
  expect(text).toContain("Format version19");
});

test("Copy path puts the workspace path on the clipboard", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<SettingsView hidden={false} onRestore={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Copy path" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(info.path));
  expect(await screen.findByText("Path copied.")).toBeTruthy();
});

test("Show in the file manager reveals the workspace file", async () => {
  render(<SettingsView hidden={false} onRestore={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /^Show in / }));
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith(info.path),
  );
});

test("a workspace that cannot be read shows an error instead of counts", async () => {
  vi.mocked(workspaceClient.info).mockRejectedValue(new Error("locked"));
  render(<SettingsView hidden={false} onRestore={async () => {}} />);
  expect((await screen.findByRole("alert")).textContent).toContain("locked");
  expect(screen.queryByLabelText("Workspace path")).toBeNull();
});

test("the About links open Documentation and the issue tracker", async () => {
  render(<SettingsView hidden={false} onRestore={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Documentation" }));
  fireEvent.click(screen.getByRole("button", { name: "Report an issue" }));
  await waitFor(() =>
    expect(workspaceClient.openLink).toHaveBeenCalledTimes(2),
  );
  const urls = vi.mocked(workspaceClient.openLink).mock.calls.map(([u]) => u);
  expect(urls.every((url) => url.startsWith("https://"))).toBe(true);
});
