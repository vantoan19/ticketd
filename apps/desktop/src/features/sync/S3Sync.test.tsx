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
import { hostFailure, syncSettings, syncStatus } from "./sync-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ writeClipboard: vi.fn() }));
vi.mock("@/lib/s3-api", async (original) => ({
  ...(await original<typeof import("@/lib/s3-api")>()),
  s3Api: { folderLinks: vi.fn() },
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
  },
}));
vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { reveal: vi.fn() },
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
  api.settings.mockResolvedValue(syncSettings());
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

test("choosing a Workspace in a bucket uploads this one by default, in the bucket's words", async () => {
  api.status.mockResolvedValue(choosing());
  api.uploadWorkspace.mockResolvedValue(
    connected({ first_sync: { direction: "upload", done: 3, total: 23 } }),
  );
  show();
  const upload = await screen.findByRole("radio", {
    name: /Upload this Workspace/,
  });
  expect(upload.textContent).toContain("go to a new folder in the bucket");
  expect(screen.getByText(`Connected as ${ARN}`)).toBeTruthy();
  expect(
    screen.getByText(
      "ticketd does not encrypt the files it puts in the bucket.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/Drive/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Start sync" }));
  expect(await screen.findByText("Uploading 3 of 23 files")).toBeTruthy();
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
    screen.getByRole("button", { name: "Start sync" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("radio", { name: /Upload this Workspace/ }),
  ).toBeTruthy();
  expect(api.setupOptions).toHaveBeenCalledTimes(2);
});

test("a bucket that does not exist says so in the headline", async () => {
  api.status.mockResolvedValue(choosing());
  api.setupOptions.mockRejectedValue(
    hostFailure(
      "sync storage: storage: the bucket ticketd-qa-nonexistent does not exist, or the profile's account cannot see it; check the bucket name",
    ),
  );
  show();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't read the bucket.");
  expect(alert.textContent).toContain(
    "The bucket ticketd-qa-nonexistent does not exist, or the profile's account cannot see it; check the bucket name.",
  );
  expect(alert.textContent).not.toContain("couldn't be confirmed");
});

test("downloading from the bucket asks first, like a restore", async () => {
  api.status.mockResolvedValue(choosing());
  api.downloadWorkspace.mockResolvedValue({
    ...connected({ first_sync: { direction: "download", done: 0, total: 51 } }),
    safety_backup: "/backups/before-download.sqlite3",
  });
  show();
  fireEvent.click(
    await screen.findByRole("radio", { name: /Download “ticketd · web-app”/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Download…" }));
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

test("a connected bucket shows who this desktop is and opens the AWS console", async () => {
  api.status.mockResolvedValue(connected());
  api.openFolder.mockResolvedValue();
  show();
  expect(await screen.findByText(ARN)).toBeTruthy();
  expect(
    screen.getByText(
      "“ticketd Workspace” in s3://team-ticketd/ticketd/ · profile work",
    ),
  ).toBeTruthy();
  fireEvent.click(
    await screen.findByRole("button", { name: "Open in AWS console" }),
  );
  expect(api.openFolder).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Copy s3/ })).toBeNull();
  // The desktop's own settings and Disconnect are the page's, as with Drive.
  expect(await screen.findByLabelText("Name")).toBeTruthy();
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

test("an ended AWS session is signed in again through the profile", async () => {
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
      pending_uploads: [waiting, waiting],
    }),
  );
  let finish: (status: SyncStatus) => void = () => {};
  api.recover.mockReturnValue(
    new Promise<SyncStatus>((resolve) => {
      finish = resolve;
    }),
  );
  show();
  // A notice on the page, not a dialog.
  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toContain("Sign in to AWS again");
  expect(notice.textContent).toContain(
    "Your work is saved on this computer. 2 changes upload once you sign in.",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();

  fireEvent.click(within(notice).getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(api.recover).toHaveBeenCalled());
  // The sign-in waits for the browser; the button says so and cannot be pressed twice.
  const waitingButton = await within(notice).findByRole("button", {
    name: "Waiting for sign-in…",
  });
  expect((waitingButton as HTMLButtonElement).disabled).toBe(true);

  finish(connected());
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
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
