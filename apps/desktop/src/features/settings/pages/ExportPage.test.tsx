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
import { client } from "@/lib/api/client";
import { workspaceClient } from "@/lib/api/workspace";
import { fileManagerName } from "@/lib/platform";
import { ExportPage } from "@/features/settings/pages/ExportPage";
import { SettingsStateProvider } from "@/features/settings/settings-state";

vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { chooseSavePath: vi.fn(), reveal: vi.fn() },
}));
vi.mock("@/lib/api/client", () => ({ client: { exportWorkspace: vi.fn() } }));
// Settings reads the CLI for its nav dot at startup; these pages ignore it.
vi.mock("@/lib/api/cli", () => ({
  cliClient: { check: vi.fn(() => new Promise(() => {})) },
}));
vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn(async () => []) },
}));

const writeText = vi.fn();

beforeEach(() => {
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue("/tmp/out.json");
  vi.mocked(workspaceClient.reveal).mockResolvedValue(undefined);
  vi.mocked(client.exportWorkspace).mockResolvedValue(undefined);
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(onOpenPage = vi.fn()) {
  render(
    <SettingsStateProvider active={false} onOpenPage={onOpenPage}>
      <ExportPage />
    </SettingsStateProvider>,
  );
  return onOpenPage;
}

test("Export… saves to the chosen file and the footer names it with a way to show it", async () => {
  renderPage();
  expect(screen.queryByText(/Export saved to/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  const status = await screen.findByText(/Export saved to/);
  expect(status.textContent).toBe("Export saved to /tmp/out.json");
  expect(workspaceClient.chooseSavePath).toHaveBeenCalledWith(
    expect.objectContaining({ filterName: "JSON", extension: "json" }),
  );
  expect(client.exportWorkspace).toHaveBeenCalledWith("/tmp/out.json");
  fireEvent.click(
    screen.getByRole("button", { name: `Show in ${fileManagerName()}` }),
  );
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith("/tmp/out.json"),
  );
});

test("cancelling the save dialog writes nothing and shows no error", async () => {
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue(null);
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  await waitFor(() =>
    expect(workspaceClient.chooseSavePath).toHaveBeenCalledTimes(1),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Export…" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(client.exportWorkspace).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/Export saved to/)).toBeNull();
});

test("a failed export says why and keeps the button usable", async () => {
  vi.mocked(client.exportWorkspace).mockRejectedValue("disk full");
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "The export was not saved: disk full",
  );
  expect(screen.queryByText(/Export saved to/)).toBeNull();
  expect(
    screen.getByRole("button", { name: "Export…" }).hasAttribute("disabled"),
  ).toBe(false);
});

test("a save dialog that cannot open is reported", async () => {
  vi.mocked(workspaceClient.chooseSavePath).mockRejectedValue("no window");
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Could not open the save dialog: no window",
  );
});

test("a file manager that cannot show the file is reported", async () => {
  vi.mocked(workspaceClient.reveal).mockRejectedValue("gone");
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: `Show in ${fileManagerName()}`,
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain("gone");
});

test("each command can be copied with its placeholders in place", async () => {
  renderPage();
  const commands: [string, string][] = [
    ["Copy the export command", "ticketd export --file PATH"],
    [
      "Copy the ticket export command",
      "ticketd export-markdown --ticket TICKET --output FOLDER",
    ],
    [
      "Copy the Document export command",
      "ticketd export-markdown --document DOCUMENT --output FOLDER",
    ],
  ];
  for (const [label, command] of commands) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(command));
  }
  expect(
    screen.getByText(/Words in color are placeholders\. FOLDER must already/),
  ).toBeTruthy();
});

test("Backups in the lede opens the Backups page", () => {
  const openPage = renderPage();
  expect(screen.getByRole("button", { name: "Backups" }).dataset.slot).toBe(
    "settings-link",
  );
  fireEvent.click(screen.getByRole("button", { name: "Backups" }));
  expect(openPage).toHaveBeenCalledWith("backups");
});

test("Export or back up? is a table comparing the two", () => {
  renderPage();
  const table = screen.getByRole("table", { name: "Export or back up?" });
  const rows = within(table).getAllByRole("row");
  expect(rows.map((row) => row.textContent)).toEqual([
    "CompareExportBackup",
    "Meant forReading, other tools, sharingRestoring this workspace",
    "FormatJSON or Markdown textA ticketd workspace file",
    "Includes TrashYesYes",
    "Can be restoredNoYes, after a review",
  ]);
  expect(
    screen.getByRole("heading", { level: 1, name: "Export" }),
  ).toBeTruthy();
});
