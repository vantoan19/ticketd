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
import { loadPreferences } from "@/lib/preferences";
import { workspaceClient } from "@/lib/api/workspace";
import { client } from "@/lib/api/client";
import { notificationClient } from "@/lib/api/notifications";
import { cliClient } from "@/lib/api/cli";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi
    .fn()
    .mockImplementation(async (command: string) =>
      command === "attachment_upload_destination"
        ? { kind: "local" }
        : 104857600,
    ),
}));

vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: {
    info: vi.fn(),
    reveal: vi.fn(),
    openLink: vi.fn(),
    lastBackup: vi.fn(),
    chooseSavePath: vi.fn(),
    chooseBackupFile: vi.fn(),
    inspectBackup: vi.fn(),
    safetyBackups: vi.fn(),
  },
}));
vi.mock("@/lib/api/cli", () => ({ cliClient: { check: vi.fn() } }));
vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn(async () => []), install: vi.fn() },
}));
vi.mock("@/lib/api/notifications", () => ({
  notificationClient: {
    permitted: vi.fn(),
    requestPermission: vi.fn(),
    notify: vi.fn(),
  },
}));
vi.mock("@/lib/api/client", () => ({
  client: {
    backupWorkspace: vi.fn(),
    exportWorkspace: vi.fn(),
    restoreWorkspace: vi.fn(),
  },
}));

const info = {
  path: "/Users/me/Library/Application Support/ticketd/workspace.sqlite3",
  tickets: 42,
  projects: 3,
  active_plans: 2,
  documents: 0,
  size_bytes: 2_621_440,
  format_version: 20,
};

beforeEach(() => {
  vi.mocked(cliClient.check).mockResolvedValue({
    found: false,
    on_path: false,
    path: null,
    version: null,
    version_matches: null,
    workspace_path: null,
    workspace_matches: null,
    app_version: "0.1.0",
    app_workspace_path: null,
    suggested_directory: "~/.local/bin",
  });
  vi.mocked(workspaceClient.info).mockResolvedValue(info);
  vi.mocked(workspaceClient.safetyBackups).mockResolvedValue([]);
  vi.mocked(workspaceClient.reveal).mockResolvedValue(undefined);
  vi.mocked(workspaceClient.openLink).mockResolvedValue(undefined);
  vi.mocked(workspaceClient.lastBackup).mockResolvedValue(null);
  vi.mocked(workspaceClient.chooseSavePath).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

test("choosing Dark or Full width is stored and exposed as selected", () => {
  render(
    <SettingsView
      selected="appearance"
      onRestore={async () => {}}
      onOpenInbox={() => {}}
    />,
  );
  const checked = (name: string | RegExp) =>
    screen.getByRole("radio", { name }).getAttribute("aria-checked");
  expect(checked(/^System/)).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: /^Dark/ }));
  fireEvent.click(screen.getByRole("radio", { name: /Full width/ }));
  expect(checked(/^Dark/)).toBe("true");
  expect(checked(/Full width/)).toBe("true");
  expect(loadPreferences()).toMatchObject({
    theme: "dark",
    openTickets: "expanded",
  });
});

test("a page opens at its top, not where the previous page was scrolled", () => {
  const view = render(
    <SettingsView
      selected="appearance"
      onRestore={async () => {}}
      onOpenInbox={() => {}}
    />,
  );
  const scroller = view.container.querySelector(".settings-page")!;
  scroller.scrollTop = 600;
  view.rerender(
    <SettingsView
      selected="google-drive"
      onRestore={async () => {}}
      onOpenInbox={() => {}}
    />,
  );
  expect(scroller.scrollTop).toBe(0);
});

test("Google Drive opens as its own page in the shell", () => {
  render(
    <SettingsView
      selected="google-drive"
      onRestore={async () => {}}
      onOpenInbox={() => {}}
    />,
  );
  expect(
    screen.getByRole("heading", { level: 1, name: "Google Drive" }),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Appearance" })).toBeNull();
});

test("the Location page shows the path, counts, size, and format version", async () => {
  render(
    <SettingsView
      selected="location"
      onRestore={async () => {}}
      onOpenInbox={() => {}}
    />,
  );
  await waitFor(() =>
    expect(document.querySelector(".path-text")).not.toBeNull(),
  );
  const folder = document.querySelector<HTMLElement>(".path-text")!;
  expect(screen.getAllByText("workspace.sqlite3").length).toBeGreaterThan(0);
  expect(folder.textContent).toBe("~/Library/Application Support/ticketd");
  fireEvent.pointerMove(folder);
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "/Users/me/Library/Application Support/ticketd",
  );
  fireEvent.keyDown(document.body, { key: "Escape" });
  const text = screen.getByRole("region", { name: "Contents" }).textContent;
  expect(text).toContain("Tickets42");
  expect(text).toContain("Projects3");
  expect(text).toContain("Active Plans2");
  expect(text).toContain("File size2.5 MB");
  expect(text).toContain("Format version20");
});

test("Copy path puts the workspace path on the clipboard", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(
    <SettingsView
      selected="location"
      onRestore={async () => {}}
      onOpenInbox={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Copy path" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(info.path));
  expect(await screen.findByText("Path copied.")).toBeTruthy();
});

test("Show in the file manager reveals the workspace file", async () => {
  render(
    <SettingsView
      selected="location"
      onRestore={async () => {}}
      onOpenInbox={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /^Show in / }));
  await waitFor(() =>
    expect(workspaceClient.reveal).toHaveBeenCalledWith(info.path),
  );
});

test("a workspace that cannot be read shows an error instead of counts", async () => {
  vi.mocked(workspaceClient.info).mockRejectedValue(new Error("locked"));
  render(
    <SettingsView
      selected="location"
      onRestore={async () => {}}
      onOpenInbox={() => {}}
    />,
  );
  expect((await screen.findByRole("alert")).textContent).toContain("Locked.");
  expect(screen.queryByLabelText("Workspace path")).toBeNull();
});

test("cancelling a save dialog changes nothing and shows no error", async () => {
  const props = { onRestore: async () => {}, onOpenInbox: () => {} };
  render(<SettingsView selected="backups" {...props} />);
  await screen.findByText("No backups yet");
  fireEvent.click(screen.getByRole("button", { name: "Back up now…" }));
  await waitFor(() =>
    expect(workspaceClient.chooseSavePath).toHaveBeenCalledTimes(1),
  );
  expect(client.backupWorkspace).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("Follow tickets I create is on by default and the choice persists", () => {
  render(
    <SettingsView
      selected="attention"
      onRestore={async () => {}}
      onOpenInbox={() => {}}
    />,
  );
  const follow = screen.getByRole("switch", {
    name: "Follow tickets I create",
  });
  expect(follow.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(follow);
  expect(follow.getAttribute("aria-checked")).toBe("false");
  expect(loadPreferences().followCreated).toBe(false);
});

test("turning on reminder notifications asks for permission and keeps the switch on when granted", async () => {
  vi.mocked(notificationClient.requestPermission).mockResolvedValue(true);
  render(
    <SettingsView
      selected="attention"
      onRestore={async () => {}}
      onOpenInbox={() => {}}
    />,
  );
  const notify = screen.getByRole("switch", {
    name: "Notify me when a reminder is due",
  });
  expect(notify.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(notify);
  await waitFor(() => expect(loadPreferences().notifyReminders).toBe(true));
  expect(notify.getAttribute("aria-checked")).toBe("true");
});

test("denied permission leaves the switch off and explains how to allow notifications", async () => {
  vi.mocked(notificationClient.requestPermission).mockResolvedValue(false);
  render(
    <SettingsView
      selected="attention"
      onRestore={async () => {}}
      onOpenInbox={() => {}}
    />,
  );
  const notify = screen.getByRole("switch", {
    name: "Notify me when a reminder is due",
  });
  fireEvent.click(notify);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "notification settings",
  );
  expect(notify.getAttribute("aria-checked")).toBe("false");
  expect(loadPreferences().notifyReminders).toBe(false);
});

test("the Attention footer opens the inbox", () => {
  const openInbox = vi.fn();
  render(
    <SettingsView
      selected="attention"
      onRestore={async () => {}}
      onOpenInbox={openInbox}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Open the Attention inbox" }),
  );
  expect(openInbox).toHaveBeenCalled();
});

test("workspace stats use short one-line labels", async () => {
  render(
    <SettingsView
      selected="location"
      onRestore={async () => {}}
      onOpenInbox={() => {}}
    />,
  );
  await screen.findByText("Documents");
  const contents = screen.getByRole("region", { name: "Contents" });
  expect(contents.textContent).toContain("Documents");
  expect(contents.textContent).not.toContain("including details and Trash");
});
