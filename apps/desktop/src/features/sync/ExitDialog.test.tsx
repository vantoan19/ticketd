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
import { windowClient } from "@/lib/api/window";
import {
  syncApi,
  type SyncExitReport,
  type SyncPendingItem,
} from "@/lib/sync-api";
import { ExitDialog } from "./ExitDialog";
import { SyncStatusProvider } from "./SyncStatusProvider";
import { notConnected, syncStatus } from "./sync-fixtures";

vi.mock("@/lib/sync-api", async (original) => ({
  ...(await original<typeof import("@/lib/sync-api")>()),
  syncApi: { status: vi.fn(), flushOnExit: vi.fn() },
}));
vi.mock("@/lib/api/window", () => ({
  windowClient: { guardClose: vi.fn(() => () => {}), quit: vi.fn() },
}));
const api = vi.mocked(syncApi);
const win = vi.mocked(windowClient);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  win.guardClose.mockImplementation(() => () => {});
});

const ticket: SyncPendingItem = {
  kind: "ticket",
  id: "t12",
  reference: "T-KQ12",
  title: "Rate-limit failed login attempts",
};
const spec: SyncPendingItem = {
  kind: "document",
  id: "d1",
  reference: null,
  title: "Login hardening spec",
};
const image: SyncPendingItem = {
  kind: "attachment",
  id: "a1",
  reference: null,
  title: "login-429-response.png",
};
const uploading = (pending: SyncPendingItem[]) =>
  syncStatus({ state: "upload_pending", pending_uploads: pending });

/** Renders the app's exit guard and returns what closing the window does. */
function guard() {
  render(
    <SyncStatusProvider>
      <ExitDialog />
    </SyncStatusProvider>,
  );
  const close = win.guardClose.mock.calls[0]?.[0];
  if (!close) throw new Error("the window close is not guarded");
  return () => act(close);
}

/** A flush the test ends itself, as the core does within 10 seconds. */
function flush() {
  let finish: (report: SyncExitReport) => void = () => {};
  api.flushOnExit.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  return (pending: SyncPendingItem[]) => act(async () => finish({ pending }));
}

test("closing with nothing to upload quits at once", async () => {
  api.status.mockResolvedValue(syncStatus());
  guard()();
  await waitFor(() => expect(win.quit).toHaveBeenCalled());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.flushOnExit).not.toHaveBeenCalled();
});

test("closing without sync, or when its status cannot be read, quits at once", async () => {
  api.status.mockResolvedValue(notConnected());
  const close = guard();
  close();
  await waitFor(() => expect(win.quit).toHaveBeenCalledTimes(1));
  api.status.mockRejectedValue(new Error("core is gone"));
  close();
  await waitFor(() => expect(win.quit).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("closing while uploads are pending says work is saved, lists them and quits when they finish", async () => {
  api.status.mockResolvedValue(uploading([ticket, spec, image]));
  const finish = flush();
  guard()();
  const dialog = await screen.findByRole("dialog", {
    name: "Finishing upload",
  });
  expect(dialog.textContent).toContain(
    "Everything is saved on this computer. ticketd closes when the upload is done, or in 10 seconds.",
  );
  expect(within(dialog).getByRole("status").textContent).toBe(
    "0 of 3 uploaded",
  );
  const items = within(
    within(dialog).getByRole("list", { name: "Still uploading" }),
  ).getAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "T-KQ12Rate-limit failed login attempts",
    "Login hardening spec",
    "login-429-response.png",
  ]);
  expect(win.quit).not.toHaveBeenCalled();
  await finish([]);
  expect(win.quit).toHaveBeenCalledTimes(1);
});

test("the exit dialog opens with focus on Quit", async () => {
  api.status.mockResolvedValue(uploading([ticket]));
  const finish = flush();
  guard()();
  const dialog = await screen.findByRole("dialog");
  const quit = within(dialog).getByRole("button", { name: "Quit now" });
  await waitFor(() => expect(document.activeElement).toBe(quit));
  await finish([ticket]);
  expect(document.activeElement).toBe(
    within(dialog).getByRole("button", { name: "Quit" }),
  );
});

test("after the limit the dialog stays open with what did not upload, until one click", async () => {
  api.status.mockResolvedValue(uploading([ticket, spec, image]));
  const finish = flush();
  guard()();
  await screen.findByRole("dialog", { name: "Finishing upload" });
  await finish([spec, image]);
  const dialog = await screen.findByRole("dialog", {
    name: "2 uploads did not finish",
  });
  expect(dialog.textContent).toContain(
    "They are saved on this computer and upload the next time ticketd is open.",
  );
  expect(
    within(dialog)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Login hardening spec", "login-429-response.png"]);
  expect(within(dialog).queryByRole("status")).toBeNull();
  expect(win.quit).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Quit" }));
  expect(win.quit).toHaveBeenCalledTimes(1);
});

test("Quit now does not wait for the upload", async () => {
  api.status.mockResolvedValue(uploading([ticket]));
  flush();
  guard()();
  fireEvent.click(await screen.findByRole("button", { name: "Quit now" }));
  expect(win.quit).toHaveBeenCalledTimes(1);
});

test("Keep open returns to the app, and a finished upload no longer quits it", async () => {
  api.status.mockResolvedValue(uploading([ticket]));
  const finish = flush();
  guard()();
  fireEvent.click(await screen.findByRole("button", { name: "Keep open" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await finish([]);
  expect(win.quit).not.toHaveBeenCalled();
});

test("a flush that fails is reported as unfinished instead of quitting silently", async () => {
  api.status.mockResolvedValue(uploading([ticket]));
  api.flushOnExit.mockRejectedValue(new Error("core is gone"));
  guard()();
  expect(
    await screen.findByRole("dialog", { name: "1 upload did not finish" }),
  ).toBeTruthy();
  expect(win.quit).not.toHaveBeenCalled();
});

test("uploads beyond the listed ones are counted and said as more", async () => {
  api.status.mockResolvedValue(
    syncStatus({
      state: "upload_pending",
      pending_uploads: [ticket, spec],
      pending_total: 40,
    }),
  );
  api.flushOnExit.mockResolvedValue({ pending: [spec], pending_total: 38 });
  guard()();
  const dialog = await screen.findByRole("dialog", {
    name: "38 uploads did not finish",
  });
  expect(
    within(dialog)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Login hardening spec", "and 37 more"]);
});
