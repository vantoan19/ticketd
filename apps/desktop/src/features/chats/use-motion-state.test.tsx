// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { useArrivals, useChunkStarts } from "@/features/chats/use-arrivals";
import { usePlaced } from "@/features/chats/use-placed";
import type { ChatSummary } from "@/features/chats/client";

test("what a Chat opens with is history; what comes after is an arrival", () => {
  const { result, rerender } = renderHook(
    ({ keys, replaying }) => useArrivals("c1", keys, replaying),
    { initialProps: { keys: ["a", "b"], replaying: false } },
  );
  expect(result.current.fresh.size).toBe(0);
  rerender({ keys: ["a", "b", "c"], replaying: false });
  expect([...result.current.fresh]).toEqual(["c"]);
  // A key that was already known never becomes an arrival later.
  rerender({ keys: ["a", "b", "c"], replaying: false });
  expect([...result.current.fresh]).toEqual(["c"]);
});

test("replayed history never animates, and another Chat starts over", () => {
  const { result, rerender } = renderHook(
    ({ id, keys, replaying }) => useArrivals(id, keys, replaying),
    { initialProps: { id: "c1", keys: ["a"], replaying: true } },
  );
  rerender({ id: "c1", keys: ["a", "b", "c"], replaying: true });
  expect(result.current.fresh.size).toBe(0);
  rerender({ id: "c1", keys: ["a", "b", "c", "d"], replaying: false });
  expect([...result.current.fresh]).toEqual(["d"]);
  rerender({ id: "c2", keys: ["x", "y"], replaying: false });
  expect(result.current.fresh.size).toBe(0);
});

test("streamed text marks where each new chunk began, not the text it opened with", () => {
  const { result, rerender } = renderHook(
    ({ text, streaming }) => useChunkStarts(text, streaming),
    { initialProps: { text: "Hel", streaming: true } },
  );
  expect(result.current).toEqual([]);
  rerender({ text: "Hello wor", streaming: true });
  rerender({ text: "Hello world!", streaming: true });
  expect(result.current).toEqual([3, 9]);
  // The last words arrive with the end of the stream.
  rerender({ text: "Hello world! Bye", streaming: false });
  expect(result.current).toEqual([3, 9, 12]);
  // Text that is replaced, not extended, starts over.
  rerender({ text: "Another", streaming: false });
  expect(result.current).toEqual([]);
});

test("a complete reply that is not streaming has no chunks", () => {
  const { result, rerender } = renderHook(
    ({ text }) => useChunkStarts(text, false),
    { initialProps: { text: "Done." } },
  );
  rerender({ text: "Done. And more." });
  expect(result.current).toEqual([]);
});

const summary = (id: string, rank: "working" | "approval"): ChatSummary =>
  ({
    id,
    status: { rank },
  }) as unknown as ChatSummary;

test("the Chats that need you come first, and the list holds still under the pointer", () => {
  const a = summary("a", "working");
  const b = summary("b", "working");
  const { result, rerender } = renderHook(
    ({ chats, held }) => usePlaced(chats, held),
    { initialProps: { chats: [a, b], held: false } },
  );
  expect(result.current.map((one) => one.chat.id)).toEqual(["a", "b"]);
  // b starts needing you while the pointer is over the list: nothing moves.
  const needing = summary("b", "approval");
  rerender({ chats: [a, needing], held: true });
  expect(result.current.map((one) => [one.chat.id, one.needs])).toEqual([
    ["a", false],
    ["b", false],
  ]);
  // The row still shows what is true now.
  expect(result.current[1]?.chat).toBe(needing);
  // The pointer leaves: b moves up into Needs you.
  rerender({ chats: [a, needing], held: false });
  expect(result.current.map((one) => [one.chat.id, one.needs])).toEqual([
    ["b", true],
    ["a", false],
  ]);
});

test("a Chat that appears while the list is held goes on top of its group", () => {
  const a = summary("a", "working");
  const { result, rerender } = renderHook(
    ({ chats, held }) => usePlaced(chats, held),
    { initialProps: { chats: [a], held: true } },
  );
  rerender({ chats: [summary("n", "working"), a], held: true });
  // The list is newest first, so it lands where it will settle: above the held rows.
  expect(result.current.map((one) => one.chat.id)).toEqual(["n", "a"]);
});

test("a Chat that appears while held and needs you goes above the whole list", () => {
  const a = summary("a", "working");
  const { result, rerender } = renderHook(
    ({ chats, held }) => usePlaced(chats, held),
    { initialProps: { chats: [a], held: true } },
  );
  rerender({ chats: [summary("n", "approval"), a], held: true });
  expect(result.current.map((one) => one.chat.id)).toEqual(["n", "a"]);
});

test("a new Recent Chat goes below the held Needs you ones and above the held Recent ones", () => {
  const needing = summary("a", "approval");
  const recent = summary("b", "working");
  const { result, rerender } = renderHook(
    ({ chats, held }) => usePlaced(chats, held),
    { initialProps: { chats: [needing, recent], held: true } },
  );
  rerender({ chats: [needing, summary("n", "working"), recent], held: true });
  expect(result.current.map((one) => one.chat.id)).toEqual(["a", "n", "b"]);
});
