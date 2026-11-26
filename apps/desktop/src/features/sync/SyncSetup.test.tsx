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
import { workspaceClient } from "@/lib/api/workspace";
import { s3Api } from "@/lib/s3-api";
import { syncApi, type SyncSetupOptions } from "@/lib/sync-api";
import { revealFailureDetails } from "@/test/failure-details";
import { TestReads } from "@/lib/workspace-reads/testing";
import { SyncSettings } from "./SyncSettings";
import { SyncStatusProvider } from "./SyncStatusProvider";
import {
  hostFailure,
  notConnected,
  syncSettings,
  syncStatus,
  workspaceInfo,
} from "./sync-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/s3-api", async (original) => ({
  ...(await original<typeof import("@/lib/s3-api")>()),
  s3Api: {
    profiles: vi.fn(),
    identity: vi.fn(),
    signIn: vi.fn(),
    buckets: vi.fn(),
  },
}));
vi.mock("@/lib/sync-api", async (original) => ({
  ...(await original<typeof import("@/lib/sync-api")>()),
  syncApi: {
    status: vi.fn(),
    connect: vi.fn(),
    setupOptions: vi.fn(),
    uploadWorkspace: vi.fn(),
    reconnect: vi.fn(),
    downloadWorkspace: vi.fn(),
    disconnect: vi.fn(),
    settings: vi.fn(),
  },
}));
vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { reveal: vi.fn(), info: vi.fn() },
}));
const api = vi.mocked(syncApi);
const info = vi.mocked(workspaceClient.info);
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
const holdsWorkspace: SyncSetupOptions = {
  // The split moment: tickets here, and a Workspace there.
  local: { tickets: 26, documents: 0, attachments: 0 },
  existing: [
    {
      folder_id: "folder-1",
      folder_name: "ticketd",
      last_synced_by: "Mac mini",
      last_synced_at: new Date(Date.now() - 30 * 3_600_000).toISOString(),
      counts: { tickets: 214, documents: 31, attachments: 0 },
    },
  ],
  reconnect: null,
};
const emptyStorage: SyncSetupOptions = {
  ...holdsWorkspace,
  existing: [],
};

function show(onReplaced = async () => {}) {
  return render(
    <TestReads>
      <SyncStatusProvider>
        <SyncSettings onReplaced={onReplaced} />
      </SyncStatusProvider>
    </TestReads>,
  );
}

const radio = (name: RegExp) => screen.findByRole("radio", { name });
/** Continue, once this computer has been read. */
async function next() {
  const button = await screen.findByRole("button", { name: "Continue" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
}
const press = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));

/** Steps 1 and 2 as a person takes them on the way to Google sign-in. */
async function signInThrough(choice?: RegExp) {
  if (choice) fireEvent.click(await radio(choice));
  await next();
  fireEvent.click(
    await screen.findByRole("button", { name: "Connect Google Drive" }),
  );
}

beforeEach(() => {
  api.settings.mockResolvedValue(syncSettings());
  api.status.mockResolvedValue(notConnected());
  api.setupOptions.mockResolvedValue(holdsWorkspace);
  info.mockResolvedValue(workspaceInfo({ tickets: 26, documents: 0 }));
  vi.mocked(s3Api.profiles).mockResolvedValue({
    cli: { state: "ready" },
    profiles: ["work", "personal"],
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("step 1 says what sync adds and what stays the same without it, and starts with this Workspace when it holds tickets", async () => {
  show();
  const start = await radio(/Start with this Workspace/);
  expect(start.getAttribute("aria-checked")).toBe("true");
  const join = screen.getByRole("radio", {
    name: /Join from another computer/,
  });
  expect(join.getAttribute("aria-checked")).toBe("false");
  expect(join.textContent).toContain(
    "Replaces the 26 tickets on this computer",
  );
  expect(
    within(screen.getByRole("list", { name: "With sync" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([
    "The same Workspace on each computer",
    "A copy in your own Google Drive or S3",
  ]);
  expect(
    within(screen.getByRole("list", { name: "Without sync" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([
    "Everything works here, offline too",
    "Restore points are still saved every day",
  ]);
  expect(
    screen.getByText(
      "Two Workspaces can't be merged later, so join the one you already sync.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText("Nothing leaves this computer until you connect."),
  ).toBeTruthy();
  // The setup is only read: nothing is connected, and no storage is asked.
  expect(api.connect).not.toHaveBeenCalled();
  expect(api.setupOptions).not.toHaveBeenCalled();
});

test("a computer holding nothing joins by default, with nothing to replace", async () => {
  info.mockResolvedValue(workspaceInfo({ tickets: 0, documents: 0 }));
  show();
  const join = await radio(/Join from another computer/);
  expect(join.getAttribute("aria-checked")).toBe("true");
  expect(join.textContent).not.toContain("Replaces");
});

test("a Document alone counts as something this computer holds", async () => {
  info.mockResolvedValue(workspaceInfo({ tickets: 0, documents: 3 }));
  show();
  expect(
    (await radio(/Start with this Workspace/)).getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.getByRole("radio", { name: /Join from another computer/ })
      .textContent,
  ).toContain("Replaces the 3 Documents on this computer");
});

test("step 1 falls back to starting, which replaces nothing, when this computer cannot be read", async () => {
  info.mockRejectedValue(hostFailure("unreadable"));
  show();
  expect(
    (await radio(/Start with this Workspace/)).getAttribute("aria-checked"),
  ).toBe("true");
});

test("Continue goes on to where it syncs, and Back returns with the choice kept", async () => {
  show();
  fireEvent.click(await radio(/Join from another computer/));
  await next();
  const where = await screen.findByRole("radiogroup", {
    name: "Where it syncs",
  });
  expect(
    within(where)
      .getByRole("radio", { name: /Google Drive/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.getByText(
      "Signs in with your Google account, the same sign-in Files uses.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Use the same one on each computer.")).toBeTruthy();
  expect(
    screen.getByText("Files in your Drive are readable, not encrypted."),
  ).toBeTruthy();
  press("Back");
  expect(
    (await radio(/Join from another computer/)).getAttribute("aria-checked"),
  ).toBe("true");
});

test("choosing S3 shows its rows with Back, and no AWS profile is read for Drive", async () => {
  show();
  await next();
  await screen.findByRole("radiogroup", { name: "Where it syncs" });
  expect(s3Api.profiles).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Connect S3" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: /S3/ }));
  expect(await screen.findByText("AWS profile")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Connect Google Drive" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Connect S3" })).toBeTruthy();
  press("Back");
  expect(
    await screen.findByRole("radiogroup", { name: "Start or join" }),
  ).toBeTruthy();
});

test("a failed sign-in is reported and leaves step 2 as it was", async () => {
  api.connect.mockImplementation(real.connect);
  vi.mocked(invoke).mockRejectedValue(hostFailure("sign-in was cancelled"));
  show();
  await signInThrough();
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain(
    "sign-in was cancelled",
  );
  expect(
    screen
      .getByRole("button", { name: "Connect Google Drive" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

test("waiting for the Google sign-in says so and holds the buttons", async () => {
  api.connect.mockImplementation(() => new Promise(() => {}));
  show();
  await signInThrough();
  expect((await screen.findByRole("status")).textContent).toBe(
    "Waiting for sign-in in your browser…",
  );
  expect(
    screen
      .getByRole("button", { name: "Connect Google Drive" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "Back" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("a build without a Drive app configuration says so and holds back sign-in", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "drive_configuration"
      ? { configured: false, message: "This build does not include Drive." }
      : undefined,
  );
  show();
  await next();
  expect(
    await screen.findByText("Google Drive isn't set up on this computer"),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Connect Google Drive" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

test("a sign-in that cannot start names the missing configuration, not an unconfirmed result", async () => {
  api.connect.mockImplementation(real.connect);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "drive_configuration")
      return { configured: true, message: "Ready" };
    throw {
      code: "drive_unconfigured",
      message:
        "This build does not include a valid Google Drive app configuration",
    };
  });
  show();
  await signInThrough();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("no Google Drive app configuration");
  expect(alert.textContent).not.toContain("couldn't be confirmed");
  expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();
});

test("the split moment: a Workspace in Drive is joined by default even when Start was chosen and tickets are here", async () => {
  api.connect.mockResolvedValue(choosing());
  show();
  await signInThrough(/Start with this Workspace/);

  const join = await radio(/Join “ticketd”/);
  expect(join.getAttribute("aria-checked")).toBe("true");
  expect(join.textContent).toContain(
    "214 tickets and 31 Documents, last synced from Mac mini yesterday.",
  );
  expect(join.textContent).toContain(
    "Replaces the 26 tickets on this computer",
  );
  const separate = screen.getByRole("radio", {
    name: /Start a separate Workspace/,
  });
  expect(separate.getAttribute("aria-checked")).toBe("false");
  expect(separate.textContent).toContain(
    "Your Drive then holds two Workspaces, and they can't be merged later.",
  );
  expect(screen.getByText("Your Drive already has a Workspace")).toBeTruthy();
  expect(
    screen.getByText(
      "Join it so this computer and your others share one Workspace.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "A safety copy of this computer's Workspace is saved first.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Signed in")).toBeTruthy();
  expect(screen.getByText("you@example.com · Google Drive")).toBeTruthy();
  // Reading the storage changed nothing: the choice is still the person's.
  expect(api.uploadWorkspace).not.toHaveBeenCalled();
  expect(api.downloadWorkspace).not.toHaveBeenCalled();
  expect(api.reconnect).not.toHaveBeenCalled();
});

test("a download that replaces the Workspace asks once first and tells the app after it finished", async () => {
  api.status.mockResolvedValue(choosing());
  api.downloadWorkspace.mockResolvedValue({
    ...syncStatus({
      first_sync: { direction: "download", done: 0, total: 245 },
    }),
    safety_backup: "/ticketd/workspace.sqlite3.safety-1.sqlite3",
  });
  const onReplaced = vi.fn(async () => {});
  show(onReplaced);
  await radio(/Join “ticketd”/);
  press("Join…");
  const dialog = await screen.findByRole("dialog", {
    name: "Replace this Workspace?",
  });
  const [consequence] = within(dialog).getAllByRole("note");
  expect(consequence?.textContent).toContain(
    "This replaces everything in this Workspace on this computer",
  );
  expect(dialog.textContent).toContain("A safety backup is saved first.");
  expect(dialog.textContent).toContain(
    "214 tickets, 31 Documents, 0 Attachments",
  );
  expect(dialog.textContent).toContain(
    "26 tickets, 0 Documents, 0 Attachments",
  );
  expect(
    within(dialog)
      .getByRole("button", { name: "Replace Workspace" })
      .getAttribute("data-variant"),
  ).toBe("destructive");
  expect(api.downloadWorkspace).not.toHaveBeenCalled();
  expect(onReplaced).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Replace Workspace" }),
  );
  await waitFor(() => expect(onReplaced).toHaveBeenCalledTimes(1));
  expect(api.downloadWorkspace).toHaveBeenCalledWith("folder-1");
  expect(api.uploadWorkspace).not.toHaveBeenCalled();
});

test("Start a separate Workspace is chosen on purpose and uploads this one without replacing it", async () => {
  api.status.mockResolvedValue(choosing());
  api.uploadWorkspace.mockResolvedValue(
    syncStatus({
      state: "upload_pending",
      first_sync: { direction: "upload", done: 2, total: 26 },
    }),
  );
  show();
  fireEvent.click(await radio(/Start a separate Workspace/));
  expect(
    screen.getByText("Files in your Drive are readable, not encrypted."),
  ).toBeTruthy();
  press("Start syncing");
  expect(await screen.findByText("Uploading 2 of 26 files")).toBeTruthy();
  expect(api.uploadWorkspace).toHaveBeenCalledTimes(1);
  expect(api.downloadWorkspace).not.toHaveBeenCalled();
});

test("a folder this computer synced before is offered first, and nothing is replaced", async () => {
  api.status.mockResolvedValue(choosing());
  api.setupOptions.mockResolvedValue({
    ...holdsWorkspace,
    reconnect: { id: "folder-1", name: "ticketd" },
  });
  api.reconnect.mockResolvedValue(syncStatus({ state: "upload_pending" }));
  show();
  const choices = await screen.findAllByRole("radio");
  expect(choices.map((choice) => choice.textContent.split("”")[0])).toEqual([
    "Reconnect to “ticketd",
    "Join “ticketd",
  ]);
  expect(choices[0]?.getAttribute("aria-checked")).toBe("true");
  expect(choices[0]?.textContent).toContain(
    "Changes made here and in Drive are merged, and nothing is replaced",
  );
  // Starting would land in the same folder, minus the merge.
  expect(screen.queryByRole("radio", { name: /separate/ })).toBeNull();
  press("Reconnect");
  expect(
    await screen.findByRole("heading", { name: "This desktop" }),
  ).toBeTruthy();
  expect(api.reconnect).toHaveBeenCalled();
  expect(api.uploadWorkspace).not.toHaveBeenCalled();
  expect(api.downloadWorkspace).not.toHaveBeenCalled();
});

test("several Workspaces are each named, and the first is joined", async () => {
  api.status.mockResolvedValue(choosing());
  api.setupOptions.mockResolvedValue({
    ...holdsWorkspace,
    existing: [
      ...holdsWorkspace.existing,
      {
        folder_id: "folder-2",
        folder_name: "notes",
        last_synced_by: null,
        last_synced_at: null,
        counts: { tickets: 1, documents: 0, attachments: 0 },
      },
    ],
  });
  show();
  expect((await radio(/Join “ticketd”/)).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(
    screen.getByRole("radio", { name: /Join “notes”/ }).textContent,
  ).toContain("1 ticket and 0 Documents, last sync not recorded.");
  expect(screen.getByText("Your Drive already has Workspaces")).toBeTruthy();
});

test("with nothing in Drive, Start goes straight to the first sync", async () => {
  api.setupOptions.mockResolvedValue(emptyStorage);
  api.connect.mockResolvedValue(choosing());
  api.uploadWorkspace.mockResolvedValue(
    syncStatus({
      state: "upload_pending",
      first_sync: { direction: "upload", done: 0, total: 26 },
    }),
  );
  show();
  await signInThrough(/Start with this Workspace/);
  await waitFor(() => expect(api.uploadWorkspace).toHaveBeenCalledTimes(1));
  expect(await screen.findByText("Uploading 0 of 26 files")).toBeTruthy();
});

test("with nothing in Drive to join, Join waits for the person to start instead", async () => {
  api.setupOptions.mockResolvedValue(emptyStorage);
  api.connect.mockResolvedValue(choosing());
  show();
  await signInThrough(/Join from another computer/);
  expect(
    await screen.findByText("Your Drive has no Workspace yet"),
  ).toBeTruthy();
  expect(
    screen.queryByRole("radiogroup", { name: "This Workspace" }),
  ).toBeNull();
  expect(api.uploadWorkspace).not.toHaveBeenCalled();
  api.uploadWorkspace.mockResolvedValue(
    syncStatus({ first_sync: { direction: "upload", done: 0, total: 26 } }),
  );
  press("Start syncing");
  await waitFor(() => expect(api.uploadWorkspace).toHaveBeenCalledTimes(1));
});

test("Back at step 3 signs out of this account and returns to where it syncs", async () => {
  api.connect.mockResolvedValue(choosing());
  api.disconnect.mockResolvedValue(notConnected());
  show();
  await signInThrough();
  await radio(/Join “ticketd”/);
  press("Back");
  expect(
    await screen.findByRole("radiogroup", { name: "Where it syncs" }),
  ).toBeTruthy();
  expect(api.disconnect).toHaveBeenCalledTimes(1);
  expect(api.uploadWorkspace).not.toHaveBeenCalled();
});

test("another Google account is chosen by disconnecting, once confirmed, which deletes nothing", async () => {
  api.status.mockResolvedValue(choosing());
  api.disconnect.mockResolvedValue(notConnected());
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Use another account…" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Use another Google account?",
  });
  expect(dialog.textContent).toContain("you@example.com");
  expect(dialog.textContent).toContain(
    "Nothing in Drive or on this computer is deleted.",
  );
  expect(api.disconnect).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Use another account" }),
  );
  expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
  expect(api.disconnect).toHaveBeenCalledTimes(1);
});

test("a Drive that cannot be read says so, can be read again, and keeps the way out", async () => {
  api.status.mockResolvedValue(choosing());
  api.setupOptions
    .mockRejectedValueOnce(new Error("Drive did not answer"))
    .mockResolvedValueOnce(holdsWorkspace);
  show();
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain(
    "Drive did not answer",
  );
  // Nothing starts from a storage that could not be read.
  expect(
    screen
      .getByRole("button", { name: "Start syncing" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "Use another account…" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await radio(/Join “ticketd”/)).toBeTruthy();
});

test("the first download names where it comes from and has no way back", async () => {
  api.status.mockResolvedValue(
    syncStatus({
      folder: { name: "ticketd" },
      state: "upload_pending",
      first_sync: { direction: "download", done: 120, total: 214 },
    }),
  );
  show();
  expect(await screen.findByText("Downloading 120 of 214 files")).toBeTruthy();
  expect(
    screen.getByText("From “ticketd” in you@example.com’s Drive"),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "What was here before is kept as a restore point in Backups & export.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("progressbar", { name: "First download" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
});

test("the first upload says where it goes", async () => {
  api.status.mockResolvedValue(
    syncStatus({
      folder: { name: "ticketd" },
      state: "upload_pending",
      first_sync: { direction: "upload", done: 1, total: 4 },
    }),
  );
  show();
  expect(await screen.findByText("Uploading 1 of 4 files")).toBeTruthy();
  expect(
    screen.getByText("To “ticketd” in you@example.com’s Drive"),
  ).toBeTruthy();
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

test("the step track follows setup from step 1 to in sync", async () => {
  const stage = () =>
    screen
      .getByRole("list", { name: "Sync setup" })
      .querySelector('[aria-current="step"]')?.textContent;
  show();
  await screen.findByRole("radiogroup", { name: "Start or join" });
  expect(stage()).toBe("Connect");
  cleanup();

  api.status.mockResolvedValue(choosing());
  show();
  await screen.findByRole("radiogroup", { name: "This Workspace" });
  expect(stage()).toBe("Choose a workspace");
  cleanup();

  api.status.mockResolvedValue(
    syncStatus({
      state: "upload_pending",
      first_sync: { direction: "upload", done: 1, total: 4 },
    }),
  );
  show();
  await screen.findByText("Uploading 1 of 4 files");
  expect(stage()).toBe("First sync");
  cleanup();

  api.status.mockResolvedValue(syncStatus());
  show();
  await screen.findByRole("heading", { name: "Disconnect" });
  expect(stage()).toBe("In sync");
});
