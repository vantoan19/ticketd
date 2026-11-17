// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { deferred } from "@/lib/workspace-reads/test-support";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";
import { useTicketCommands } from "./use-ticket-commands";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  bridge.invoke.mockReset();
  expect(unknownCommands.splice(0)).toEqual([]);
});

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

// What the core holds and the status the next read answers.
let stored: Ticket;
beforeEach(() => {
  stored = ticket("Todo");
  bridge.invoke.mockImplementation(
    async (command: string, args?: { patch?: { status: string } }) => {
      if (command === "show_ticket") return stored;
      if (command === "change_ticket") {
        stored = { ...stored, status: args?.patch?.status ?? stored.status };
        return stored;
      }
      return bridgeDefault(command);
    },
  );
});

function mount(initialTicket: Ticket | null) {
  const close = vi.fn();
  const refresh = vi.fn(async () => {});
  const hook = renderHook(
    (props: { open: boolean; initialTicket: Ticket | null }) =>
      useTicketCommands({
        reference: "T-KQ1",
        scope: "Status",
        query: "",
        projects: [],
        plans: [],
        close,
        refresh,
        ...props,
      }),
    { initialProps: { open: true, initialTicket } },
  );
  return { hook, close, refresh };
}

test("Mark as duplicate keeps its Ticket after the palette closes, though nothing else holds it", async () => {
  // The palette's cached copy answers, but its own read has not.
  const read = deferred<Ticket>();
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "show_ticket" ? read.promise : bridgeDefault(command),
  );
  const { hook, close } = mount(ticket("Todo"));
  await act(() => hook.result.current.apply("Duplicate"));
  expect(close).toHaveBeenCalled();
  // Closing drops the palette's Ticket; the list does not hold it either.
  hook.rerender({ open: false, initialTicket: null });
  expect(hook.result.current.duplicate).toBe(true);
  expect(hook.result.current.ticket?.reference).toBe("T-KQ1");
});

test("choosing the status a stale copy shows still writes when the Ticket has moved on", async () => {
  // A CLI change moved the Ticket after the cached copy was read.
  stored = ticket("In progress");
  const { hook, close, refresh } = mount(ticket("Todo"));
  await act(() => hook.result.current.apply("Todo"));
  expect(bridge.invoke).toHaveBeenCalledWith(
    "change_ticket",
    expect.objectContaining({ patch: { status: "Todo" } }),
  );
  expect(close).toHaveBeenCalled();
  // The write is reported with the Ticket it returned.
  expect(refresh).toHaveBeenCalledWith(
    expect.objectContaining({ status: "Todo" }),
  );
});

test("choosing the status the Ticket really has closes without writing", async () => {
  const { hook, close, refresh } = mount(ticket("Todo"));
  await act(() => hook.result.current.apply("Todo"));
  expect(bridge.invoke).not.toHaveBeenCalledWith(
    "change_ticket",
    expect.anything(),
  );
  expect(refresh).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});
