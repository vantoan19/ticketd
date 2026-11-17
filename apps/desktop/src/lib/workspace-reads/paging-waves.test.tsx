// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { pagedRead } from "./catalog";
import { fakeChangeSignal } from "./fake-signal";
import { deferred, settle, wrap } from "./test-support";
import { TestReads } from "./testing";
import { usePagedRead } from "./use-paged-read";
import { useWrote } from "./use-wrote";
import { Visibility } from "./Visibility";

type Page = { items: string[]; next: number | null };

/**
 * A list of ten items, two a page, whose calls a test answers by hand and in
 * the order it chooses. An answer is made from the generation at the time of
 * the call, so a page read before a change is told apart from one read after.
 * `failing` makes the next calls at that offset fail instead of answer.
 */
function slowList(key: string) {
  const generation = { n: 1 };
  const failing = new Set<number>();
  const calls: { offset: number; gen: number; answer: () => void }[] = [];
  const spec = pagedRead({
    key,
    call: (_args: string, offset: number) => {
      const gen = generation.n;
      const fails = failing.has(offset);
      const held = deferred<Page>();
      calls.push({
        offset,
        gen,
        answer: () =>
          fails
            ? held.reject(new Error("database is locked"))
            : held.resolve({
                items: [`g${gen}-${offset}`, `g${gen}-${offset + 1}`],
                next: offset + 2 < 10 ? offset + 2 : null,
              }),
      });
      return held.promise;
    },
    next: (page: Page) => page.next,
    join: (all: readonly Page[]) => all.flatMap((page) => page.items),
    failure: "load the list",
    more: "load more of the list",
  });
  /** Answers every call made so far, and those that answering causes. */
  const flush = async () => {
    let answered = 0;
    for (let round = 0; round < 20; round += 1) {
      await settle();
      const next = calls.slice(answered);
      if (next.length === 0) return;
      answered = calls.length;
      await act(async () => next.forEach((call) => call.answer()));
    }
  };
  /** The offsets read so far, in order. */
  const offsets = () => calls.map((call) => call.offset);
  return { generation, failing, spec, flush, offsets };
}

describe("a page the person asked for", () => {
  it("is read after a change's re-read, not lost when pressed during it", async () => {
    const signal = fakeChangeSignal();
    const list = slowList("press-during-reread");
    const { result } = renderHook(() => usePagedRead(list.spec, "T-1"), {
      wrapper: wrap(signal),
    });
    await list.flush();
    expect(result.current.value).toEqual(["g1-0", "g1-1"]);

    list.generation.n = 2;
    act(() => signal.change());
    await settle();
    expect(list.offsets()).toEqual([0, 0]);
    // The re-read is in the background: the pager is enabled, with no spinner.
    expect(result.current.loadingMore).toBe(false);
    act(() => result.current.showMore());
    await list.flush();

    expect(list.offsets()).toEqual([0, 0, 2]);
    expect(result.current.value).toEqual(["g2-0", "g2-1", "g2-2", "g2-3"]);
    expect(result.current.current).toBe(true);
  });

  it("is read after the last re-read when two changes arrive inside one wave", async () => {
    const signal = fakeChangeSignal();
    const list = slowList("two-changes");
    const { result } = renderHook(() => usePagedRead(list.spec, "T-1"), {
      wrapper: wrap(signal),
    });
    await list.flush();
    act(() => result.current.showMore());
    await settle();
    expect(result.current.loadingMore).toBe(true);

    list.generation.n = 2;
    act(() => signal.change()); // drops the page in flight, re-reads page 0
    await settle();
    list.generation.n = 3;
    act(() => signal.change()); // drops that re-read too
    await list.flush();

    expect(result.current.value).toEqual(["g3-0", "g3-1", "g3-2", "g3-3"]);
    expect(result.current.current).toBe(true);
  });

  it("is read when its view was hidden while it was loading and a change dropped it", async () => {
    const signal = fakeChangeSignal();
    const list = slowList("hidden-while-loading");
    let setHidden!: (hidden: boolean) => void;
    let state!: ReturnType<typeof usePagedRead<string, string[], Page>>;
    function Section() {
      state = usePagedRead(list.spec, "T-1");
      return null;
    }
    function Host({ children }: { children: ReactNode }) {
      const [hidden, set] = useState(false);
      setHidden = set;
      return <Visibility hidden={hidden}>{children}</Visibility>;
    }
    render(
      <TestReads signal={signal}>
        <Host>
          <Section />
        </Host>
      </TestReads>,
    );
    await list.flush();
    act(() => state.showMore());
    await settle();
    act(() => setHidden(true));
    list.generation.n = 2;
    act(() => signal.change());
    await list.flush();
    expect(list.offsets()).toEqual([0, 2]); // a hidden read makes no calls

    act(() => setHidden(false));
    await list.flush();
    expect(state.value).toEqual(["g2-0", "g2-1", "g2-2", "g2-3"]);
    expect(state.current).toBe(true);
  });
});

describe("pages read after a change or an own write", () => {
  it("never mix a page read before a change into the pages read after it", async () => {
    const hold = deferred<void>();
    const signal = fakeChangeSignal(() => hold.promise);
    const list = slowList("mixed-generations");
    const { result } = renderHook(
      () => ({ read: usePagedRead(list.spec, "T-1"), wrote: useWrote() }),
      { wrapper: wrap(signal) },
    );
    await list.flush();
    act(() => result.current.read.showMore()); // page 1 is in flight
    await settle();

    list.generation.n = 2;
    act(() => signal.change()); // drops it and re-reads page 0
    await settle();
    list.generation.n = 3;
    act(() => void result.current.wrote()); // drops that re-read too
    await settle(); // the write's token read is still out
    await act(async () => hold.resolve());
    await list.flush();

    expect(result.current.read.value).toEqual(["g3-0", "g3-1", "g3-2", "g3-3"]);
    expect(result.current.read.current).toBe(true);
  });

  it("makes Show more re-read the pages first when a change's re-read failed", async () => {
    const signal = fakeChangeSignal();
    const list = slowList("failed-reread");
    const { result } = renderHook(() => usePagedRead(list.spec, "T-1"), {
      wrapper: wrap(signal),
    });
    await list.flush();

    list.generation.n = 2;
    list.failing.add(0);
    act(() => signal.change());
    await list.flush();
    expect(result.current.failure?.title).toBe("Couldn't load the list");
    expect(result.current.value).toEqual(["g1-0", "g1-1"]);
    expect(result.current.current).toBe(false);

    list.failing.clear();
    act(() => result.current.showMore());
    await list.flush();

    // Page 1 alone would have made the stale page 0 look current.
    expect(result.current.value).toEqual(["g2-0", "g2-1", "g2-2", "g2-3"]);
    expect(result.current.failure).toBeNull();
    expect(result.current.current).toBe(true);
  });

  it("keeps a failed re-read's failure when Show more is pressed and the re-read fails again", async () => {
    const signal = fakeChangeSignal();
    const list = slowList("failed-twice");
    const { result } = renderHook(() => usePagedRead(list.spec, "T-1"), {
      wrapper: wrap(signal),
    });
    await list.flush();
    list.generation.n = 2;
    list.failing.add(0);
    act(() => signal.change());
    await list.flush();

    act(() => result.current.showMore());
    await list.flush();
    expect(list.offsets()).not.toContain(2);
    expect(result.current.failure?.title).toBe("Couldn't load the list");
    expect(result.current.current).toBe(false);
  });
});

describe("Retry", () => {
  it("reads the missing page after a failed Show more", async () => {
    const signal = fakeChangeSignal();
    const list = slowList("retry-more");
    const { result } = renderHook(() => usePagedRead(list.spec, "T-1"), {
      wrapper: wrap(signal),
    });
    await list.flush();

    list.failing.add(2);
    act(() => result.current.showMore());
    await list.flush();
    expect(result.current.failure?.title).toBe(
      "Couldn't load more of the list",
    );
    expect(result.current.failedMore).toBe(true);

    list.failing.clear();
    act(() => result.current.retry());
    await list.flush();
    expect(list.offsets()).toEqual([0, 2, 2]);
    expect(result.current.value).toEqual(["g1-0", "g1-1", "g1-2", "g1-3"]);
    expect(result.current.failure).toBeNull();
  });

  it("re-reads the loaded pages after a failed refresh", async () => {
    const signal = fakeChangeSignal();
    const list = slowList("retry-refresh");
    const { result } = renderHook(() => usePagedRead(list.spec, "T-1"), {
      wrapper: wrap(signal),
    });
    await list.flush();
    act(() => result.current.showMore());
    await list.flush();

    list.generation.n = 2;
    list.failing.add(0);
    act(() => signal.change());
    await list.flush();
    expect(result.current.failure?.title).toBe("Couldn't load the list");
    expect(result.current.failedMore).toBe(false);

    list.failing.clear();
    act(() => result.current.retry());
    await list.flush();
    expect(result.current.value).toEqual(["g2-0", "g2-1", "g2-2", "g2-3"]);
    expect(result.current.failure).toBeNull();
  });
});
