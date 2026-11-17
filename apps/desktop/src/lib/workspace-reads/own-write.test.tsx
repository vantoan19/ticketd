// @vitest-environment jsdom
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { useWorkspaceChange } from "@/lib/workspace-change";
import { read } from "./catalog";
import { fakeChangeSignal } from "./fake-signal";
import { deferred, settle, wrap } from "./test-support";
import { TestReads } from "./testing";
import { useRead } from "./use-read";
import { useReplaced } from "./use-replaced";
import { useWrote } from "./use-wrote";
import { Visibility } from "./Visibility";

const ticket = (title: string) =>
  ({ reference: "T-1", title }) as unknown as Ticket;

// Reads a Ticket's title, and says a returned Ticket fills it.
const titleRead = (
  call: (reference: string) => Promise<string>,
  key = "ticket-title",
) =>
  read({
    key,
    call,
    failure: "load the title",
    seededBy: { ticket: (t) => ({ args: t.reference, value: t.title }) },
  });

function mount(
  spec: ReturnType<typeof titleRead>,
  signal = fakeChangeSignal(),
) {
  return renderHook(
    () => ({
      read: useRead(spec, "T-1"),
      wrote: useWrote(),
      version: useWorkspaceChange(),
    }),
    { wrapper: wrap(signal) },
  );
}

describe("own write", () => {
  it("shows the returned Ticket at once, reads the token before anything is re-read, then re-reads once and moves the shared version", async () => {
    const catchUp = deferred<void>();
    const signal = fakeChangeSignal(() => catchUp.promise);
    const call = vi
      .fn<(reference: string) => Promise<string>>()
      .mockResolvedValueOnce("Before")
      .mockResolvedValue("After");
    const { result } = mount(titleRead(call), signal);
    await waitFor(() => expect(result.current.read.value).toBe("Before"));
    const version = result.current.version;

    let done = false;
    let wrote!: Promise<void>;
    act(() => {
      wrote = result.current.wrote({ ticket: ticket("Seeded") }).then(() => {
        done = true;
      });
    });
    await waitFor(() => expect(result.current.read.value).toBe("Seeded"));
    expect(signal.catchUps).toBe(1);
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.current.version).toBe(version);

    await act(async () => catchUp.resolve());
    await act(async () => wrote);
    expect(done).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.read.value).toBe("After"));
    expect(result.current.version).toBe(version + 1);
  });

  it("drops the late answer of a read sent before the write", async () => {
    const old = deferred<string>();
    const call = vi
      .fn<(reference: string) => Promise<string>>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue("post-write");
    const { result } = mount(titleRead(call));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));

    await act(async () => result.current.wrote());
    old.resolve("pre-write");
    await settle();
    expect(result.current.read.value).toBe("post-write");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("does not let a read sent before the seed overwrite the seeded Ticket", async () => {
    const old = deferred<string>();
    const refetch = deferred<string>();
    const call = vi
      .fn<(reference: string) => Promise<string>>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValue(refetch.promise);
    const { result } = mount(titleRead(call));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));

    act(() => void result.current.wrote({ ticket: ticket("Seeded") }));
    old.resolve("pre-write");
    await settle();
    expect(result.current.read.value).toBe("Seeded");
    refetch.resolve("post-write");
    await waitFor(() => expect(result.current.read.value).toBe("post-write"));
  });

  it("reuses a read sent after the write was reported", async () => {
    const catchUp = deferred<void>();
    const signal = fakeChangeSignal(() => catchUp.promise);
    const answer = deferred<string>();
    const call = vi.fn(() => answer.promise);
    const spec = titleRead(call);
    function Reader() {
      return <output>{useRead(spec, "T-1").value}</output>;
    }
    function Writer({ later }: { later: boolean }) {
      const wrote = useWrote();
      return (
        <>
          <button onClick={() => void wrote()}>write</button>
          {later && <Reader />}
        </>
      );
    }
    const tree = (later: boolean) => (
      <TestReads signal={signal}>
        <Writer later={later} />
      </TestReads>
    );
    const { rerender, getByText, getByRole } = render(tree(false));
    act(() => getByText("write").click());
    rerender(tree(true));
    await settle();
    expect(call).toHaveBeenCalledTimes(1);
    await act(async () => catchUp.resolve());
    await settle();
    expect(call).toHaveBeenCalledTimes(1);
    answer.resolve("value");
    await waitFor(() => expect(getByRole("status").textContent).toBe("value"));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("never rejects, even when the token cannot be read or a re-read fails", async () => {
    const signal = fakeChangeSignal(() =>
      Promise.reject(new Error("no token")),
    );
    const call = vi
      .fn<(reference: string) => Promise<string>>()
      .mockResolvedValueOnce("Before")
      .mockRejectedValue(new Error("locked"));
    const { result } = mount(titleRead(call), signal);
    await waitFor(() => expect(result.current.read.value).toBe("Before"));
    await act(async () => {
      await expect(result.current.wrote()).resolves.toBeUndefined();
    });
    expect(result.current.read.value).toBe("Before");
    expect(result.current.read.failure).not.toBeNull();
  });
});

describe("a replaced Workspace", () => {
  it("drops every cached value, reads what is visible again and makes the next poll count as a change", async () => {
    const signal = fakeChangeSignal();
    const call = vi
      .fn<(reference: string) => Promise<string>>()
      .mockResolvedValueOnce("Before")
      .mockResolvedValue("After");
    const spec = titleRead(call, "replaced-visible");
    const { result } = renderHook(
      () => ({
        read: useRead(spec, "T-1"),
        replaced: useReplaced(),
        version: useWorkspaceChange(),
      }),
      { wrapper: wrap(signal) },
    );
    await waitFor(() => expect(result.current.read.value).toBe("Before"));
    const version = result.current.version;

    await act(async () => result.current.replaced());
    await waitFor(() => expect(result.current.read.value).toBe("After"));
    expect(signal.forgets).toBe(1);
    expect(result.current.version).toBe(version + 1);
  });

  it("does not show a hidden read's old value when it is shown again", async () => {
    const signal = fakeChangeSignal();
    const call = vi
      .fn<(reference: string) => Promise<string>>()
      .mockResolvedValueOnce("Before")
      .mockResolvedValue("After");
    const spec = titleRead(call, "replaced-hidden");
    const seen: (string | undefined)[] = [];
    function Reader() {
      const value = useRead(spec, "T-1").value;
      seen.push(value);
      return <output>{value}</output>;
    }
    function Replace() {
      const replaced = useReplaced();
      return <button onClick={() => void replaced()}>replace</button>;
    }
    const tree = (hidden: boolean) => (
      <TestReads signal={signal}>
        <Replace />
        <Visibility hidden={hidden}>
          <Reader />
        </Visibility>
      </TestReads>
    );
    const { rerender, getByText, findByText } = render(tree(false));
    await findByText("Before");
    rerender(tree(true));
    await act(async () => getByText("replace").click());
    seen.length = 0;
    rerender(tree(false));
    await findByText("After");
    expect(seen).not.toContain("Before");
  });
});
