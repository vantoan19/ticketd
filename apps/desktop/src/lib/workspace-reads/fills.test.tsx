// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  fillRead,
  pagedRead,
  read,
  updatePagedRead,
  updateRead,
} from "./catalog";
import { fakeChangeSignal } from "./fake-signal";
import { deferred, settle, wrap } from "./test-support";
import { useReads } from "./reads-context";
import { useKnown } from "./use-known";
import { usePagedRead } from "./use-paged-read";
import { useRead } from "./use-read";
import { useWrote } from "./use-wrote";

describe("a fill", () => {
  const title = (call: (reference: string) => Promise<string>, key: string) =>
    read({ key, call, failure: "load the title" });

  function mount(spec: ReturnType<typeof title>, signal = fakeChangeSignal()) {
    return renderHook(
      () => ({
        read: useRead(spec, "T-1"),
        wrote: useWrote(),
        known: useKnown(spec),
      }),
      { wrapper: wrap(signal) },
    );
  }

  it("shows a value for any declared read at once and keeps it through a failed re-read", async () => {
    const reread = deferred<string>();
    const call = vi
      .fn<(reference: string) => Promise<string>>()
      .mockResolvedValueOnce("Before")
      .mockReturnValueOnce(reread.promise);
    const spec = title(call, "fill-failed");
    const { result } = mount(spec);
    await waitFor(() => expect(result.current.read.value).toBe("Before"));

    act(() => {
      void result.current.wrote({ fills: [fillRead(spec, "T-1", "Written")] });
    });
    await waitFor(() => expect(result.current.read.value).toBe("Written"));
    await act(async () => reread.reject(new Error("locked")));
    expect(result.current.read.value).toBe("Written");
    expect(result.current.read.failure).not.toBeNull();
  });

  it("is replaced by the next good read", async () => {
    const signal = fakeChangeSignal();
    const call = vi
      .fn<(reference: string) => Promise<string>>()
      .mockResolvedValueOnce("Before")
      .mockRejectedValueOnce(new Error("locked"))
      .mockResolvedValue("Outside");
    const spec = title(call, "fill-replaced");
    const { result } = mount(spec, signal);
    await waitFor(() => expect(result.current.read.value).toBe("Before"));
    await act(async () =>
      result.current.wrote({ fills: [fillRead(spec, "T-1", "Written")] }),
    );
    expect(result.current.read.value).toBe("Written");

    act(() => signal.change());
    await waitFor(() => expect(result.current.read.value).toBe("Outside"));
    expect(result.current.read.failure).toBeNull();
  });

  it("creates the entry of a value, but not that of an update", async () => {
    const call = vi.fn(async () => "read");
    const spec = title(call, "fill-create");
    const { result } = renderHook(
      () => ({ wrote: useWrote(), known: useKnown(spec) }),
      { wrapper: wrap() },
    );
    await act(async () =>
      result.current.wrote({
        fills: [updateRead(spec, "T-1", (value) => `${value}!`)],
      }),
    );
    expect(result.current.known("T-1")).toBeUndefined();

    await act(async () =>
      result.current.wrote({ fills: [fillRead(spec, "T-1", "Filled")] }),
    );
    expect(result.current.known("T-1")).toBe("Filled");
    expect(call).not.toHaveBeenCalled();
  });

  it("changes an update of a cached value and leaves a read of other arguments alone", async () => {
    const reread = deferred<string>();
    const call = vi
      .fn<(reference: string) => Promise<string>>()
      .mockResolvedValueOnce("one")
      .mockReturnValue(reread.promise);
    const spec = title(call, "fill-update");
    const { result } = mount(spec);
    await waitFor(() => expect(result.current.read.value).toBe("one"));

    act(() => {
      void result.current.wrote({
        fills: [
          updateRead(spec, "T-1", (value) => `${value} and more`),
          updateRead(spec, "T-2", (value) => `${value} and more`),
        ],
      });
    });
    await waitFor(() => expect(result.current.read.value).toBe("one and more"));
    expect(result.current.known("T-2")).toBeUndefined();
  });
});

describe("a fill of a paged read", () => {
  type Page = { items: { id: string; text: string }[]; next: number | null };
  const pages: Page[] = [
    {
      items: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      next: 2,
    },
    {
      items: [
        { id: "c", text: "C" },
        { id: "d", text: "D" },
      ],
      next: null,
    },
  ];
  const list = (call: (args: string, offset: number) => Promise<Page>) =>
    pagedRead({
      key: "fill-paged",
      call,
      next: (page: Page) => page.next,
      join: (all: readonly Page[]) => all.flatMap((page) => page.items),
      failure: "load the list",
      more: "load more of the list",
    });

  it("changes only the item that matches, in whichever page holds it, and shows it through a failed re-read", async () => {
    const call = vi.fn<(args: string, offset: number) => Promise<Page>>(
      async (_, offset) => pages[offset / 2]!,
    );
    const spec = list(call);
    const { result } = renderHook(
      () => ({ read: usePagedRead(spec, "T-1"), wrote: useWrote() }),
      { wrapper: wrap() },
    );
    await waitFor(() => expect(result.current.read.value).toHaveLength(2));
    act(() => result.current.read.showMore());
    await waitFor(() => expect(result.current.read.value).toHaveLength(4));
    const before = result.current.read.value;

    call.mockRejectedValue(new Error("locked"));
    await act(async () =>
      result.current.wrote({
        fills: [
          updatePagedRead(spec, "T-1", (page) => ({
            ...page,
            items: page.items.map((item) =>
              item.id === "c" ? { ...item, text: "edited" } : item,
            ),
          })),
        ],
      }),
    );
    await settle();
    const value = result.current.read.value!;
    expect(value.map((item) => item.text)).toEqual(["A", "B", "edited", "D"]);
    expect(value[0]).toBe(before![0]);
    expect(result.current.read.failure).not.toBeNull();
  });

  it("creates nothing for a list that was never read", async () => {
    const call = vi.fn(async () => pages[0]!);
    const spec = list(call);
    const { result } = renderHook(
      () => ({ wrote: useWrote(), reads: useReads("test") }),
      { wrapper: wrap() },
    );
    await act(async () =>
      result.current.wrote({
        fills: [updatePagedRead(spec, "T-1", (page) => ({ ...page }))],
      }),
    );
    expect(result.current.reads.client.getQueryCache().getAll()).toEqual([]);
  });
});
