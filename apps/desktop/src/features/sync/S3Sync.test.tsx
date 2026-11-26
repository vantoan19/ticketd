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
import { writeClipboard } from "@/lib/clipboard";
import { workspaceClient } from "@/lib/api/workspace";
import { revealFailureDetails } from "@/test/failure-details";
import { s3Api } from "@/lib/s3-api";
import {
  syncApi,
  type SyncSetupOptions,
  type SyncStatus,
} from "@/lib/sync-api";
import { TestReads } from "@/lib/workspace-reads/testing";
import { SyncSettings } from "./SyncSettings";
import { SyncStatusProvider } from "./SyncStatusProvider";
import {
  hostFailure,
  syncSettings,
  syncStatus,
  workspaceInfo,
} from "./sync-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ writeClipboard: vi.fn() }));
vi.mock("@/lib/s3-api", async (original) => ({
  ...(await original<typeof import("@/lib/s3-api")>()),
  s3Api: { folderLinks: vi.fn(), chooseCli: vi.fn() },
}));
vi.mock("@/lib/sync-api", async (original) => ({
  ...(await original<typeof import("@/lib/sync-api")>()),
  syncApi: {
    status: vi.fn(),
    setupOptions: vi.fn(),
    uploadWorkspace: vi.fn(),
    reconnect: vi.fn(),
    downloadWorkspace: vi.fn(),
    recover: vi.fn(),
    disconnect: vi.fn(),
    openFolder: vi.fn(),
    settings: vi.fn(),
    setSettings: vi.fn(),
    devices: vi.fn(),
  },
}));
vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { reveal: vi.fn(), info: vi.fn() },
}));
const api = vi.mocked(syncApi);
const s3 = vi.mocked(s3Api);

const ARN = "arn:aws:sts::123456789012:assumed-role/Admin/mina";
const binding = {
  bucket: "team-ticketd",
  prefix: "ticketd/",
  profile: "work",
  aws_cli_path: null,
};
const choosing = () =>
  syncStatus({
    connection: "choosing",
    provider: "s3",
    account: ARN,
    s3: binding,
    folder: null,
    state: "saved_locally",
    last_synced_at: null,
  });
const connected = (overrides = {}) =>
  syncStatus({
    provider: "s3",
    account: ARN,
    s3: binding,
    folder: { name: "ticketd Workspace" },
    ...overrides,
  });
const options: SyncSetupOptions = {
  local: { tickets: 17, documents: 2, attachments: 3 },
  existing: [
    {
      folder_id: "folder-1",
      folder_name: "ticketd · web-app",
      last_synced_by: "Studio desktop",
      last_synced_at: null,
      counts: { tickets: 42, documents: 9, attachments: 12 },
    },
  ],
  reconnect: null,
};

function show() {
  return render(
    <TestReads>
      <SyncStatusProvider>
        <SyncSettings onReplaced={async () => {}} />
      </SyncStatusProvider>
    </TestReads>,
  );
}

beforeEach(() => {
  vi.mocked(workspaceClient.info).mockResolvedValue(workspaceInfo());
  api.settings.mockResolvedValue(syncSettings());
  api.devices.mockResolvedValue([]);
  api.setupOptions.mockResolvedValue(options);
  s3.folderLinks.mockResolvedValue({
    address: "s3://team-ticketd/ticketd/folder-1/",
    console: true,
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("choosing a Workspace in a bucket joins the one there by default, in the bucket's words", async () => {
  api.status.mockResolvedValue(choosing());
  api.uploadWorkspace.mockResolvedValue(
    connected({ first_sync: { direction: "upload", done: 3, total: 23 } }),
  );
  show();
  const join = await screen.findByRole("radio", {
    name: /Join “ticketd · web-app”/,
  });
  expect(join.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("Your bucket already has a Workspace")).toBeTruthy();
  expect(screen.getByText("Signed in")).toBeTruthy();
  expect(screen.getByText(`${ARN} · team-ticketd`)).toBeTruthy();
  expect(screen.queryByText(/Drive/)).toBeNull();
  // Starting a separate one is the person's choice, and says what it costs in the bucket.
  const separate = screen.getByRole("radio", {
    name: /Start a separate Workspace/,
  });
  expect(separate.textContent).toContain(
    "Your bucket then holds two Workspaces",
  );
  fireEvent.click(separate);
  expect(
    screen.getByText(
      "ticketd does not encrypt the files it puts in the bucket.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start syncing" }));
  expect(await screen.findByText("Uploading 3 of 23 files")).toBeTruthy();
  expect(
    screen.getByText("To “ticketd Workspace” in bucket team-ticketd"),
  ).toBeTruthy();
});

test("a bucket the check turns down says why, and is checked again once it is fixed", async () => {
  api.status.mockResolvedValue(choosing());
  api.setupOptions
    .mockRejectedValueOnce(
      hostFailure("Turn on Versioning for the bucket team-ticketd"),
    )
    .mockResolvedValueOnce(options);
  show();
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain(
    "Turn on Versioning for the bucket team-ticketd",
  );
  // Nothing starts from a bucket that failed its check.
  expect(
    screen
      .getByRole("button", { name: "Start syncing" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("radio", { name: /Join “ticketd · web-app”/ }),
  ).toBeTruthy();
  expect(api.setupOptions).toHaveBeenCalledTimes(2);
});

test("a bucket that does not exist says so in the headline and offers another bucket, not Retry", async () => {
  api.status.mockResolvedValue(choosing());
  api.disconnect.mockResolvedValue(
    syncStatus({ connection: "not_connected", account: null, folder: null }),
  );
  api.setupOptions.mockRejectedValue({
    code: "not_found",
    index: null,
    message:
      "sync storage: the bucket ticketd-qa-nonexistent does not exist, or the profile's account cannot see it; check the bucket name",
  });
  show();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't read the bucket.");
  // The text reads once, without the host's prefixes, and is not the generic one.
  expect(alert.textContent).toContain(
    "The bucket ticketd-qa-nonexistent does not exist, or the profile's account cannot see it; check the bucket name.",
  );
  expect(alert.textContent).not.toContain("couldn't be confirmed");
  expect(alert.textContent).not.toContain("It was deleted or moved");
  expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();
  fireEvent.click(
    within(alert).getByRole("button", { name: "Use another bucket…" }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Use another bucket" }),
  );
  await waitFor(() => expect(api.disconnect).toHaveBeenCalled());
});

test("downloading from the bucket asks first, like a restore", async () => {
  api.status.mockResolvedValue(choosing());
  api.downloadWorkspace.mockResolvedValue({
    ...connected({ first_sync: { direction: "download", done: 0, total: 51 } }),
    safety_backup: "/backups/before-download.sqlite3",
  });
  show();
  fireEvent.click(
    await screen.findByRole("radio", { name: /Join “ticketd · web-app”/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Join…" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("from the bucket");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Replace Workspace" }),
  );
  await waitFor(() =>
    expect(api.downloadWorkspace).toHaveBeenCalledWith("folder-1"),
  );
});

test("a Workspace that synced with this bucket before is offered back, and nothing is replaced", async () => {
  api.status.mockResolvedValue(choosing());
  api.setupOptions.mockResolvedValue({
    ...options,
    reconnect: { id: "folder-1", name: "ticketd · web-app" },
  });
  api.reconnect.mockResolvedValue(connected());
  show();
  const reconnect = await screen.findByRole("radio", {
    name: /Reconnect to “ticketd · web-app”/,
  });
  expect(reconnect.textContent).toContain("here and in the bucket are merged");
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(api.reconnect).toHaveBeenCalled());
});

test("another bucket is chosen by disconnecting, which deletes nothing", async () => {
  api.status.mockResolvedValue(choosing());
  api.disconnect.mockResolvedValue(
    syncStatus({ connection: "not_connected", account: null, folder: null }),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Use another bucket…" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("Nothing in the bucket");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Use another bucket" }),
  );
  await waitFor(() => expect(api.disconnect).toHaveBeenCalled());
});

test("a synced bucket names the profile and sign-in, shows its address and opens the AWS console", async () => {
  api.status.mockResolvedValue(connected());
  api.openFolder.mockResolvedValue();
  show();
  const status = await screen.findByRole("group", { name: "Sync status" });
  expect(within(status).getByText("Synced")).toBeTruthy();
  expect(status.textContent).toContain(`profile “work” · signed in as ${ARN}`);
  expect(status.textContent).toContain(
    "s3://team-ticketd/ticketd/ · readable files, not encrypted by ticketd.",
  );
  fireEvent.click(
    await within(status).findByRole("button", { name: "Open in AWS console" }),
  );
  expect(api.openFolder).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Copy s3/ })).toBeNull();
  // The computers, the options and Disconnect are the page's, as with Drive.
  expect(
    await screen.findByText("This computer · tickets T-KQ1, T-KQ2…"),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Disconnect…" })).toBeTruthy();
});

test("another S3 service has no console, so its address is copied", async () => {
  api.status.mockResolvedValue(connected());
  s3.folderLinks.mockResolvedValue({
    address: "s3://team-ticketd/ticketd/folder-1/",
    console: false,
  });
  vi.mocked(writeClipboard).mockResolvedValue(null);
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Copy s3:// address" }),
  );
  await waitFor(() =>
    expect(writeClipboard).toHaveBeenCalledWith(
      "s3://team-ticketd/ticketd/folder-1/",
    ),
  );
  expect(screen.queryByRole("button", { name: /AWS console/ })).toBeNull();
});

test("an ended AWS session is the status row, signed in again through the profile", async () => {
  const waiting = {
    kind: "ticket" as const,
    id: "t1",
    reference: "T-KQ1",
    title: "A",
  };
  api.status.mockResolvedValue(
    connected({
      state: "needs_attention",
      recovery: "authorization_expired",
      pending_uploads: [waiting, waiting, waiting],
    }),
  );
  let finish: (status: SyncStatus) => void = () => {};
  api.recover.mockReturnValue(
    new Promise<SyncStatus>((resolve) => {
      finish = resolve;
    }),
  );
  show();
  // The row itself, not a dialog and not a second box.
  const row = await screen.findByRole("alert");
  expect(row.textContent).toContain("Signed out");
  expect(row.textContent).toContain(
    "The AWS CLI sign-in for profile “work” ended. 3 changes are saved here and upload after you sign in.",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();

  fireEvent.click(within(row).getByRole("button", { name: /^Sign in/ }));
  await waitFor(() => expect(api.recover).toHaveBeenCalled());
  // The sign-in waits for the browser; the button says so and cannot be pressed twice.
  const waitingButton = await within(row).findByRole("button", {
    name: /Waiting for sign-in…/,
  });
  expect((waitingButton as HTMLButtonElement).disabled).toBe(true);

  finish(connected());
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

const SAID =
  "This profile now points to another S3 service: it reaches http://127.0.0.1:9001, and this Workspace's bucket was connected through http://127.0.0.1:9000. To move the bucket on purpose, disconnect sync, then connect again; otherwise point the profile back.";
const stopped = () =>
  connected({
    state: "needs_attention",
    recovery: "service_changed",
    recovery_message: SAID,
  });

test("a profile that now reaches another service stops sync: Not syncing, the message once, and Disconnect beside it", async () => {
  api.status.mockResolvedValue(stopped());
  api.disconnect.mockResolvedValue(
    syncStatus({ connection: "not_connected", account: null, folder: null }),
  );
  show();
  const notice = await screen.findByRole("alert");
  // The sentence as the core wrote it, once, with no internal prefix.
  expect(notice.textContent).toContain(SAID);
  expect(notice.textContent).not.toMatch(/sync storage|storage:/i);
  expect(document.body.textContent?.split(SAID).length).toBe(2);
  // The page does not claim a working connection.
  expect(screen.queryByText("Synced")).toBeNull();
  expect(within(notice).getByText("Not syncing")).toBeTruthy();
  // The way out the message names is next to it, behind the usual confirmation.
  fireEvent.click(within(notice).getByRole("button", { name: "Disconnect…" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(api.disconnect).toHaveBeenCalled());
  expect(api.recover).not.toHaveBeenCalled();
});

test("a stopped service can still be retried once the profile points back", async () => {
  api.status.mockResolvedValue(stopped());
  api.recover.mockResolvedValue(connected());
  show();
  const notice = await screen.findByRole("alert");
  fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api.recover).toHaveBeenCalled());
  expect(await screen.findByText("Synced")).toBeTruthy();
});

test("the status row agrees with the problem: Offline, not a green dot, and nothing above it moves", async () => {
  api.status.mockResolvedValue(
    connected({ state: "saved_locally", recovery: "offline" }),
  );
  show();
  const row = await screen.findByRole("alert");
  const label = row.querySelector('[data-slot="status-label"]')!;
  expect(label.textContent).toBe("Offline");
  expect(label.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe(
    "neutral",
  );
  // One row says it: no separate notice repeats it.
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

const NO_CLI =
  "The AWS CLI was not found. Install AWS CLI version 2, or choose where the aws program is.";
const noCli = () =>
  connected({
    state: "needs_attention",
    recovery: "cli_unavailable",
    recovery_message: NO_CLI,
  });

test("sync stopped for want of the aws program offers to choose it, then tries again", async () => {
  api.status.mockResolvedValue(noCli());
  api.recover.mockResolvedValue(connected());
  s3.chooseCli.mockResolvedValue(true);
  show();
  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toContain(NO_CLI);
  expect(notice.textContent).not.toMatch(/sync storage|storage:/i);
  expect(screen.queryByText("Synced")).toBeNull();
  fireEvent.click(
    within(notice).getByRole("button", { name: "Choose the aws program…" }),
  );
  await waitFor(() => expect(s3.chooseCli).toHaveBeenCalled());
  await waitFor(() => expect(api.recover).toHaveBeenCalled());
  expect(await screen.findByText("Synced")).toBeTruthy();
});

test("sync stopped by an old aws program names its version and the one needed", async () => {
  const said = "AWS CLI 2.9.0 is too old. ticketd needs 2.13 or later.";
  api.status.mockResolvedValue(
    connected({
      state: "needs_attention",
      recovery: "cli_unavailable",
      recovery_message: said,
    }),
  );
  show();
  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toContain(said);
  expect(notice.textContent).not.toMatch(/aws-cli\//);
});

test("a cancelled picker changes nothing, and a refused program says why", async () => {
  api.status.mockResolvedValue(noCli());
  s3.chooseCli.mockResolvedValueOnce(false);
  show();
  const notice = await screen.findByRole("alert");
  const choose = within(notice).getByRole("button", {
    name: "Choose the aws program…",
  });
  fireEvent.click(choose);
  await waitFor(() => expect(s3.chooseCli).toHaveBeenCalledTimes(1));
  expect(api.recover).not.toHaveBeenCalled();

  s3.chooseCli.mockRejectedValueOnce(
    hostFailure("ticketd needs AWS CLI version 2.13 or later"),
  );
  fireEvent.click(choose);
  await revealFailureDetails();
  expect(
    await screen.findByText(/ticketd needs AWS CLI version 2\.13 or later/),
  ).toBeTruthy();
  expect(api.recover).not.toHaveBeenCalled();
});

test("disconnecting from a bucket says what stays", async () => {
  api.status.mockResolvedValue(connected());
  api.disconnect.mockResolvedValue(
    syncStatus({ connection: "not_connected", account: null, folder: null }),
  );
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect…" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("In the bucket");
  expect(dialog.textContent).not.toContain("Drive");
  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(api.disconnect).toHaveBeenCalled());
});
