// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { workspaceClient } from "@/lib/api/workspace";
import { syncApi } from "@/lib/sync-api";
import { TestReads } from "@/lib/workspace-reads/testing";
import { SyncSettings } from "./SyncSettings";
import { SyncStatusProvider } from "./SyncStatusProvider";
import {
  notConnected,
  syncSettings,
  syncStatus,
  workspaceInfo,
} from "./sync-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/sync-api", async (original) => ({
  ...(await original<typeof import("@/lib/sync-api")>()),
  syncApi: {
    status: vi.fn(),
    connect: vi.fn(),
    setupOptions: vi.fn(),
    uploadWorkspace: vi.fn(),
    reconnect: vi.fn(),
    downloadWorkspace: vi.fn(),
    syncNow: vi.fn(),
    recover: vi.fn(),
    disconnect: vi.fn(),
    openFolder: vi.fn(),
    settings: vi.fn(),
    setSettings: vi.fn(),
    flushOnExit: vi.fn(),
  },
}));
vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { reveal: vi.fn(), info: vi.fn() },
}));
const api = vi.mocked(syncApi);

const choosing = () =>
  syncStatus({
    connection: "choosing",
    folder: null,
    state: "saved_locally",
    last_synced_at: null,
  });
const options = {
  local: { tickets: 17, documents: 2, attachments: 3 },
  existing: [
    {
      folder_id: "folder-1",
      folder_name: "ticketd · web-app",
      last_synced_by: "Studio desktop",
      last_synced_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      counts: { tickets: 42, documents: 9, attachments: 12 },
    },
  ],
  reconnect: null,
};

function show(extra?: ReactNode, onReplaced = async () => {}) {
  return render(
    <TestReads>
      <SyncStatusProvider>
        <SyncSettings onReplaced={onReplaced} />
      </SyncStatusProvider>
      {extra}
    </TestReads>,
  );
}

beforeEach(() => {
  vi.mocked(workspaceClient.info).mockResolvedValue(workspaceInfo());
  api.settings.mockResolvedValue(syncSettings());
  api.setupOptions.mockResolvedValue(options);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("while the status is read, the page shows the setup track and a row-shaped skeleton", async () => {
  api.status.mockReturnValue(new Promise(() => {}));
  const { container } = show();
  const track = screen.getByRole("list", { name: "Sync setup" });
  expect(within(track).getAllByRole("listitem")).toHaveLength(4);
  expect(
    screen.getByRole("status", { name: "Reading Google Drive" }),
  ).toBeTruthy();
  expect(
    container.querySelectorAll('[data-slot="skeleton"]').length,
  ).toBeGreaterThanOrEqual(3);
  expect(screen.queryByRole("button")).toBeNull();
});

test("downloading an existing Workspace asks once before replacing this one", async () => {
  api.status.mockResolvedValue(choosing());
  api.downloadWorkspace.mockResolvedValue({
    ...syncStatus(),
    // As Windows reports it: with the prefix only the system uses.
    safety_backup: "\\\\?\\C:\\ticketd\\workspace.sqlite3.safety-1.sqlite3",
  });
  show();
  const download = await screen.findByRole("radio", {
    name: /Join “ticketd · web-app”/,
  });
  expect(download.textContent).toContain(
    "42 tickets and 9 Documents, last synced from Studio desktop 2 h ago.",
  );
  fireEvent.click(download);
  fireEvent.click(screen.getByRole("button", { name: "Join…" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Replace this Workspace?",
  });
  // The consequence comes first, the safety net in the note slot, and the
  // one way through is destructive, named for the result.
  const [consequence] = within(dialog).getAllByRole("note");
  expect(consequence?.textContent).toContain(
    "This replaces everything in this Workspace on this computer",
  );
  expect(dialog.textContent).toContain("A safety backup is saved first.");
  expect(
    within(dialog)
      .getByRole("button", { name: "Replace Workspace" })
      .getAttribute("data-variant"),
  ).toBe("destructive");
  // Cancel holds focus, so Enter never replaces by accident.
  expect(document.activeElement?.textContent).toBe("Cancel");
  expect(dialog.textContent).toContain(
    "42 tickets, 9 Documents, 12 Attachments",
  );
  expect(dialog.textContent).toContain(
    "17 tickets, 2 Documents, 3 Attachments",
  );
  expect(api.downloadWorkspace).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Replace Workspace" }),
  );
  await waitFor(() =>
    expect(api.downloadWorkspace).toHaveBeenCalledWith("folder-1"),
  );
  expect(
    await screen.findByRole("heading", { name: "This desktop" }),
  ).toBeTruthy();
  // What was replaced can be found again.
  expect(screen.getByText("workspace.sqlite3.safety-1.sqlite3")).toBeTruthy();
  vi.mocked(workspaceClient.reveal).mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole("button", { name: /^Show in / }));
  expect(workspaceClient.reveal).toHaveBeenCalledWith(
    "C:\\ticketd\\workspace.sqlite3.safety-1.sqlite3",
  );
});

test("a download that skipped an unreadable Drive file says so on the replaced card", async () => {
  api.status.mockResolvedValue(choosing());
  api.downloadWorkspace.mockResolvedValue({
    ...syncStatus(),
    safety_backup: "C:\\ticketd\\workspace.sqlite3.safety-1.sqlite3",
  });
  const notice = {
    kind: "unreadable_file",
    timestamp: new Date().toISOString(),
    reason: "not a ticket",
  };
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(
      command === "sync_notices"
        ? [
            { ...notice, id: "n1", path: "tickets/A.md", read: false },
            // Already read in the Inbox: not counted again.
            { ...notice, id: "n2", path: "tickets/B.md", read: true },
          ]
        : undefined,
    ),
  );
  show();
  fireEvent.click(
    await screen.findByRole("radio", { name: /Join “ticketd · web-app”/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Join…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Replace Workspace" }),
  );
  expect(
    await screen.findByText(
      "1 file in Drive could not be read and was skipped. See Inbox.",
    ),
  ).toBeTruthy();
});

test("a connected Workspace shows its account, folder and that files are not encrypted", async () => {
  api.status.mockResolvedValue(syncStatus());
  show();
  expect(await screen.findByText("Connected as you@example.com")).toBeTruthy();
  expect(screen.getByText("“ticketd · web-app” in My Drive")).toBeTruthy();
  expect(
    screen.getByText(/Files in Drive are not encrypted\. ticketd only sees/),
  ).toBeTruthy();
  api.openFolder.mockResolvedValue();
  fireEvent.click(screen.getByRole("button", { name: "Open in Drive" }));
  expect(api.openFolder).toHaveBeenCalled();
});

test("Disconnect confirms that nothing is deleted before stopping sync", async () => {
  api.status.mockResolvedValue(syncStatus());
  api.disconnect.mockResolvedValue(notConnected());
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect…" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Disconnect this desktop?",
  });
  expect(dialog.textContent).toContain("Nothing is deleted.");
  expect(dialog.textContent).toContain("This Workspace stays as it is");
  expect(dialog.textContent).toContain(
    "“ticketd · web-app” stays, for your other desktops",
  );
  expect(api.disconnect).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
  // Setup begins again, at its first step.
  expect(
    await screen.findByRole("radiogroup", { name: "Start or join" }),
  ).toBeTruthy();
});

test("cancelling Disconnect keeps this desktop connected", async () => {
  api.status.mockResolvedValue(syncStatus());
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.disconnect).not.toHaveBeenCalled();
});

test("the desktop name is saved when the field is left", async () => {
  api.status.mockResolvedValue(syncStatus());
  api.setSettings.mockResolvedValue(syncSettings({ desktop_name: "Studio" }));
  show();
  const name = await screen.findByLabelText<HTMLInputElement>("Name");
  await waitFor(() => expect(name.value).toBe("Laptop"));
  expect(screen.getByText(/new tickets here are numbered T-KQ1/)).toBeTruthy();
  fireEvent.change(name, { target: { value: " Studio " } });
  fireEvent.blur(name);
  await waitFor(() =>
    expect(api.setSettings).toHaveBeenCalledWith({
      desktop_name: "Studio",
      poll_interval_secs: 60,
      attachment_download: "automatic",
    }),
  );
});

test("a saved name says Saved under its field, not at the foot of the page", async () => {
  api.status.mockResolvedValue(syncStatus());
  api.setSettings.mockResolvedValue(syncSettings({ desktop_name: "Studio" }));
  show();
  const name = await screen.findByLabelText<HTMLInputElement>("Name");
  await waitFor(() => expect(name.value).toBe("Laptop"));
  fireEvent.change(name, { target: { value: "Studio" } });
  fireEvent.blur(name);
  const field = name.closest(".sync-field");
  await waitFor(() => expect(field?.textContent).toContain("Saved"));
});

test("a check interval under 30 seconds is refused without saving", async () => {
  api.status.mockResolvedValue(syncStatus());
  api.setSettings.mockResolvedValue(syncSettings({ poll_interval_secs: 30 }));
  show();
  const interval = await screen.findByLabelText<HTMLInputElement>(
    "Check for changes every",
  );
  await waitFor(() => expect(interval.value).toBe("60"));
  fireEvent.change(interval, { target: { value: "29" } });
  fireEvent.blur(interval);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Enter 30 seconds or more.",
  );
  expect(api.setSettings).not.toHaveBeenCalled();
  fireEvent.change(interval, { target: { value: "30" } });
  fireEvent.blur(interval);
  await waitFor(() =>
    expect(api.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ poll_interval_secs: 30 }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("Attachments can download only when opened", async () => {
  api.status.mockResolvedValue(syncStatus());
  api.setSettings.mockResolvedValue(
    syncSettings({ attachment_download: "on_open" }),
  );
  show();
  const group = await screen.findByRole("radiogroup", { name: "Attachments" });
  const onOpen = within(group).getByRole("radio", {
    name: /Download when opened/,
  });
  await waitFor(() => expect(onOpen.hasAttribute("disabled")).toBe(false));
  fireEvent.click(onOpen);
  await waitFor(() => expect(onOpen.getAttribute("aria-checked")).toBe("true"));
  expect(api.setSettings).toHaveBeenCalledWith(
    expect.objectContaining({ attachment_download: "on_open" }),
  );
});

test("an expired sign-in says work is safe and offers Reconnect", async () => {
  const item = {
    kind: "ticket" as const,
    id: "t1",
    reference: "T-KQ1",
    title: "A",
  };
  api.status.mockResolvedValue(
    syncStatus({
      state: "needs_attention",
      recovery: "authorization_expired",
      pending_uploads: [item, item, item],
    }),
  );
  api.recover.mockResolvedValue(syncStatus());
  show();
  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toContain("Sign in to Google Drive again");
  expect(notice.textContent).toContain(
    "Your work is saved on this computer. 3 changes upload once you reconnect.",
  );
  fireEvent.click(within(notice).getByRole("button", { name: "Reconnect" }));
  expect(await screen.findByText("Connected as you@example.com")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test.each([
  [
    "folder_missing",
    "Sync folder not found in Drive",
    "“ticketd · web-app” was deleted or moved. Nothing was removed from this computer.",
    "Upload again",
  ],
  [
    "storage_full",
    "Google Drive is full",
    "Your work is saved on this computer. Changes upload once there is space.",
    "Retry",
  ],
  [
    "offline",
    "Offline",
    "Changes are saved on this computer and upload when you are back online.",
    "Retry",
  ],
  [
    "rate_limited",
    "Google Drive is busy",
    "Google Drive asked ticketd to slow down. Changes are saved on this computer and upload a little later.",
    "Retry",
  ],
] as const)(
  "recovery from %s is one notice with one action",
  async (recovery, title, description, action) => {
    api.status.mockResolvedValue(
      syncStatus({ state: "needs_attention", recovery }),
    );
    show();
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toBe(title + description + action);
    expect(within(notice).getAllByRole("button")).toHaveLength(1);
  },
);

test("a sync failure with no state of its own is a notice with its message and Retry", async () => {
  api.status.mockResolvedValue(
    syncStatus({
      state: "needs_attention",
      recovery: "error",
      recovery_message: "storage: the storage answered nonsense",
    }),
  );
  api.recover.mockResolvedValue(syncStatus());
  show();
  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toContain("Sync could not finish");
  expect(notice.textContent).toContain(
    "Your work is saved on this computer. The last sync stopped with: storage: the storage answered nonsense",
  );
  fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Connected as you@example.com")).toBeTruthy();
  expect(api.recover).toHaveBeenCalled();
});

test("a first sync that stopped shows why, with its action and Disconnect", async () => {
  api.status.mockResolvedValue(
    syncStatus({
      state: "needs_attention",
      recovery: "storage_full",
      first_sync: { direction: "upload", done: 3, total: 23 },
    }),
  );
  api.recover.mockResolvedValue(syncStatus());
  show();
  expect(await screen.findByText("Google Drive is full")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByRole("button", { name: "Disconnect…" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(api.recover).toHaveBeenCalled();
});
