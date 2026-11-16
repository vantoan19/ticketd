// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { pagedRead } from "./catalog";
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
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.value?.[0]).toBe("g2-0"));
    expect(result.current.value).toHaveLength(4);
    expect(call).toHaveBeenCalledTimes(2);
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
    expect(result.current.loadingMore).toBe(false);
    await settle();
    expect(call).toHaveBeenCalledTimes(2);
  });
});
