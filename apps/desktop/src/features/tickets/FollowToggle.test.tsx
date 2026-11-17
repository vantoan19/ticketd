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
import {
  StatusLineContext,
  type StatusLineMessage,
} from "@/components/ui/use-status-line";
import { FollowToggle } from "@/features/tickets/Attention";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import { TestReads } from "@/lib/workspace-reads/testing";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

const ticket = (reference: string) => ({
  id: reference,
  reference,
  title: reference,
  status: "Todo",
  trashed: false,
  body: "",
  project_id: null,
  plan_id: null,
  availability: null,
  tags: [],
  parent: null,
  children: [],
  prerequisites: [],
});
const calls = (command: string, reference?: string) =>
  bridge.invoke.mock.calls.filter(
    ([name, args]) =>
      name === command &&
      (reference === undefined ||
        (args as { reference?: string }).reference === reference),
  );
const toggle = () => screen.getByRole("button", { name: "Follow" });

test("a Follow that was saved shows as followed even when it could not be read back", async () => {
  let reads = 0;
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      if (command === "show_ticket") return ticket(args!.reference!);
      if (command === "is_following") {
        reads += 1;
        if (reads > 1) throw new Error("database is busy");
        return false;
      }
      if (command === "set_following") return null;
      throw new Error(`Unexpected ${command}`);
    },
  );
  render(
    <TestReads>
      <FollowToggle reference="T-A" variant="strip" />
    </TestReads>,
  );
  await waitFor(() => expect(reads).toBe(1));
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(toggle());
  await waitFor(() => expect(reads).toBe(2));
  await waitFor(() =>
    expect(toggle().getAttribute("aria-pressed")).toBe("true"),
  );
  // Pressing again unfollows: it is not the same value sent twice.
  fireEvent.click(toggle());
  await waitFor(() =>
    expect(calls("set_following")[1]?.[1]).toMatchObject({ following: false }),
  );
});

test("a failed Follow on one Ticket does not hide or replace what another Ticket shows", async () => {
  let failsToRead = false;
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      if (command === "show_ticket") return ticket(args!.reference!);
      if (command === "is_following") {
        if (args!.reference === "T-B" && failsToRead)
          throw new Error("database is busy");
        return false;
      }
      if (command === "set_following") throw new Error("disk I/O error");
      throw new Error(`Unexpected ${command}`);
    },
  );
  const shown: StatusLineMessage[] = [];
  const line = {
    show: (message: StatusLineMessage) => void shown.push(message),
    dismiss: () => {},
    setInset: () => {},
  };
  const signal = fakeChangeSignal();
  const view = (reference: string) => (
    <StatusLineContext value={line}>
      <TestReads signal={signal}>
        <FollowToggle reference={reference} variant="strip" />
      </TestReads>
    </StatusLineContext>
  );
  const { rerender } = render(view("T-A"));
  await waitFor(() => expect(calls("is_following", "T-A")).toHaveLength(1));
  fireEvent.click(toggle());
  await waitFor(() => expect(shown).toHaveLength(1));
  expect(shown[0]?.message).toContain("T-A");

  // The next Ticket reads fine: T-A's failed Follow is not shown on it.
  rerender(view("T-B"));
  await waitFor(() => expect(calls("is_following", "T-B")).toHaveLength(1));
  await act(async () => {});
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(shown).toHaveLength(1);

  // Its own failure to read Follow is shown, not masked by T-A's.
  failsToRead = true;
  await act(async () => signal.change());
  await waitFor(() => expect(calls("is_following", "T-B")).toHaveLength(2));
  await waitFor(() =>
    expect(shown.some((message) => /check Follow/i.test(message.message))).toBe(
      true,
    ),
  );
});
