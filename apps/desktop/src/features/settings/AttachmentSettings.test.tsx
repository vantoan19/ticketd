import { revealFailureDetails } from "@/test/failure-details";
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { syncStatus } from "@/features/sync/sync-fixtures";
import {
  SyncStatusContext,
  type SyncStatusValue,
} from "@/features/sync/sync-status";
import type { SyncStatus } from "@/lib/sync-api";
import { AttachmentSettings } from "./AttachmentSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const destination = {
  connection_id: "account",
  folder_id: "folder",
  resource_key: null,
};
const drive = {
  kind: "google_drive",
  destination,
  folder_name: "Team files",
  account: "sam.lee@gmail.com",
};
const uploads = {
  kind: "google_drive",
  destination: { ...destination, folder_id: "uploads" },
  folder_name: "Uploads",
  account: "sam.lee@gmail.com",
  sync_folder: "workspace-1",
};

/** Workspace sync on Google Drive, in its folder, with the one Google sign-in. */
const syncing = (overrides: Partial<SyncStatus> = {}) =>
  syncStatus({
    account: "sam.lee@gmail.com",
    connection_id: "account",
    folder: { id: "workspace-1", name: "ticketd" },
    ...overrides,
  });

/** Answers the commands the page sends; `overrides` replace single answers. */
function answer(overrides: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = {
    attachment_upload_destination: { kind: "local" },
    drive_configuration: { configured: true, message: "Ready" },
    select_drive_upload_folder: {
      destination,
      folder: { id: "folder", name: "Team files", can_add_children: true },
      account: "sam.lee@gmail.com",
    },
    set_attachment_upload_destination: drive,
    use_sync_uploads_folder: uploads,
    use_another_google_account: syncStatus({
      connection: "choosing",
      folder: null,
      account: "mira@gmail.com",
      connection_id: "other",
    }),
    sync_recover: syncing(),
    ...overrides,
  };
  vi.mocked(invoke).mockImplementation(async (command) => {
    const value = answers[command];
    if (value instanceof Error) throw value;
    return value ?? null;
  });
}

function page(status: SyncStatus | null = null) {
  const apply = vi.fn();
  const value: SyncStatusValue = {
    status,
    apply,
    refresh: () => Promise.reject(new Error("not read")),
    openSettings: () => {},
    openReview: () => {},
  };
  render(
    <SyncStatusContext value={value}>
      <AttachmentSettings />
    </SyncStatusContext>,
  );
  return { apply };
}

const tile = (name: RegExp) => screen.findByRole("radio", { name });
const thisComputer = () => tile(/This computer/);
const googleDrive = () => tile(/Google Drive/);
const calls = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

test("two choices say where new files go and what each gives", async () => {
  answer();
  page();
  const local = await thisComputer();
  await waitFor(() => expect(local.getAttribute("data-state")).toBe("checked"));
  expect(local.textContent).toContain("Kept beside this Workspace.");
  expect(local.textContent).toContain("Works offline · Included in backups");
  const remote = await googleDrive();
  expect(remote.textContent).toContain("Kept in a folder in your Drive.");
  expect(remote.textContent).toContain(
    "Workspace sync’s sign-in · Not in backups",
  );
  expect(
    screen.getByText("Files you already attached stay where they are."),
  ).toBeTruthy();
  // The knob nobody needs is gone, with the notes about how it works.
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.queryByText(/Largest file/)).toBeNull();
  expect(screen.queryByText(/Drive failures never/)).toBeNull();
  expect(screen.queryByText("Google account")).toBeNull();
});

test("a build without Google disables the Drive tile and says why in its facts", async () => {
  answer({
    drive_configuration: { configured: false, message: "Set CLIENT_ID" },
  });
  page();
  const remote = await googleDrive();
  await waitFor(() =>
    expect((remote as HTMLButtonElement).disabled).toBe(true),
  );
  expect(remote.textContent).toContain("Not set up in this build");
  expect(screen.queryByText(/isn't set up on this computer/)).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Set up Google Drive/ }),
  ).toBeNull();
});

test("without sync on Drive, choosing Drive picks a folder and shows the account and Change folder", async () => {
  answer();
  page(
    syncStatus({ connection: "not_connected", account: null, folder: null }),
  );
  const local = await thisComputer();
  await waitFor(() => expect(local.getAttribute("data-state")).toBe("checked"));
  fireEvent.click(await googleDrive());

  expect(await screen.findByText("sam.lee@gmail.com")).toBeTruthy();
  expect(screen.getByText("“Team files”")).toBeTruthy();
  expect(calls("select_drive_upload_folder")).toHaveLength(1);
  expect(invoke).toHaveBeenCalledWith("set_attachment_upload_destination", {
    destination,
    account: "sam.lee@gmail.com",
  });
  expect(calls("use_sync_uploads_folder")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Change folder…" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Use another account…" }),
  ).toBeTruthy();
});

test("with sync on S3 the folder is chosen as it always was", async () => {
  answer();
  page(
    syncStatus({
      provider: "s3",
      account: "arn:aws:iam::1:user/me",
      s3: {
        bucket: "b",
        prefix: "ticketd/",
        profile: "work",
        aws_cli_path: null,
      },
    }),
  );
  fireEvent.click(await googleDrive());
  expect(await screen.findByText("“Team files”")).toBeTruthy();
  expect(calls("select_drive_upload_folder")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Change folder…" })).toBeTruthy();
});

test("with sync on Drive, choosing Drive needs no consent and no folder", async () => {
  answer();
  page(syncing());
  const local = await thisComputer();
  await waitFor(() => expect(local.getAttribute("data-state")).toBe("checked"));
  fireEvent.click(await googleDrive());

  expect(
    await screen.findByText("Uploads, inside your “ticketd” sync folder"),
  ).toBeTruthy();
  expect(
    screen.getByText("sam.lee@gmail.com, the one Workspace sync uses"),
  ).toBeTruthy();
  expect(calls("use_sync_uploads_folder")).toHaveLength(1);
  expect(calls("select_drive_upload_folder")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Change folder…" })).toBeNull();
});

test("opening the page makes no call to Drive, even with a Drive folder chosen before sync", async () => {
  answer({ attachment_upload_destination: drive });
  page(syncing());
  expect(await screen.findByText("“Team files”")).toBeTruthy();
  expect(calls("use_sync_uploads_folder")).toHaveLength(0);
});

test("the Uploads folder stays put and keeps its words while the page is open", async () => {
  answer({ attachment_upload_destination: uploads });
  page(syncing());
  expect(
    await screen.findByText("Uploads, inside your “ticketd” sync folder"),
  ).toBeTruthy();
  expect(calls("use_sync_uploads_folder")).toHaveLength(0);
});

test("after sync stops, the folder is an ordinary one with Change folder", async () => {
  answer({ attachment_upload_destination: uploads });
  page(
    syncStatus({ connection: "not_connected", account: null, folder: null }),
  );
  expect(await screen.findByText("“Uploads”")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change folder…" })).toBeTruthy();
  expect(screen.getByText("sam.lee@gmail.com")).toBeTruthy();
});

test("Use another account names Files and Workspace sync before anything changes", async () => {
  answer({ attachment_upload_destination: uploads });
  const { apply } = page(syncing());
  fireEvent.click(
    await screen.findByRole("button", { name: "Use another account…" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Use another Google account?",
  });
  expect(dialog.textContent).toContain("Files and Workspace sync");
  expect(dialog.textContent).toContain("sam.lee@gmail.com");
  expect(dialog.textContent).toContain("Stops on this computer");
  await waitFor(() =>
    expect(dialog.textContent).toContain("kept on this computer"),
  );
  expect(calls("use_another_google_account")).toHaveLength(0);

  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls("use_another_google_account")).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: "Use another account…" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Use another account",
    }),
  );
  await waitFor(() =>
    expect(calls("use_another_google_account")).toHaveLength(1),
  );
  await waitFor(() => expect(apply).toHaveBeenCalled());
});

test("a sign-in that ended shows Signed out, and one Sign in again resumes both", async () => {
  answer({ attachment_upload_destination: uploads });
  const { apply } = page(syncing({ recovery: "authorization_expired" }));
  expect(await screen.findByText("Signed out")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  await waitFor(() => expect(calls("sync_recover")).toHaveLength(1));
  await waitFor(() => expect(apply).toHaveBeenCalled());
});

test("a failed change keeps the choice and says what failed", async () => {
  answer({ attachment_upload_destination: drive });
  page(
    syncStatus({ connection: "not_connected", account: null, folder: null }),
  );
  await screen.findByText("“Team files”");
  // The picker answers with another folder, which the host then refuses.
  answer({
    attachment_upload_destination: drive,
    select_drive_upload_folder: {
      destination: { ...destination, folder_id: "read-only" },
      folder: { id: "read-only", name: "Archive", can_add_children: false },
      account: "sam.lee@gmail.com",
    },
    set_attachment_upload_destination: new Error(
      "Folder is read-only. Choose a writable folder.",
    ),
  });
  fireEvent.click(screen.getByRole("button", { name: "Change folder…" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't change the upload destination",
  );
  await revealFailureDetails();
  expect(screen.getByText("“Team files”")).toBeTruthy();
  expect(screen.queryByText(/Archive/)).toBeNull();
  expect((await googleDrive()).getAttribute("data-state")).toBe("checked");
});

test("an unreadable destination offers Retry", async () => {
  answer({ attachment_upload_destination: new Error("offline") });
  page();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't read the upload destination",
  );
  answer();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  const local = await thisComputer();
  await waitFor(() => expect(local.getAttribute("data-state")).toBe("checked"));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("with sync on Drive and the destination still elsewhere, the action says it moves new files to the sync Uploads folder", async () => {
  answer({ attachment_upload_destination: drive });
  page(syncing());
  expect(await screen.findByText("“Team files”")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Change folder…" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Use sync Uploads folder" }),
  );
  expect(
    await screen.findByText("Uploads, inside your “ticketd” sync folder"),
  ).toBeTruthy();
  expect(calls("use_sync_uploads_folder")).toHaveLength(1);
  expect(calls("select_drive_upload_folder")).toHaveLength(0);
});

test("a switch that worked but whose destination cannot be read again offers only to read it", async () => {
  answer({ attachment_upload_destination: uploads });
  page(syncing());
  expect(
    await screen.findByText("Uploads, inside your “ticketd” sync folder"),
  ).toBeTruthy();
  answer({ attachment_upload_destination: new Error("offline") });
  fireEvent.click(screen.getByRole("button", { name: "Use another account…" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Use another account",
    }),
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't read the upload destination");
  expect(alert.textContent).not.toContain("use another account");
  // The old account's folder is not shown as if it were still the destination.
  expect(screen.queryByText(/sync folder/)).toBeNull();
  expect(calls("use_another_google_account")).toHaveLength(1);

  answer();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  const local = await thisComputer();
  await waitFor(() => expect(local.getAttribute("data-state")).toBe("checked"));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(calls("use_another_google_account")).toHaveLength(1);
});
