// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import type { Ticket } from "@/lib/api/client";
import type { StatusLineMessage } from "@/components/ui/use-status-line";
import { useInboxAction } from "./use-inbox-action";

const ticket = { id: "1", reference: "T-KQ1" } as Ticket;

/** Performs an action, then runs the Undo its status line offers. */
async function performThenUndo(followUp: () => Promise<void>) {
  const shown: StatusLineMessage[] = [];
  const line = {
    show: (message: StatusLineMessage) => void shown.push(message),
    dismiss: () => {},
  };
  const order: string[] = [];
  const reload = async (returned?: Ticket) => {
    order.push(
      returned ? "reported the restored Ticket" : "reported the action",
    );
  };
  const { result } = renderHook(() => useInboxAction(reload, line));
  await act(() =>
    result.current.perform(
      "Moved T-KQ1 to Done",
      async () => undefined,
      async () => ticket,
      "save the Inbox action",
      {
        action: "show it under Needs you again",
        run: async () => {
          order.push("followed the Undo");
          await followUp();
        },
      },
    ),
  );
  const undo = shown.at(-1)?.undo;
  expect(undo).toBeTypeOf("function");
  shown.length = 0;
  // The status line shows its own failure when the Undo rejects, so a rejection here fails the test.
  await act(async () => {
    await undo?.();
  });
  return { order, shown };
}

test("an Undo is reported as soon as it is written, before what follows it", async () => {
  const { order, shown } = await performThenUndo(async () => {});
  expect(order).toEqual([
    "reported the action",
    "reported the restored Ticket",
    "followed the Undo",
  ]);
  expect(shown).toEqual([]);
});

test("what follows an Undo failing is its own failure, not the Undo failing", async () => {
  const { order, shown } = await performThenUndo(async () => {
    throw new Error("disk is full");
  });
  expect(order).toContain("reported the restored Ticket");
  expect(shown).toHaveLength(1);
  expect(shown[0]?.tone).toBe("error");
  expect(shown[0]?.message).toContain("Couldn't show it under Needs you again");
  expect(shown[0]?.message.toLowerCase()).not.toContain("undo");
});
