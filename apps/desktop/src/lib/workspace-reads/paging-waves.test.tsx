// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { pagedRead } from "./catalog";
import type { Reads } from "./engine";
import { fakeChangeSignal } from "./fake-signal";
import { useReads } from "./reads-context";
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
    act(() => {
      void result.current.retry();
    });
    await list.flush();
    expect(list.offsets()).toEqual([0, 2, 2]);
    expect(result.current.value).toEqual(["g1-0", "g1-1", "g1-2", "g1-3"]);
    expect(result.current.failure).toBeNull();
  });

  it("resolves only once the missing page after a failed Show more has been read", async () => {
    const signal = fakeChangeSignal();
    const list = slowList("retry-more-resolves");
    const { result } = renderHook(() => usePagedRead(list.spec, "T-1"), {
      wrapper: wrap(signal),
    });
    await list.flush();
    list.failing.add(2);
    act(() => result.current.showMore());
    await list.flush();
    expect(result.current.failedMore).toBe(true);

    list.failing.clear();
    let resolved = false;
    act(() => {
      void result.current.retry().then(() => {
        resolved = true;
      });
    });
    await settle();
    expect(list.offsets()).toEqual([0, 2, 2]);
    expect(resolved).toBe(false);

    await list.flush();
    expect(resolved).toBe(true);
    expect(result.current.value).toEqual(["g1-0", "g1-1", "g1-2", "g1-3"]);
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
    act(() => {
      void result.current.retry();
    });
    await list.flush();
    expect(result.current.value).toEqual(["g2-0", "g2-1", "g2-2", "g2-3"]);
    expect(result.current.failure).toBeNull();
  });
});

describe("a page nobody asks for any more", () => {
  /**
   * Two views of one list that a test closes or hides one at a time, and the
   * handles to move the Workspace under them.
   */
  function open(key: string) {
    const signal = fakeChangeSignal();
    const list = slowList(key);
    const control = {
      close: [] as ((closed: boolean) => void)[],
      hide: [] as ((hidden: boolean) => void)[],
      reads: undefined as Reads | undefined,
      states: [] as ReturnType<typeof usePagedRead<string, string[], Page>>[],
    };
    function Section({ index }: { index: number }) {
      control.states[index] = usePagedRead(list.spec, "T-1");
      return null;
    }
    function Host({ index }: { index: number }) {
      const [closed, close] = useState(false);
      const [hidden, hide] = useState(false);
      control.close[index] = close;
      control.hide[index] = hide;
      return closed ? null : (
        <Visibility hidden={hidden}>
          <Section index={index} />
        </Visibility>
      );
    }
    function Probe() {
      control.reads = useReads("test");
      return null;
    }
    const views = (count: number) =>
      render(
        <TestReads signal={signal}>
          <Probe />
          {Array.from({ length: count }, (_, index) => (
            <Host key={index} index={index} />
          ))}
        </TestReads>,
      );
    return { signal, list, control, views };
  }

  it("is not read when its view, closed while it loaded, is opened again after a change", async () => {
    const { signal, list, control, views } = open("orphan-page");
    views(1);
    await list.flush();
    act(() => control.states[0]!.showMore()); // page 2 is in flight
    await settle();
    act(() => control.close[0]!(true));
    await settle();
    list.generation.n = 2;
    act(() => signal.change()); // drops the page in flight
    await list.flush();

    act(() => control.close[0]!(false));
    await list.flush();
    expect(list.offsets()).toEqual([0, 2, 0]);
    expect(control.states[0]!.value).toEqual(["g2-0", "g2-1"]);
  });

  it("is forgotten when the Workspace is replaced while its hidden view waits to read it", async () => {
    const { signal, list, control, views } = open("replaced-page");
    views(1);
    await list.flush();
    act(() => control.states[0]!.showMore()); // page 2 is in flight
    await settle();
    act(() => control.hide[0]!(true));
    list.generation.n = 2;
    act(() => signal.change()); // drops it: wanted once page 0 is read again
    await list.flush();

    list.generation.n = 3;
    await act(async () => control.reads!.replaced());
    act(() => control.hide[0]!(false));
    await list.flush();
    expect(list.offsets()).toEqual([0, 2, 0]);
    expect(control.states[0]!.value).toEqual(["g3-0", "g3-1"]);
  });

  it("is still read for the views that remain when another view of the list is closed", async () => {
    const { signal, list, control, views } = open("shared-page");
    views(2);
    await list.flush();
    act(() => control.states[0]!.showMore());
    await settle();
    list.generation.n = 2;
    act(() => signal.change()); // page 2 is wanted after page 0's re-read, held
    await settle();

    act(() => control.close[1]!(true));
    await list.flush();
    expect(control.states[0]!.value).toEqual(["g2-0", "g2-1", "g2-2", "g2-3"]);
  });
});
