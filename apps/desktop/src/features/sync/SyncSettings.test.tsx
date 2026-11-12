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
import { invoke } from "@tauri-apps/api/core";
import { revealFile } from "@/lib/reveal";
import { syncApi, type SyncSetupOptions } from "@/lib/sync-api";
import { SyncSettings } from "./SyncSettings";
import { SyncStatusProvider } from "./SyncStatusProvider";
import {
  hostFailure,
  notConnected,
  syncSettings,
  syncStatus,
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
vi.mock("@/lib/reveal", () => ({ revealFile: vi.fn() }));
const api = vi.mocked(syncApi);
/** The api as shipped, over the mocked bridge. */
const real = (
  await vi.importActual<typeof import("@/lib/sync-api")>("@/lib/sync-api")
).syncApi;

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

function show() {
  return render(
    <SyncStatusProvider>
      <SyncSettings />
    </SyncStatusProvider>,
  );
}

beforeEach(() => {
  api.settings.mockResolvedValue(syncSettings());
  api.setupOptions.mockResolvedValue(options);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("before connecting, the card says files are not encrypted and offers Google sign-in", async () => {
  api.status.mockResolvedValue(notConnected());
  api.connect.mockResolvedValue(choosing());
  show();
  const note = await screen.findByRole("note");
  expect(note.textContent).toContain("Files are not encrypted");
  expect(note.textContent).toContain("readable Markdown file");
  fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }));
  expect(
    await screen.findByRole("radiogroup", { name: "This Workspace" }),
  ).toBeTruthy();
  expect(screen.getByText("Connected as you@example.com")).toBeTruthy();
  expect(screen.getByText("Files in Drive are not encrypted.")).toBeTruthy();
});

test("a failed sign-in is reported and leaves the card as it was", async () => {
  api.status.mockResolvedValue(notConnected());
  api.connect.mockImplementation(real.connect);
  vi.mocked(invoke).mockRejectedValue(hostFailure("sign-in was cancelled"));
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Connect Google Drive" }),
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not connect Google Drive: sign-in was cancelled",
  );
  expect(
    screen.getByRole("button", { name: "Connect Google Drive" }),
  ).toBeTruthy();
});

test("uploading this Workspace is the preselected setup choice", async () => {
  api.status.mockResolvedValue(choosing());
  api.uploadWorkspace.mockResolvedValue(
    syncStatus({
      state: "upload_pending",
      first_sync: { direction: "upload", done: 14, total: 23 },
    }),
  );
  show();
  const upload = await screen.findByRole("radio", {
    name: /Upload this Workspace/,
  });
  expect(upload.getAttribute("aria-checked")).toBe("true");
  expect(upload.textContent).toContain(
    "17 tickets and 2 Documents go to a new folder in your Drive",
  );
  fireEvent.click(screen.getByRole("button", { name: "Start sync" }));
  expect(await screen.findByText("Uploading 14 of 23 files")).toBeTruthy();
  expect(
    screen.getByRole("progressbar", { name: "First upload" }),
  ).toBeTruthy();
  expect(api.downloadWorkspace).not.toHaveBeenCalled();
});

test("a Workspace that synced with a folder of this account is offered that folder first", async () => {
  api.status.mockResolvedValue(choosing());
  api.setupOptions.mockResolvedValue({
    ...options,
    // Also when there is nothing here to upload, which otherwise preselects a download.
    local: { tickets: 0, documents: 0, attachments: 0 },
    reconnect: { id: "folder-1", name: "ticketd · web-app" },
  });
  api.reconnect.mockResolvedValue(syncStatus({ state: "upload_pending" }));
  show();
  const choices = await screen.findAllByRole("radio");
  expect(choices.map((choice) => choice.textContent.split("”")[0])).toEqual([
    "Reconnect to “ticketd · web-app",
    "Download “ticketd · web-app",
  ]);
  expect(choices[0]?.getAttribute("aria-checked")).toBe("true");
  expect(choices[0]?.textContent).toContain(
    "Changes made here and in Drive are merged, and nothing is replaced",
  );
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  expect(
    await screen.findByRole("heading", { name: "This desktop" }),
  ).toBeTruthy();
  expect(api.reconnect).toHaveBeenCalled();
  expect(api.uploadWorkspace).not.toHaveBeenCalled();
  expect(api.downloadWorkspace).not.toHaveBeenCalled();
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
    name: /Download “ticketd · web-app”/,
  });
  expect(download.textContent).toContain(
    "42 tickets and 9 Documents, last synced from Studio desktop 2 h ago",
  );
  fireEvent.click(download);
  fireEvent.click(screen.getByRole("button", { name: "Download…" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Replace this Workspace?",
  });
  expect(dialog.textContent).toContain("A safety backup is saved first.");
  expect(dialog.textContent).toContain(
    "42 tickets, 9 Documents, 12 Attachments",
  );
  expect(dialog.textContent).toContain(
    "17 tickets, 2 Documents, 3 Attachments",
  );
  expect(api.downloadWorkspace).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Download and replace" }),
  );
  await waitFor(() =>
    expect(api.downloadWorkspace).toHaveBeenCalledWith("folder-1"),
  );
  expect(
    await screen.findByRole("heading", { name: "This desktop" }),
  ).toBeTruthy();
  // What was replaced can be found again.
  expect(screen.getByLabelText("Safety backup file").textContent).toBe(
    "workspace.sqlite3.safety-1.sqlite3",
  );
  vi.mocked(revealFile).mockResolvedValue(null);
  fireEvent.click(screen.getByRole("button", { name: /^Show in / }));
  expect(revealFile).toHaveBeenCalledWith(
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
    await screen.findByRole("radio", { name: /Download “ticketd · web-app”/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Download…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Download and replace" }),
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
  expect(
    await screen.findByRole("button", { name: "Connect Google Drive" }),
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

test("the setup choice has a way back, also when Drive cannot be read", async () => {
  api.status.mockResolvedValue(choosing());
  api.setupOptions.mockRejectedValue(new Error("Drive did not answer"));
  api.disconnect.mockResolvedValue(notConnected());
  show();
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not read your Drive: Drive did not answer",
  );
  fireEvent.click(screen.getByRole("button", { name: "Use another account" }));
  expect(
    await screen.findByRole("button", { name: "Connect Google Drive" }),
  ).toBeTruthy();
  expect(api.disconnect).toHaveBeenCalledTimes(1);
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

test("an empty Workspace beside one in Drive preselects the download, and each folder is named", async () => {
  api.status.mockResolvedValue(choosing());
  let answer: (read: SyncSetupOptions) => void = () => {};
  api.setupOptions.mockReturnValue(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  show();
  // Drive takes a few seconds to answer: the card says what it waits for.
  expect((await screen.findByRole("status")).textContent).toBe(
    "Looking for Workspaces in your Drive…",
  );
  answer({
    local: { tickets: 0, documents: 0, attachments: 0 },
    existing: [
      ...options.existing,
      {
        folder_id: "folder-2",
        folder_name: "ticketd · notes",
        last_synced_by: null,
        last_synced_at: null,
        counts: { tickets: 1, documents: 0, attachments: 0 },
      },
    ],
    reconnect: null,
  });
  const first = await screen.findByRole("radio", {
    name: /Download “ticketd · web-app”/,
  });
  expect(first.getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("status")).toBeNull();
  expect(
    screen.getByRole("radio", { name: /Download “ticketd · notes”/ })
      .textContent,
  ).toContain("1 ticket and 0 Documents, last sync not recorded");
  expect(screen.getByRole("button", { name: "Download…" })).toBeTruthy();
});

test("a first download that has not counted its files yet says Preparing", async () => {
  api.status.mockResolvedValue(
    syncStatus({ first_sync: { direction: "download", done: 0, total: 0 } }),
  );
  show();
  expect((await screen.findByText("Preparing…")).textContent).toBe(
    "Preparing…",
  );
  expect(screen.queryByText(/0 of 0/)).toBeNull();
});
