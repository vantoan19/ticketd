// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { DraftRecoveryProvider } from "./draft-recovery";
import { WorkspaceBand } from "@/app/WorkspaceBand";
import {
  DraftRecoveryGate,
  useDraftRecovery,
  useDraftRecoveryNotices,
  type DraftRecovery,
} from "./draft-recovery-context";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});

function Probe({ expose }: { expose: (recovery: DraftRecovery) => void }) {
  const recovery = useDraftRecovery();
  expose(recovery);
  return (
    <>
      <WorkspaceBand onRetry={() => recovery.retry()} />
      <main>{useDraftRecoveryNotices()}</main>
      <p>App content</p>
    </>
  );
}

test("an explicit flush retries a latched write once access returns, without a separate recovery retry", async () => {
  let writable = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "draft_retentions") return [];
    if (command === "draft_cutover_pending") return false;
    if (command === "retain_draft") {
      if (!writable) throw new Error("attempt to write a readonly database");
      const draft = (args as { draft: { revision: number } }).draft;
      return { ...draft, revision: draft.revision + 1 };
    }
    return [];
  });
  let recovery: DraftRecovery | undefined;
  render(
    <DraftRecoveryProvider>
      <Probe expose={(value) => (recovery = value)} />
    </DraftRecoveryProvider>,
  );
  await screen.findByText("App content");
  await act(async () => {
    await recovery?.put("document:1", { body: "x" }, ["x"]).catch(() => {});
  });
  // The workspace band says it once, in plain words; the raw text is in Details.
  const band = await screen.findByText(
    /Unsaved drafts aren't protected right now/,
  );
  expect(band.textContent).not.toContain("readonly database");
  // The failure stays latched for background writes.
  await expect(recovery?.flush()).rejects.toThrow("readonly database");
  writable = true;
  await act(async () => {
    await recovery?.flush();
  });
  await waitFor(() =>
    expect(
      screen.queryByText(/Unsaved drafts aren't protected right now/),
    ).toBeNull(),
  );
});

test("an unwritable workspace at startup shows a styled error state with Retry", async () => {
  let readable = false;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "draft_retentions") {
      if (!readable) throw new Error("Permission denied (os error 13)");
      return [];
    }
    if (command === "draft_cutover_pending") return false;
    return [];
  });
  render(
    <DraftRecoveryProvider>
      <p>App content</p>
    </DraftRecoveryProvider>,
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("ticketd can't open this workspace");
  // The raw cause waits under Details.
  expect(alert.textContent).not.toContain("Permission denied");
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(alert.textContent).toContain("Permission denied");
  expect(screen.queryByText("Loading recoverable drafts…")).toBeNull();
  readable = true;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("App content");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("views mount while recovery loads; editor hosts wait for it, and both startup reads start together", async () => {
  const pending: Record<string, (value: unknown) => void> = {};
  vi.mocked(invoke).mockImplementation(
    (command) =>
      new Promise((resolve) => {
        pending[command] = resolve;
      }),
  );
  render(
    <DraftRecoveryProvider>
      <p>Ticket list</p>
      <DraftRecoveryGate>
        <p>Editor host</p>
      </DraftRecoveryGate>
    </DraftRecoveryProvider>,
  );
  expect(screen.getByText("Ticket list")).toBeTruthy();
  expect(screen.queryByText("Editor host")).toBeNull();
  expect(Object.keys(pending).sort()).toEqual([
    "draft_cutover_pending",
    "draft_retentions",
  ]);
  await act(async () => {
    pending.draft_retentions?.([]);
    pending.draft_cutover_pending?.(false);
  });
  await screen.findByText("Editor host");
});

test("a queued draft write is replaced by a newer one for the same owner", async () => {
  const written: unknown[] = [];
  let release = () => {};
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "draft_retentions") return [];
    if (command === "draft_cutover_pending") return false;
    if (command === "retain_draft") {
      const draft = (args as { draft: { revision: number; payload: unknown } })
        .draft;
      written.push(draft.payload);
      // The first write is slow, so the later ones queue behind it.
      if (written.length === 1)
        await new Promise<void>((resolve) => (release = resolve));
      return { ...draft, revision: draft.revision + 1 };
    }
    return [];
  });
  let recovery: DraftRecovery | undefined;
  render(
    <DraftRecoveryProvider>
      <DraftRecoveryGate>
        <Probe expose={(value) => (recovery = value)} />
      </DraftRecoveryGate>
    </DraftRecoveryProvider>,
  );
  await screen.findByText("App content");
  let settled: Promise<unknown> = Promise.resolve();
  act(() => {
    settled = Promise.all(
      ["a", "ab", "abc", "abcd"].map((body) =>
        recovery?.put("ticket:1", { body }, [body]),
      ),
    );
  });
  await waitFor(() => expect(written).toHaveLength(1));
  await act(async () => {
    release();
    await settled;
  });
  // The first write was running; the queued ones collapse into the newest.
  expect(written).toEqual([{ body: "a" }, { body: "abcd" }]);
  expect(recovery?.read("ticket:1", z.unknown())).toEqual({ body: "abcd" });
});
