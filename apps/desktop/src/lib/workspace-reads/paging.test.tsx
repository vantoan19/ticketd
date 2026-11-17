// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { byOffset, pagedRead } from "./catalog";
import { fakeChangeSignal } from "./fake-signal";
import { deferred, settle, wrap } from "./test-support";
import { usePagedRead } from "./use-paged-read";

type Page = { items: string[]; next: number | null };

/** Three pages of two items, built from `generation` so a re-read is visible. */
function pages(generation: { n: number }) {
  return vi.fn(async (_args: null, offset: number): Promise<Page> => {
    const items = [
      `g${generation.n}-${offset}`,
      `g${generation.n}-${offset + 1}`,
    ];
    return { items, next: offset + 2 < 6 ? offset + 2 : null };
  });
}

const list = (call: ReturnType<typeof pages>, key = "list") =>
  pagedRead({
    key,
    call,
    next: (page: Page) => page.next,
    join: (all: readonly Page[]) => all.flatMap((page) => page.items),
    failure: "load the list",
    more: "load more of the list",
  });

describe("paging", () => {
  it("reads one more page on showMore and ignores it while one is loading", async () => {
    const generation = { n: 1 };
    const second = deferred<Page>();
    const call = pages(generation);
    call.mockImplementationOnce(async () => ({ items: ["a", "b"], next: 2 }));
    call.mockImplementationOnce(() => second.promise);
    const spec = list(call);
    const { result } = renderHook(() => usePagedRead(spec, null), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.value).toEqual(["a", "b"]));
    expect(result.current.more).toBe(true);

    act(() => result.current.showMore());
    act(() => result.current.showMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(true));
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenLastCalledWith(null, 2);

    await act(async () => second.resolve({ items: ["c", "d"], next: 4 }));
    await waitFor(() =>
      expect(result.current.value).toEqual(["a", "b", "c", "d"]),
    );
    expect(result.current.loadingMore).toBe(false);
  });

  it("re-reads every loaded page in order on a change and keeps them all", async () => {
    const signal = fakeChangeSignal();
    const generation = { n: 1 };
    const call = pages(generation);
    const spec = list(call);
    const { result } = renderHook(() => usePagedRead(spec, null), {
      wrapper: wrap(signal),
    });
    await waitFor(() => expect(result.current.value).toHaveLength(2));
    act(() => result.current.showMore());
    await waitFor(() => expect(result.current.value).toHaveLength(4));
    call.mockClear();

    generation.n = 2;
    act(() => signal.change());
    await waitFor(() =>
      expect(result.current.value).toEqual(["g2-0", "g2-1", "g2-2", "g2-3"]),
    );
    expect(call.mock.calls.map(([, offset]) => offset)).toEqual([0, 2]);
    expect(result.current.more).toBe(true);
  });

  it("reads every loaded page again on Retry", async () => {
    const generation = { n: 1 };
    const call = pages(generation);
    const spec = list(call);
    const { result } = renderHook(() => usePagedRead(spec, null), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.value).toHaveLength(2));
    act(() => result.current.showMore());
    await waitFor(() => expect(result.current.value).toHaveLength(4));
    call.mockClear();

    generation.n = 2;
    act(() => {
      void result.current.retry();
    });
    await waitFor(() => expect(result.current.value?.[0]).toBe("g2-0"));
    expect(result.current.value).toHaveLength(4);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed first page's failure while Retry runs, until a read succeeds", async () => {
    const retried = deferred<Page>();
    const call = pages({ n: 1 });
    call
      .mockRejectedValueOnce(new Error("locked"))
      .mockReturnValueOnce(retried.promise);
    const spec = list(call);
    const seen: string[] = [];
    const { result } = renderHook(
      () => {
        const state = usePagedRead(spec, null);
        seen.push(`${state.status}:${state.failure?.title ?? "-"}`);
        return state;
      },
      { wrapper: wrap() },
    );
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.failure?.title).toBe("Couldn't load the list");

    act(() => {
      void result.current.retry();
    });
    await settle();
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("failed");
    expect(result.current.failure?.title).toBe("Couldn't load the list");
    const failed = seen.indexOf("failed:Couldn't load the list");
    expect(seen.slice(failed)).not.toContain("loading:-");

    await act(async () => retried.resolve({ items: ["a"], next: null }));
    await waitFor(() => expect(result.current.value).toEqual(["a"]));
    expect(result.current.failure).toBeNull();
    expect(result.current.status).toBe("ready");
  });

  it("re-reads the extra page too when a change arrives while Show more is loading", async () => {
    const signal = fakeChangeSignal();
    const generation = { n: 1 };
    const call = pages(generation);
    const spec = list(call);
    const { result } = renderHook(() => usePagedRead(spec, null), {
      wrapper: wrap(signal),
    });
    await waitFor(() => expect(result.current.value).toHaveLength(2));

    const stale = deferred<Page>();
    call.mockImplementationOnce(() => stale.promise);
    act(() => result.current.showMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(true));
    call.mockClear();

    generation.n = 2;
    act(() => signal.change());
    // The call sent before the change answers late, with old data.
    await act(async () =>
      stale.resolve({ items: ["old-a", "old-b"], next: 4 }),
    );
    await waitFor(() =>
      expect(result.current.value).toEqual(["g2-0", "g2-1", "g2-2", "g2-3"]),
    );
    expect(result.current.value).not.toContain("old-a");
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.more).toBe(true);
  });

  it("keeps the pages and words the failure as 'more' when Show more fails", async () => {
    const call = pages({ n: 1 });
    call
      .mockImplementationOnce(async () => ({ items: ["a"], next: 1 }))
      .mockRejectedValueOnce(new Error("locked"));
    const spec = list(call);
    const { result } = renderHook(() => usePagedRead(spec, null), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.value).toEqual(["a"]));
    act(() => result.current.showMore());
    await waitFor(() => expect(result.current.failure).not.toBeNull());
    expect(result.current.failure?.title).toBe(
      "Couldn't load more of the list",
    );
    expect(result.current.value).toEqual(["a"]);
    expect(result.current.failedMore).toBe(true);
    expect(result.current.loadingMore).toBe(false);
    await settle();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("says a failed re-read is not a failed Show more", async () => {
    const signal = fakeChangeSignal();
    const call = pages({ n: 1 });
    const spec = list(call);
    const { result } = renderHook(() => usePagedRead(spec, null), {
      wrapper: wrap(signal),
    });
    await waitFor(() => expect(result.current.value).toHaveLength(2));
    expect(result.current.failedMore).toBe(false);

    call.mockRejectedValueOnce(new Error("locked"));
    act(() => signal.change());
    await waitFor(() => expect(result.current.failure).not.toBeNull());
    expect(result.current.failedMore).toBe(false);
  });

  it("pages by offset: a full page means another, a shorter one is the last", async () => {
    const call = vi.fn(async (_args: null, offset: number) =>
      offset === 0 ? ["a", "b"] : offset === 2 ? ["c", "d"] : ["e"],
    );
    const spec = pagedRead({
      key: "by-offset",
      call,
      next: byOffset<string>(2),
      join: (all: readonly string[][]) => all.flat(),
      failure: "load",
      more: "load more",
    });
    const { result } = renderHook(() => usePagedRead(spec, null), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.value).toEqual(["a", "b"]));
    act(() => result.current.showMore());
    await waitFor(() => expect(result.current.value).toHaveLength(4));
    expect(call).toHaveBeenLastCalledWith(null, 2);
    act(() => result.current.showMore());
    await waitFor(() => expect(result.current.value).toHaveLength(5));
    expect(call).toHaveBeenLastCalledWith(null, 4);
    expect(result.current.more).toBe(false);
  });
});
