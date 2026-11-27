import { revealFailureDetails } from "@/test/failure-details";
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SourceStatusFooter } from "@/components/layout/SourceStatusFooter";
import { invoke } from "@tauri-apps/api/core";
import { onSyncStatus, syncApi, type SyncStatus } from "@/lib/sync-api";
import { SyncStatusProvider } from "./SyncStatusProvider";
import { useSyncNavigation, useSyncStatus } from "./sync-status";
import { hostFailure, notConnected, syncStatus } from "./sync-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/sync-api", async (original) => ({
  ...(await original<typeof import("@/lib/sync-api")>()),
  syncApi: { status: vi.fn(), syncNow: vi.fn(), recover: vi.fn() },
  onSyncStatus: vi.fn(),
}));
/** Sends a status as the desktop does when it changes. */
let push: (status: SyncStatus) => void = () => {};
const api = vi.mocked(syncApi);
/** The api as shipped, over the mocked bridge. */
const real = (
  await vi.importActual<typeof import("@/lib/sync-api")>("@/lib/sync-api")
).syncApi;
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const openSettings = vi.fn();
const openReview = vi.fn();
/** The app shell: it owns navigation and holds the sidebar footer. */
function Shell() {
  useSyncNavigation({ openSettings, openReview });
  return <SourceStatusFooter />;
}
async function footer(status: SyncStatus) {
  api.status.mockResolvedValue(status);
  vi.mocked(onSyncStatus).mockImplementation(async (handler) => {
    push = handler;
    return () => {};
  });
  render(
    <SyncStatusProvider>
      <Shell />
    </SyncStatusProvider>,
  );
  await waitFor(() => expect(api.status).toHaveBeenCalled());
}
const line = () => screen.findByRole("button", { expanded: false });
async function popover(name = "Google Drive sync") {
  fireEvent.click(await line());
  return screen.findByRole("dialog", { name });
}
const change = (title: string) => ({
  kind: "ticket" as const,
  id: title,
  reference: "T-KQ12",
  title,
});

test("the footer has no Drive line until this Workspace syncs", async () => {
  await footer(notConnected());
  await Promise.resolve();
  expect(screen.queryByRole("group")).toBeNull();
});

test("uploaded: the line says Drive synced and when, and the popover offers Sync now", async () => {
  await footer(syncStatus());
  expect((await line()).textContent).toBe("Drive synced1 min ago");
  expect(screen.getByRole("group", { name: "Sync" })).toBeTruthy();
  const dialog = await popover();
  expect(dialog.textContent).toContain("Last synced 1 min ago");
  expect(within(dialog).queryByRole("list")).toBeNull();
  const now = syncStatus({ last_synced_at: new Date().toISOString() });
  api.syncNow.mockResolvedValue(now);
  api.status.mockResolvedValue(now);
  fireEvent.click(within(dialog).getByRole("button", { name: "Sync now" }));
  expect(await within(dialog).findByText("Last synced just now")).toBeTruthy();
});

test("a status the desktop sends replaces the line, with no read of its own", async () => {
  await footer(syncStatus());
  expect((await line()).textContent).toBe("Drive synced1 min ago");
  api.status.mockClear();
  push(
    syncStatus({
      state: "upload_pending",
      pending_uploads: [change("A")],
      pending_total: 1,
    }),
  );
  await waitFor(async () =>
    expect((await line()).textContent).toBe(
      "Uploading 1 change…Saved on this computer",
    ),
  );
  expect(api.status).not.toHaveBeenCalled();
});

test("upload pending: the line counts the changes and says they are saved here", async () => {
  await footer(
    syncStatus({
      state: "upload_pending",
      pending_uploads: [change("A"), change("B"), change("C")],
    }),
  );
  expect((await line()).textContent).toBe(
    "Uploading 3 changes…Saved on this computer",
  );
  const dialog = await popover();
  expect(dialog.textContent).toContain("Uploading to Drive");
  expect(within(dialog).getByRole("listitem").textContent).toBe(
    "3 changes uploading",
  );
});

test("saved locally: offline changes wait, and the popover offers Sync now", async () => {
  await footer(
    syncStatus({
      state: "saved_locally",
      recovery: "offline",
      pending_uploads: [change("A"), change("B"), change("C")],
    }),
  );
  expect((await line()).textContent).toBe(
    "Saved on this computerOffline · 3 changes waiting",
  );
  // Offline needs no decision, so the footer carries no action of its own.
  expect(screen.getAllByRole("button")).toHaveLength(1);
  const dialog = await popover();
  expect(within(dialog).getByRole("listitem").textContent).toBe(
    "3 changes waiting to upload",
  );
  api.syncNow.mockImplementation(real.syncNow);
  vi.mocked(invoke).mockRejectedValue(hostFailure("no network"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Sync now" }));
  await revealFailureDetails(dialog);
  expect(within(dialog).getByRole("alert").textContent).toContain("no network");
});

test("Attachment download pending: the line counts files and what is left", async () => {
  await footer(
    syncStatus({
      state: "attachment_download_pending",
      attachment_downloads: { count: 2, bytes_left: 6.4 * 1048576 },
    }),
  );
  expect((await line()).textContent).toBe("Downloading 2 files…6.4 MB left");
  const dialog = await popover();
  expect(within(dialog).getByRole("listitem").textContent).toBe(
    "2 Attachments downloading",
  );
});

test("needs review: the line counts the tickets and Review opens them", async () => {
  await footer(
    syncStatus({
      state: "needs_attention",
      needs_review: [
        {
          kind: "ticket",
          id: "3f2c",
          reference: "T-KQ12",
          title: "Rate-limit failed login attempts",
        },
      ],
    }),
  );
  // The footer slot is too narrow for the kind; the name, tooltip and popover say it.
  const trigger = await line();
  expect(trigger.textContent).toBe("1 needs reviewSynced 1 min ago");
  expect(trigger.getAttribute("aria-label")).toBe(
    "1 ticket needs review, Synced 1 min ago",
  );
  fireEvent.pointerMove(within(trigger).getByText("1 needs review"));
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "1 ticket needs review",
  );
  fireEvent.keyDown(document.body, { key: "Escape" });
  const dialog = await popover();
  expect(within(dialog).getByText("1 ticket needs review")).toBeTruthy();
  expect(dialog.textContent).toContain("Changed on two desktops");
  expect(within(dialog).getByRole("listitem").textContent).toBe(
    "Rate-limit failed login attempts",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
  expect(openReview).toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("an expired sign-in offers Sign in in the popover; the line stays one target", async () => {
  await footer(
    syncStatus({ state: "needs_attention", recovery: "authorization_expired" }),
  );
  expect((await line()).textContent).toBe(
    "Drive sign-in expiredSaved on this computer",
  );
  // No second button beside the line does a related thing.
  expect(screen.getAllByRole("button")).toHaveLength(1);
  api.recover.mockResolvedValue(syncStatus());
  api.status.mockResolvedValue(syncStatus());
  const dialog = await popover();
  fireEvent.click(within(dialog).getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(api.recover).toHaveBeenCalled());
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(async () =>
    expect((await line()).textContent).toBe("Drive synced1 min ago"),
  );
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
});

test("an ended AWS session asks quietly on the line and signs in from the popover", async () => {
  await footer(
    syncStatus({
      provider: "s3",
      state: "needs_attention",
      recovery: "authorization_expired",
      pending_uploads: [change("A")],
    }),
  );
  expect((await line()).textContent).toBe(
    "AWS sign-in expiredSaved on this computer",
  );
  // Nothing opened by itself.
  expect(screen.queryByRole("dialog")).toBeNull();
  let finish: (status: SyncStatus) => void = () => {};
  api.recover.mockReturnValue(
    new Promise<SyncStatus>((resolve) => {
      finish = resolve;
    }),
  );
  const dialog = await popover("S3 sync");
  expect(dialog.textContent).toContain("Sign in to AWS again");
  expect(dialog.textContent).toContain("1 change uploads once you sign in.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(api.recover).toHaveBeenCalled());
  expect(
    within(dialog)
      .getByRole("button", { name: "Waiting for sign-in…" })
      .getAttribute("aria-disabled"),
  ).toBe("true");

  // Signed in: sync ran again and what waited is uploaded.
  finish(syncStatus({ provider: "s3" }));
  await waitFor(() =>
    expect(
      within(dialog).queryByRole("button", { name: "Sign in" }),
    ).toBeNull(),
  );
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(async () =>
    expect((await line()).textContent).toBe("S3 synced1 min ago"),
  );
});

test("the popover is reachable by keyboard and leads to Sync settings", async () => {
  await footer(syncStatus());
  const trigger = await line();
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  const dialog = await popover();
  fireEvent.click(within(dialog).getByRole("button", { name: "Settings" }));
  expect(openSettings).toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("saved locally: a busy Drive is named, not called offline", async () => {
  await footer(
    syncStatus({
      state: "saved_locally",
      recovery: "rate_limited",
      pending_uploads: [change("A")],
    }),
  );
  expect((await line()).textContent).toBe(
    "Saved on this computerDrive is busy · 1 change waiting",
  );
  // Sync retries by itself, so the footer carries no action of its own.
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(
    within(await popover()).getByRole("button", { name: "Sync now" }),
  ).toBeTruthy();
});

test("upload pending: the count is of everything waiting, not of the listed first few", async () => {
  await footer(
    syncStatus({
      state: "upload_pending",
      pending_uploads: [change("One"), change("Two")],
      pending_total: 40,
    }),
  );
  expect((await line()).textContent).toBe(
    "Uploading 40 changes…Saved on this computer",
  );
});

test("a sync failure with no state of its own needs attention and offers Retry", async () => {
  await footer(
    syncStatus({
      state: "needs_attention",
      recovery: "error",
      recovery_message: "disk I/O error",
    }),
  );
  expect((await line()).textContent).toContain("Sync needs attention");
  const dialog = await popover();
  expect(within(dialog).getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(dialog.textContent).toContain("disk I/O error");
});

test("a changed S3 service reads as a stop on the line, with Retry and the way to Disconnect", async () => {
  await footer(
    syncStatus({
      provider: "s3",
      state: "needs_attention",
      recovery: "service_changed",
      recovery_message: "This profile now points to another S3 service.",
    }),
  );
  expect((await line()).textContent).toBe(
    "S3 sync stoppedSaved on this computer",
  );
  const dialog = await popover("S3 sync");
  expect(dialog.textContent).toContain("Sync stopped");
  expect(dialog.textContent).toContain(
    "This profile now points to another S3 service.",
  );
  expect(within(dialog).getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "Disconnect in Settings" }),
  ).toBeTruthy();
});

test("a missing aws program reads as a stop on the line, with Retry and the way to choose it", async () => {
  await footer(
    syncStatus({
      provider: "s3",
      state: "needs_attention",
      recovery: "cli_unavailable",
      recovery_message: "The AWS CLI was not found.",
    }),
  );
  expect((await line()).textContent).toBe(
    "AWS CLI neededSaved on this computer",
  );
  const dialog = await popover("S3 sync");
  expect(dialog.textContent).toContain("The AWS CLI was not found.");
  expect(within(dialog).getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(
    within(dialog).getByRole("button", {
      name: "Choose the aws program in Settings",
    }),
  ).toBeTruthy();
});

test("a conflict waiting while offline: the popover offers Review and keeps Retry", async () => {
  const status = syncStatus({
    state: "needs_attention",
    recovery: "offline",
    needs_review: [change("Rate-limit failed login attempts")],
  });
  await footer(status);
  expect((await line()).textContent).toBe("1 needs reviewOffline");
  const dialog = await popover();
  api.recover.mockResolvedValue(status);
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
  expect(api.recover).toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Review" }));
  expect(openReview).toHaveBeenCalledTimes(1);
});

test("offline with something else to look at: the line says Offline and counts what waits, once", async () => {
  const status = syncStatus({
    state: "needs_attention",
    recovery: "offline",
    pending_uploads: [change("A"), change("B"), change("C")],
  });
  await footer(status);
  expect((await line()).textContent).toBe(
    "Sync needs attentionOffline · 3 changes waiting",
  );
  // Offline mends itself, so Retry is in the popover only.
  expect(screen.getAllByRole("button")).toHaveLength(1);
  const dialog = await popover();
  expect(dialog.textContent).toContain(
    "Offline · The Inbox says what happened",
  );
  expect(within(dialog).getByRole("listitem").textContent).toBe(
    "3 changes waiting to upload",
  );
  expect(within(dialog).getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("the same status sent again re-renders nothing", async () => {
  const status = syncStatus();
  api.status.mockImplementation(async () => structuredClone(status));
  vi.mocked(onSyncStatus).mockImplementation(async (handler) => {
    push = handler;
    return () => {};
  });
  const shellRendered = vi.fn();
  const readerRendered = vi.fn();
  function CountedShell() {
    shellRendered();
    useSyncNavigation({ openSettings, openReview });
    return null;
  }
  function Reader() {
    readerRendered();
    return <span>{useSyncStatus().status?.state}</span>;
  }
  render(
    <SyncStatusProvider>
      <CountedShell />
      <Reader />
    </SyncStatusProvider>,
  );
  await screen.findByText("uploaded");
  const before = [
    shellRendered.mock.calls.length,
    readerRendered.mock.calls.length,
  ];
  // The desktop sends a status equal to the one shown.
  act(() => push(structuredClone(status)));
  await Promise.resolve();
  expect([
    shellRendered.mock.calls.length,
    readerRendered.mock.calls.length,
  ]).toEqual(before);
});

test("an S3 binding names S3 on the line and in the popover, never Drive", async () => {
  await footer(syncStatus({ provider: "s3" }));
  expect((await line()).textContent).toBe("S3 synced1 min ago");
  const dialog = await popover("S3 sync");
  expect(dialog.textContent).toContain("S3 synced");
  expect(dialog.textContent).not.toMatch(/drive/i);
  cleanup();

  await footer(
    syncStatus({
      provider: "s3",
      state: "upload_pending",
      pending_uploads: [change("A")],
    }),
  );
  expect((await popover("S3 sync")).textContent).toContain("Uploading to S3");
  cleanup();

  await footer(
    syncStatus({
      provider: "s3",
      state: "saved_locally",
      recovery: "rate_limited",
      pending_uploads: [change("A")],
    }),
  );
  expect((await line()).textContent).toBe(
    "Saved on this computerS3 is busy · 1 change waiting",
  );
  cleanup();

  await footer(
    syncStatus({
      provider: "s3",
      state: "needs_attention",
      recovery: "authorization_expired",
    }),
  );
  expect((await line()).textContent).toBe(
    "AWS sign-in expiredSaved on this computer",
  );
  expect((await popover("S3 sync")).textContent).toContain(
    "Sign in to AWS again",
  );
});
