// @vitest-environment jsdom
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { read, skip } from "./catalog";
import { fakeChangeSignal } from "./fake-signal";
import { TestReads } from "./testing";
import { useRead } from "./use-read";
import { Visibility } from "./Visibility";

/** A call a test resolves by hand, in the order it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const wrap =
  (signal = fakeChangeSignal()) =>
  ({ children }: { children: ReactNode }) => (
    <TestReads signal={signal}>{children}</TestReads>
  );

describe("sharing", () => {
  it("serves any number of views of one read and arguments with one call", async () => {
    const call = vi.fn(async (id: string) => `value of ${id}`);
    const title = read({ key: "title", call, failure: "load the title" });
    function Both() {
      const first = useRead(title, "a");
      const second = useRead(title, "a");
      const other = useRead(title, "b");
      return [first.value, second.value, other.value];
    }
    const { result } = renderHook(() => Both(), { wrapper: wrap() });
    await waitFor(() =>
      expect(result.current).toEqual([
        "value of a",
        "value of a",
        "value of b",
      ]),
    );
    expect(call.mock.calls).toEqual([["a"], ["b"]]);
  });
});

describe("errors", () => {
  it("throws a clear error when a hook is used outside WorkspaceReads", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const title = read({
      key: "outside",
      call: async () => "x",
      failure: "load",
    });
    expect(() => render(<Probe />)).toThrow(/WorkspaceReads/);
    quiet.mockRestore();
    function Probe() {
      useRead(title, null);
      return null;
    }
  });
});

/** Lets pending promise callbacks and query notifications run. */
const settle = () => act(async () => {});

describe("freshness", () => {
  it("re-reads after a change and at no other time", async () => {
    const signal = fakeChangeSignal();
    let n = 0;
    const call = vi.fn(async () => ++n);
    const counter = read({ key: "counter", call, failure: "load" });
    function Counter() {
      return <output>{useRead(counter, null).value}</output>;
    }
    const tree = (second: boolean) => (
      <TestReads signal={signal}>
        <Counter />
        {second && <Counter />}
      </TestReads>
    );
    const { rerender, getAllByRole } = render(tree(false));
    await waitFor(() =>
      expect(getAllByRole("status")[0]?.textContent).toBe("1"),
    );

    // Focus, reconnect, a second view mounting: none of these is a reason to read.
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    rerender(tree(true));
    await settle();
    expect(call).toHaveBeenCalledTimes(1);
    expect(getAllByRole("status")).toHaveLength(2);

    act(() => signal.change());
    await waitFor(() =>
      expect(getAllByRole("status")[1]?.textContent).toBe("2"),
    );
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("waits while the arguments are skipped", async () => {
    const call = vi.fn(async (id: string) => id);
    const item = read({ key: "item", call, failure: "load" });
    const { result, rerender } = renderHook(
      ({ id }: { id: string | typeof skip }) => useRead(item, id),
      { wrapper: wrap(), initialProps: { id: skip as string | typeof skip } },
    );
    await settle();
    expect(call).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
    rerender({ id: "a" });
    await waitFor(() => expect(result.current.value).toBe("a"));
  });
});

describe("visibility", () => {
  it("makes no calls while hidden, keeps the cached value and catches up once when shown", async () => {
    const signal = fakeChangeSignal();
    let n = 0;
    const call = vi.fn(async () => ++n);
    const counter = read({ key: "hidden", call, failure: "load" });
    let hiddenNow = false;
    const { result, rerender } = renderHook(() => useRead(counter, null), {
      wrapper: ({ children }) => (
        <TestReads signal={signal}>
          <Visibility hidden={hiddenNow}>{children}</Visibility>
        </TestReads>
      ),
    });
    await waitFor(() => expect(result.current.value).toBe(1));

    hiddenNow = true;
    rerender();
    act(() => signal.change());
    act(() => signal.change());
    await settle();
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.current.value).toBe(1);

    hiddenNow = false;
    rerender();
    await waitFor(() => expect(result.current.value).toBe(2));
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("treats a minimized window as hidden and an unfocused one as visible", async () => {
    const signal = fakeChangeSignal();
    const call = vi.fn(async () => "x");
    const spec = read({ key: "minimized", call, failure: "load" });
    const { result } = renderHook(() => useRead(spec, null), {
      wrapper: wrap(signal),
    });
    await waitFor(() => expect(result.current.value).toBe("x"));

    const state = vi.spyOn(document, "visibilityState", "get");
    state.mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    act(() => signal.change());
    await settle();
    expect(call).toHaveBeenCalledTimes(1);

    state.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));

    window.dispatchEvent(new Event("blur"));
    act(() => signal.change());
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    state.mockRestore();
  });
});

describe("failure", () => {
  it("gives a failure and no value for a failed first read, and reads again only on Retry", async () => {
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("disk is busy"))
      .mockResolvedValue("ok");
    const spec = read({
      key: "first-failure",
      call,
      failure: "load the title",
    });
    const { result } = renderHook(() => useRead(spec, null), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.value).toBeUndefined();
    expect(result.current.failure?.title).toBe("Couldn't load the title");
    expect(result.current.failure?.details).toContain("disk is busy");

    await settle();
    expect(call).toHaveBeenCalledTimes(1);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.value).toBe("ok"));
    expect(result.current.failure).toBeNull();
  });

  it("keeps the last value and the failure through a failed re-read and the next attempt", async () => {
    const signal = fakeChangeSignal();
    const retried = deferred<string>();
    const call = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("good")
      .mockRejectedValueOnce(new Error("locked"))
      .mockReturnValueOnce(retried.promise);
    const spec = read({
      key: "refetch-failure",
      call,
      failure: "load the title",
    });
    const seen: (string | null)[] = [];
    const { result } = renderHook(
      () => {
        const state = useRead(spec, null);
        seen.push(state.failure?.title ?? null);
        return state;
      },
      { wrapper: wrap(signal) },
    );
    await waitFor(() => expect(result.current.value).toBe("good"));

    act(() => signal.change());
    await waitFor(() => expect(result.current.failure).not.toBeNull());
    expect(result.current.value).toBe("good");
    expect(call).toHaveBeenCalledTimes(2);

    act(() => result.current.retry());
    await settle();
    expect(call).toHaveBeenCalledTimes(3);
    // Mid-attempt the failure is still there; it goes only when a read succeeds.
    expect(result.current.failure).not.toBeNull();
    expect(result.current.value).toBe("good");

    await act(async () => retried.resolve("better"));
    await waitFor(() => expect(result.current.value).toBe("better"));
    expect(result.current.failure).toBeNull();
    const failed = seen.indexOf("Couldn't load the title");
    expect(seen.slice(failed, -1).every((title) => title !== null)).toBe(true);
  });
});

describe("no needless renders", () => {
  it("keeps the same value and does not re-render when a re-read returns equal data", async () => {
    const signal = fakeChangeSignal();
    const call = vi.fn(async () => ({ title: "Same", labels: ["a", "b"] }));
    const spec = read({ key: "equal", call, failure: "load" });
    const values: unknown[] = [];
    let renders = 0;
    renderHook(
      () => {
        renders += 1;
        const state = useRead(spec, null);
        values.push(state.value);
        return state;
      },
      { wrapper: wrap(signal) },
    );
    await waitFor(() => expect(values.at(-1)).toBeDefined());
    const rendersAfterFirst = renders;
    const first = values.at(-1);

    act(() => signal.change());
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    await settle();
    expect(renders).toBe(rendersAfterFirst);
    expect(values.at(-1)).toBe(first);
  });
});
