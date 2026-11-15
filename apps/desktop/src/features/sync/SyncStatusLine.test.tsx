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
import { SourceStatusFooter } from "@/components/layout/SourceStatusFooter";
import { invoke } from "@tauri-apps/api/core";
import { syncApi, type SyncStatus } from "@/lib/sync-api";
import { SyncStatusProvider } from "./SyncStatusProvider";
import { useSyncNavigation } from "./sync-status";
import { hostFailure, notConnected, syncStatus } from "./sync-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/sync-api", async (original) => ({
  ...(await original<typeof import("@/lib/sync-api")>()),
  syncApi: { status: vi.fn(), syncNow: vi.fn(), recover: vi.fn() },
}));
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
  render(
    <SyncStatusProvider>
      <Shell />
    </SyncStatusProvider>,
  );
  await waitFor(() => expect(api.status).toHaveBeenCalled());
}
const line = () => screen.findByRole("button", { expanded: false });
async function popover() {
  fireEvent.click(await line());
  return screen.findByRole("dialog", { name: "Google Drive sync" });
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

test("saved locally: offline changes wait, and the popover offers Try now", async () => {
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
  fireEvent.click(within(dialog).getByRole("button", { name: "Try now" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "Couldn't sync. No network.",
  );
});

test("Attachment download pending: the line counts files and what is left", async () => {
  await footer(
    syncStatus({
      state: "attachment_download_pending",
      attachment_downloads: { count: 2, bytes_left: 6.4 * 1048576 },
    }),
  );
  expect((await line()).textContent).toBe("Downloading 2 files…6.4 MiB left");
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

test("an expired sign-in puts Reconnect on the footer line", async () => {
  await footer(
    syncStatus({ state: "needs_attention", recovery: "authorization_expired" }),
  );
  expect((await line()).textContent).toBe(
    "Drive sign-in expiredSaved on this computer",
  );
  api.recover.mockResolvedValue(syncStatus());
  api.status.mockResolvedValue(syncStatus());
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  await waitFor(async () =>
    expect((await line()).textContent).toBe("Drive synced1 min ago"),
  );
  expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
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
    within(await popover()).getByRole("button", { name: "Try now" }),
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
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect((await popover()).textContent).toContain("disk I/O error");
});

test("a conflict waiting while offline: the line offers Review, and the popover keeps Retry", async () => {
  const status = syncStatus({
    state: "needs_attention",
    recovery: "offline",
    needs_review: [change("Rate-limit failed login attempts")],
  });
  await footer(status);
  expect((await line()).textContent).toBe("1 needs reviewOffline");
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(openReview).toHaveBeenCalledTimes(1);
  const dialog = await popover();
  expect(within(dialog).getByRole("button", { name: "Review" })).toBeTruthy();
  api.recover.mockResolvedValue(status);
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
  expect(api.recover).toHaveBeenCalled();
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
