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
import { syncApi, type SyncDevice } from "@/lib/sync-api";
import { TestReads } from "@/lib/workspace-reads/testing";
import { SyncSettings } from "./SyncSettings";
import { SyncStatusProvider } from "./SyncStatusProvider";
import {
  notConnected,
  syncSettings,
  hostFailure,
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
    devices: vi.fn(),
    flushOnExit: vi.fn(),
  },
}));
vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { reveal: vi.fn(), info: vi.fn() },
}));
const api = vi.mocked(syncApi);

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();
/** This computer and one other, as the device list reads. */
const computers = (): SyncDevice[] => [
  { id: "d1", name: "Laptop", code: "KQ", last_synced_at: null, this: true },
  {
    id: "d2",
    name: "Mac mini",
    code: "PZ",
    last_synced_at: hoursAgo(3),
    this: false,
  },
];

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
  api.devices.mockResolvedValue(computers());
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
    await screen.findByRole("heading", { name: "Computers" }),
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

test("a synced Workspace proves it works: the sign-in, the place and when it was checked", async () => {
  api.status.mockResolvedValue(syncStatus({ account: "sam.lee@gmail.com" }));
  api.openFolder.mockResolvedValue();
  show();
  const status = await screen.findByRole("group", { name: "Sync status" });
  expect(within(status).getByText("Synced")).toBeTruthy();
  expect(status.textContent).toContain(
    "Checked a minute ago · signed in as sam.lee@gmail.com",
  );
  expect(status.textContent).toContain(
    "“ticketd · web-app” in your Google Drive. Readable files, not encrypted.",
  );
  // Nothing is wrong, so nothing is asked.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    within(status).queryByRole("button", { name: /Retry|Sign in/ }),
  ).toBeNull();
  fireEvent.click(
    within(status).getByRole("button", { name: "Open in Drive" }),
  );
  expect(api.openFolder).toHaveBeenCalled();
});

test("the page keeps its order: status, Computers, Options, then the last row", async () => {
  api.status.mockResolvedValue(syncStatus());
  show();
  await screen.findByText("Synced");
  const headings = screen
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent);
  expect(headings).toEqual(["Computers", "Options"]);
  const stop = screen.getByText("Stop syncing on this computer");
  const options = screen.getByRole("heading", { name: "Options" });
  expect(
    options.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.getByText("Your files stay in Drive and on this computer."),
  ).toBeTruthy();
});

test("Computers lists this computer first with Rename…, and the others with their last change", async () => {
  api.status.mockResolvedValue(syncStatus());
  show();
  const section = (
    await screen.findByRole("heading", { name: "Computers" })
  ).closest("section")!;
  await within(section).findByText("Mac mini");
  const rows = section.querySelectorAll(".settings-list-row");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toBe(
    "LaptopThis computer · tickets T-KQ1, T-KQ2…Rename…",
  );
  expect(rows[1]?.textContent).toBe(
    "Mac miniLast change 3 hours ago · tickets T-PZ1, T-PZ2…",
  );
  // Only this computer can be renamed here.
  expect(within(section).getAllByRole("button")).toHaveLength(1);
});

test("a device list that cannot be read still shows this computer", async () => {
  api.status.mockResolvedValue(syncStatus());
  api.devices.mockRejectedValue(new Error("no list"));
  show();
  expect(
    await screen.findByText("This computer · tickets T-KQ1, T-KQ2…"),
  ).toBeTruthy();
  expect(screen.queryByText("Mac mini")).toBeNull();
});

test("Rename… changes this computer's name, and the list shows it", async () => {
  api.status.mockResolvedValue(syncStatus());
  api.setSettings.mockResolvedValue(syncSettings({ desktop_name: "Studio" }));
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Rename…" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Rename this computer",
  });
  const name = within(dialog).getByLabelText<HTMLInputElement>("Name");
  expect(name.value).toBe("Laptop");
  fireEvent.change(name, { target: { value: " Studio " } });
  api.devices.mockResolvedValue([
    { ...computers()[0]!, name: "Studio" },
    computers()[1]!,
  ]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
  await waitFor(() =>
    expect(api.setSettings).toHaveBeenCalledWith({
      desktop_name: "Studio",
      poll_interval_secs: 60,
      attachment_download: "automatic",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByText("Studio")).toBeTruthy();
});

test("a name that is empty is refused in the dialog without saving", async () => {
  api.status.mockResolvedValue(syncStatus());
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Rename…" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Rename this computer",
  });
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "   " },
  });
  expect(dialog.textContent).toContain("Enter a name for this computer.");
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Rename",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(api.setSettings).not.toHaveBeenCalled();
});

test("a rename the host refuses keeps the dialog open and says why", async () => {
  api.status.mockResolvedValue(syncStatus());
  api.setSettings.mockRejectedValue(
    hostFailure("use a shorter name for this desktop"),
  );
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Rename…" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Rename this computer",
  });
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Studio" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
  await within(dialog).findByRole("alert");
  expect(
    screen.getByRole("dialog", { name: "Rename this computer" }),
  ).toBeTruthy();
});

test("Check now syncs at once", async () => {
  api.status.mockResolvedValue(syncStatus());
  api.syncNow.mockResolvedValue(syncStatus());
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Check now" }));
  await waitFor(() => expect(api.syncNow).toHaveBeenCalledTimes(1));
});

test("a check interval under 30 seconds is refused with its caption, without saving", async () => {
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

test("a saved interval says Saved under its field", async () => {
  api.status.mockResolvedValue(syncStatus());
  api.setSettings.mockResolvedValue(syncSettings({ poll_interval_secs: 90 }));
  show();
  const interval = await screen.findByLabelText<HTMLInputElement>(
    "Check for changes every",
  );
  await waitFor(() => expect(interval.value).toBe("60"));
  fireEvent.change(interval, { target: { value: "90" } });
  fireEvent.blur(interval);
  await waitFor(() =>
    expect(interval.closest(".sync-field")?.textContent).toContain("Saved"),
  );
});

test("files from other computers can download only when opened", async () => {
  api.status.mockResolvedValue(syncStatus());
  api.setSettings.mockResolvedValue(
    syncSettings({ attachment_download: "on_open" }),
  );
  show();
  const group = await screen.findByRole("radiogroup", {
    name: "Files from your other computers",
  });
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

test("the options and the name were not touched by a save of the other", async () => {
  api.status.mockResolvedValue(syncStatus());
  api.setSettings.mockResolvedValue(
    syncSettings({ attachment_download: "on_open" }),
  );
  show();
  const onOpen = await screen.findByRole("radio", {
    name: /Download when opened/,
  });
  await waitFor(() => expect(onOpen.hasAttribute("disabled")).toBe(false));
  fireEvent.click(onOpen);
  await waitFor(() => expect(api.setSettings).toHaveBeenCalled());
  expect(api.setSettings).toHaveBeenCalledWith({
    desktop_name: "Laptop",
    poll_interval_secs: 60,
    attachment_download: "on_open",
  });
});

test("Disconnect is the last row and confirms that nothing is deleted before stopping sync", async () => {
  api.status.mockResolvedValue(syncStatus());
  api.disconnect.mockResolvedValue(notConnected());
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect…" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Disconnect this computer?",
  });
  expect(dialog.textContent).toContain("Nothing is deleted.");
  expect(dialog.textContent).toContain("This Workspace stays as it is");
  expect(dialog.textContent).toContain(
    "“ticketd · web-app” stays, for your other computers",
  );
  // Uploads sit inside the sync folder and are the person's own files.
  expect(dialog.textContent).toContain("Your Uploads folder stays as it is");
  expect(api.disconnect).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
  // Setup begins again, at its first step.
  expect(
    await screen.findByRole("radiogroup", { name: "Start or join" }),
  ).toBeTruthy();
});

test("cancelling Disconnect keeps this computer connected", async () => {
  api.status.mockResolvedValue(syncStatus());
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.disconnect).not.toHaveBeenCalled();
});

const item = (id: string) => ({
  kind: "ticket" as const,
  id,
  reference: null,
  title: id,
});

test("an ended sign-in is the status row: Signed out, what is kept, and one Sign in", async () => {
  api.status.mockResolvedValue(
    syncStatus({
      state: "needs_attention",
      recovery: "authorization_expired",
      pending_uploads: [item("a"), item("b"), item("c")],
    }),
  );
  api.recover.mockResolvedValue(syncStatus());
  show();
  const row = await screen.findByRole("alert");
  expect(row.textContent).toContain("Signed out");
  expect(row.textContent).toContain(
    "Your Google sign-in ended. 3 changes are saved here and upload after you sign in.",
  );
  // The status never sits green beside a warning, and no second box repeats it.
  expect(screen.queryByText("Synced")).toBeNull();
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(row.querySelector('[data-tone="attention"]')).not.toBeNull();
  expect(within(row).getAllByRole("button", { name: /Sign in/ })).toHaveLength(
    1,
  );
  fireEvent.click(within(row).getByRole("button", { name: /Sign in/ }));
  expect(await screen.findByText("Synced")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.recover).toHaveBeenCalled();
});

test.each([
  [
    "folder_missing",
    "Folder missing",
    "“ticketd · web-app” was deleted or moved. Nothing was removed from this computer.",
    "Upload again",
  ],
  [
    "storage_full",
    "Storage full",
    "Google Drive is full. Your work is saved on this computer.",
    "Retry",
  ],
  [
    "offline",
    "Offline",
    "ticketd can't reach Google Drive. Your work is saved on this computer.",
    "Retry",
  ],
  [
    "rate_limited",
    "Slowed down",
    "Google Drive asked ticketd to slow down. Your work is saved on this computer.",
    "Retry",
  ],
] as const)(
  "%s is the status row with one fix",
  async (recovery, label, description, action) => {
    api.status.mockResolvedValue(
      syncStatus({ state: "needs_attention", recovery }),
    );
    show();
    const row = await screen.findByRole("alert");
    expect(row.textContent).toContain(label + description);
    expect(row.textContent).toContain(action);
    // The fix, and the link to the place; nothing else is asked.
    expect(
      within(row)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([action, "Open in Drive"]);
    expect(screen.queryByText("Synced")).toBeNull();
  },
);

test("a sync failure with no state of its own says what stopped it, with Retry", async () => {
  api.status.mockResolvedValue(
    syncStatus({
      state: "needs_attention",
      recovery: "error",
      recovery_message: "storage: the storage answered nonsense",
    }),
  );
  api.recover.mockResolvedValue(syncStatus());
  show();
  const row = await screen.findByRole("alert");
  expect(row.textContent).toContain("Not syncing");
  expect(row.textContent).toContain(
    "Your work is saved on this computer. The last sync stopped with: storage: the storage answered nonsense",
  );
  fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Synced")).toBeTruthy();
  expect(api.recover).toHaveBeenCalled();
});

test("a fix that fails says so under the status row", async () => {
  api.status.mockResolvedValue(
    syncStatus({ state: "needs_attention", recovery: "storage_full" }),
  );
  api.recover.mockRejectedValue(hostFailure("Google Drive did not answer"));
  show();
  const row = await screen.findByRole("alert");
  fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api.recover).toHaveBeenCalled());
  const failed = await screen.findAllByRole("alert");
  expect(failed).toHaveLength(2);
  expect(failed[1]?.textContent).toMatch(/sync/i);
});

test("records changed on two computers are reviewed from the status row", async () => {
  api.status.mockResolvedValue(
    syncStatus({
      state: "needs_attention",
      needs_review: [
        { kind: "ticket", id: "t1", reference: "T-KQ1", title: "Login" },
      ],
    }),
  );
  show();
  const status = await screen.findByRole("group", { name: "Sync status" });
  expect(status.textContent).toContain("Needs review");
  expect(status.textContent).toContain("1 record changed on two computers.");
  expect(within(status).getByRole("button", { name: "Review" })).toBeTruthy();
});

test("a first sync that stopped shows why on the status row, with its fix and Disconnect", async () => {
  api.status.mockResolvedValue(
    syncStatus({
      state: "needs_attention",
      recovery: "storage_full",
      first_sync: { direction: "upload", done: 3, total: 23 },
    }),
  );
  api.recover.mockResolvedValue(syncStatus());
  show();
  expect(await screen.findByText("Storage full")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByRole("button", { name: "Disconnect…" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(api.recover).toHaveBeenCalled();
});
