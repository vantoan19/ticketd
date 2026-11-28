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
import {
  StatusLineContext,
  useStatusLine,
  type StatusLineMessage,
} from "@/components/ui/use-status-line";
import { StatusLineRegion } from "@/components/ui/status-line";
import { FollowToggle } from "@/features/tickets/Attention";
import { deferred } from "@/lib/workspace-reads/test-support";
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
    setAbove: () => {},
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

test("a Follow shows the value it wrote, and a later outside change replaces it even when re-reads are held or fail", async () => {
  let following = false;
  let hold: Promise<boolean> | null = null;
  let fail = false;
  bridge.invoke.mockImplementation(
    async (
      command: string,
      args?: { reference?: string; following?: boolean },
    ) => {
      if (command === "show_ticket") return ticket(args!.reference!);
      if (command === "is_following") {
        if (fail) throw new Error("database is busy");
        return hold ?? following;
      }
      if (command === "set_following") {
        following = args!.following!;
        return null;
      }
      throw new Error(`Unexpected ${command}`);
    },
  );
  const signal = fakeChangeSignal();
  render(
    <TestReads signal={signal}>
      <FollowToggle reference="T-A" variant="strip" />
    </TestReads>,
  );
  const pressed = () => toggle().getAttribute("aria-pressed");
  await waitFor(() => expect(calls("is_following")).toHaveLength(1));
  fireEvent.click(toggle());
  await waitFor(() => expect(pressed()).toBe("true"));
  await act(async () => {});

  // Unfollowed elsewhere; the change is read.
  following = false;
  await act(async () => signal.change());
  await waitFor(() => expect(pressed()).toBe("false"));

  // Later changes whose re-read is slow, or fails, still say not followed.
  let release: (value: boolean) => void = () => {};
  hold = new Promise<boolean>((resolve) => (release = resolve));
  await act(async () => signal.change());
  expect(pressed()).toBe("false");
  hold = null;
  await act(async () => release(false));
  fail = true;
  await act(async () => signal.change());
  expect(pressed()).toBe("false");
});

test("Follow is pending and fails per Ticket while the toggle stays mounted", async () => {
  const writes: Record<string, (outcome: "ok" | "fail") => void> = {};
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      if (command === "show_ticket") return ticket(args!.reference!);
      if (command === "is_following") return false;
      if (command === "set_following")
        return new Promise((resolve, reject) => {
          writes[args!.reference!] = (outcome) =>
            outcome === "ok"
              ? resolve(null)
              : reject(new Error("disk I/O error"));
        });
      throw new Error(`Unexpected ${command}`);
    },
  );
  const view = (reference: string) => (
    <TestReads>
      <FollowToggle reference={reference} variant="rail" />
    </TestReads>
  );
  const { rerender } = render(view("T-A"));
  await waitFor(() => expect(calls("is_following", "T-A")).toHaveLength(1));
  fireEvent.click(toggle());
  await waitFor(() => expect(calls("set_following", "T-A")).toHaveLength(1));

  // T-B is open now: it can be followed while T-A's write is out.
  rerender(view("T-B"));
  await waitFor(() => expect(calls("is_following", "T-B")).toHaveLength(1));
  await waitFor(() => expect(toggle().hasAttribute("disabled")).toBe(false));
  fireEvent.click(toggle());
  await waitFor(() => expect(calls("set_following", "T-B")).toHaveLength(1));
  expect(toggle().hasAttribute("disabled")).toBe(true);

  // T-A's write finishing does not re-enable T-B's button mid-write.
  await act(async () => writes["T-A"]!("fail"));
  expect(toggle().hasAttribute("disabled")).toBe(true);
  fireEvent.click(toggle());
  expect(calls("set_following", "T-B")).toHaveLength(1);

  // T-B finishing does not wipe T-A's "Not saved".
  await act(async () => writes["T-B"]!("ok"));
  await waitFor(() => expect(toggle().hasAttribute("disabled")).toBe(false));
  rerender(view("T-A"));
  expect(await screen.findByText("Not saved")).toBeTruthy();
  expect(calls("set_following")).toHaveLength(2);
});

test("the rail's Retry after a failed read of Follow reads again and writes nothing", async () => {
  let reads = 0;
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      if (command === "show_ticket") return ticket(args!.reference!);
      if (command === "is_following") {
        reads += 1;
        if (reads === 1) throw new Error("database is busy");
        return true;
      }
      throw new Error(`Unexpected ${command}`);
    },
  );
  render(
    <TestReads>
      <FollowToggle reference="T-A" variant="rail" />
    </TestReads>,
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).not.toContain("Not saved");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(toggle().getAttribute("aria-pressed")).toBe("true"),
  );
  expect(calls("set_following")).toHaveLength(0);
  expect(reads).toBe(2);
});

test("the rail's Retry after a failed change sends the change again", async () => {
  let writes = 0;
  let following = false;
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      if (command === "show_ticket") return ticket(args!.reference!);
      if (command === "is_following") return following;
      if (command === "set_following") {
        writes += 1;
        if (writes === 1) throw new Error("disk I/O error");
        following = true;
        return null;
      }
      throw new Error(`Unexpected ${command}`);
    },
  );
  render(
    <TestReads>
      <FollowToggle reference="T-A" variant="rail" />
    </TestReads>,
  );
  await waitFor(() => expect(calls("is_following")).toHaveLength(1));
  fireEvent.click(toggle());
  expect((await screen.findByRole("alert")).textContent).toContain("Not saved");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(toggle().getAttribute("aria-pressed")).toBe("true"),
  );
  expect(calls("set_following")).toHaveLength(2);
});

test("the status line's Retry stays busy until the re-read answers", async () => {
  const answer = deferred<boolean>();
  let reads = 0;
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      if (command === "show_ticket") return ticket(args!.reference!);
      if (command === "is_following") {
        reads += 1;
        if (reads === 1) throw new Error("database is busy");
        return answer.promise;
      }
      throw new Error(`Unexpected ${command}`);
    },
  );
  render(
    <TestReads>
      <StatusLineRegion>
        <FollowToggle reference="T-A" variant="strip" />
      </StatusLineRegion>
    </TestReads>,
  );
  const line = await screen.findByRole("alert");
  fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.queryByRole("alert")).toBeTruthy();
  expect(
    within(screen.getByRole("alert"))
      .getByRole("button", { name: "Retry" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await act(async () => answer.resolve(true));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
});

test("a status line about one Ticket's failure goes when the header moves to another", async () => {
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      if (command === "show_ticket") return ticket(args!.reference!);
      if (command === "is_following") {
        if (args!.reference === "T-A") throw new Error("database is busy");
        return false;
      }
      throw new Error(`Unexpected ${command}`);
    },
  );
  const view = (reference: string) => (
    <TestReads>
      <StatusLineRegion>
        <FollowToggle reference={reference} variant="strip" />
      </StatusLineRegion>
    </TestReads>
  );
  const { rerender } = render(view("T-A"));
  await screen.findByRole("alert");
  rerender(view("T-B"));
  await waitFor(() => expect(calls("is_following", "T-B")).toHaveLength(1));
  expect(screen.queryByRole("alert")).toBeNull();
});

function OtherOutcome() {
  const line = useStatusLine();
  return (
    <button
      type="button"
      onClick={() => line.show({ message: "Copied ticket link" })}
    >
      Copy ticket link
    </button>
  );
}

test.each([
  { result: "clears its own status line", replaced: false },
  { result: "keeps a newer outcome visible", replaced: true },
])("a successful direct Follow retry $result", async ({ replaced }) => {
  const refresh = deferred<boolean>();
  let reads = 0;
  let writes = 0;
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      if (command === "show_ticket") return ticket(args!.reference!);
      if (command === "is_following")
        return ++reads === 1 ? false : refresh.promise;
      if (command === "set_following") {
        writes += 1;
        if (writes === 1) throw new Error("disk I/O error");
        return null;
      }
      throw new Error(`Unexpected ${command}`);
    },
  );
  render(
    <TestReads>
      <StatusLineRegion>
        <FollowToggle reference="T-A" variant="strip" />
        <OtherOutcome />
      </StatusLineRegion>
    </TestReads>,
  );

  await waitFor(() => expect(calls("is_following")).toHaveLength(1));
  fireEvent.click(toggle());
  expect((await screen.findByRole("alert")).textContent).toContain("T-A");
  if (replaced)
    fireEvent.click(screen.getByRole("button", { name: "Copy ticket link" }));
  fireEvent.click(toggle());

  await waitFor(() =>
    expect(toggle().getAttribute("aria-pressed")).toBe("true"),
  );
  await waitFor(() => expect(reads).toBe(2));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  if (replaced)
    expect(screen.getByRole("status").textContent).toContain(
      "Copied ticket link",
    );
  await act(async () => refresh.resolve(true));
});
