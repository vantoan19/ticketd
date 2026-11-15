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
import { DraftRecoveryProvider } from "./draft-recovery";
import { WorkspaceBand } from "@/app/WorkspaceBand";
import {
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
