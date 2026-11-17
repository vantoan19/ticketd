// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { useBoardStatus } from "./useBoardStatus";
import type { useTicketBoard } from "./useTicketBoard";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => bridge.invoke.mockReset());

const ticket = (status: string): Ticket => ({
  id: "1",
  reference: "T-KQ1",
  title: "One",
  body: "",
  status,
  trashed: false,
  tags: [],
  project_id: null,
  plan_id: null,
  availability: null,
  parent: null,
  children: [],
  prerequisites: [],
});

// What the core holds, and how its write answers.
let stored: Ticket;
let writeFails: boolean;
// A write whose reply is lost: the core commits it, the desktop sees a failure.
let replyLost: boolean;
beforeEach(() => {
  stored = ticket("Todo");
  writeFails = false;
  replyLost = false;
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "show_ticket") return stored;
    if (command === "change_ticket") {
      if (writeFails) throw { code: "failed", message: "disk I/O error" };
      stored = ticket("In progress");
      if (replyLost) throw { code: "unavailable", message: "lost reply" };
      return stored;
    }
    throw new Error(`Unexpected ${command}`);
  });
});

function mount() {
  const board = {
    key: "board",
    placeTicket: vi.fn(() => ({ status: "Todo", index: 0 })),
    confirmTicket: vi.fn(),
    matches: vi.fn(async () => true),
  } as unknown as ReturnType<typeof useTicketBoard>;
  const workspace = {
    board,
    refresh: vi.fn(async () => {}),
    patchTicket: vi.fn(),
    changed: vi.fn(async () => {}),
  };
  const hook = renderHook(() => useBoardStatus(workspace));
  return { hook, workspace };
}

test("a confirmed move is reported once with the confirmed Ticket and does not reload the list itself", async () => {
  const { hook, workspace } = mount();
  await act(async () =>
    hook.result.current.choose(ticket("Todo"), "In progress"),
  );
  await waitFor(() => expect(workspace.changed).toHaveBeenCalledTimes(1));
  expect(workspace.changed).toHaveBeenCalledWith(
    expect.objectContaining({ status: "In progress" }),
  );
  // `changed` already moves the shared version, which reloads the list.
  expect(workspace.refresh).not.toHaveBeenCalled();
});

test("a failed move does not report a write", async () => {
  writeFails = true;
  const { hook, workspace } = mount();
  await act(async () =>
    hook.result.current.choose(ticket("Todo"), "In progress"),
  );
  await waitFor(() =>
    expect(hook.result.current.failures["T-KQ1"]).toBeTruthy(),
  );
  expect(workspace.changed).not.toHaveBeenCalled();
});

test("a move to the status the Ticket already has does not report a write", async () => {
  stored = ticket("In progress");
  const { hook, workspace } = mount();
  await act(async () =>
    hook.result.current.choose(ticket("Todo"), "In progress"),
  );
  await waitFor(() => expect(hook.result.current.notice).toContain("T-KQ1"));
  expect(workspace.changed).not.toHaveBeenCalled();
});

test("a failed move that the confirming read shows was committed is reported", async () => {
  replyLost = true;
  const { hook, workspace } = mount();
  await act(async () =>
    hook.result.current.choose(ticket("Todo"), "In progress"),
  );
  await waitFor(() =>
    expect(hook.result.current.failures["T-KQ1"]).toBeTruthy(),
  );
  // The open Ticket's page shows the move at once, and `changed` reloads the list.
  expect(workspace.changed).toHaveBeenCalledTimes(1);
  expect(workspace.changed).toHaveBeenCalledWith(
    expect.objectContaining({ status: "In progress" }),
  );
  expect(workspace.refresh).not.toHaveBeenCalled();
});

test("a review's failed write is reported only when the read shows it landed", async () => {
  const { hook, workspace } = mount();
  await act(async () =>
    hook.result.current.choose(ticket("Todo"), "Duplicate"),
  );
  expect(hook.result.current.review?.status).toBe("Duplicate");
  await act(() => hook.result.current.reconcileDuplicate());
  // Nothing changed: shown, not reported.
  expect(workspace.changed).not.toHaveBeenCalled();
  expect(workspace.patchTicket).toHaveBeenCalled();
  stored = ticket("Duplicate");
  await act(() => hook.result.current.reconcileDuplicate());
  expect(workspace.changed).toHaveBeenCalledTimes(1);
  expect(workspace.changed).toHaveBeenCalledWith(
    expect.objectContaining({ status: "Duplicate" }),
  );
});
