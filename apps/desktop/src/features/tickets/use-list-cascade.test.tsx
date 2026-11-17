// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { useListCascade } from "./use-list-cascade";

// The list's cascade is one-shot (DESIGN.md section 12): it is asked for when
// the list replaces the Board or the placeholders, and cleared once taken.

type Props = { layout: "list" | "board"; waiting: boolean };
const start = (props: Props) =>
  renderHook((now: Props) => useListCascade(now.layout, now.waiting), {
    initialProps: props,
  });

test("the list on screen from the start has no cascade", () => {
  const { result } = start({ layout: "list", waiting: false });
  expect(result.current.cascade).toBe(false);
});

test("back from the Board the rows cascade, once", () => {
  const { result, rerender } = start({ layout: "board", waiting: false });
  rerender({ layout: "list", waiting: false });
  expect(result.current.cascade).toBe(true);
  act(() => result.current.done());
  expect(result.current.cascade).toBe(false);
  // A later change in the list does not bring it back.
  rerender({ layout: "list", waiting: false });
  expect(result.current.cascade).toBe(false);
});

test("going to the Board asks for nothing", () => {
  const { result, rerender } = start({ layout: "list", waiting: false });
  rerender({ layout: "board", waiting: false });
  expect(result.current.cascade).toBe(false);
});

test("rows that replace the placeholders cascade, once", () => {
  const { result, rerender } = start({ layout: "list", waiting: true });
  expect(result.current.cascade).toBe(false);
  rerender({ layout: "list", waiting: false });
  expect(result.current.cascade).toBe(true);
  act(() => result.current.done());
  expect(result.current.cascade).toBe(false);
});

test("placeholders appearing later ask for nothing", () => {
  const { result, rerender } = start({ layout: "list", waiting: false });
  rerender({ layout: "list", waiting: true });
  expect(result.current.cascade).toBe(false);
});
