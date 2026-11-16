// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { StatusLineRegion } from "./status-line";
import { useStatusLine, type StatusLineMessage } from "./use-status-line";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const postRef: { current: (message: StatusLineMessage) => void } = {
  current: () => {},
};
const post = (message: StatusLineMessage) => postRef.current(message);
function Poster({ targetRef }: { targetRef: typeof postRef }) {
  const { show } = useStatusLine();
  useEffect(() => {
    targetRef.current = show;
  });
  return null;
}
function region() {
  render(
    <StatusLineRegion>
      <Poster targetRef={postRef} />
    </StatusLineRegion>,
  );
}
const line = () => document.querySelector('[data-slot="status-line"]');

test("a plain outcome stays 4s, one with Undo 10s, and hovering pauses the clock", () => {
  region();
  act(() => post({ message: "Copied reference" }));
  expect(screen.getByRole("status").textContent).toContain("Copied reference");
  act(() => vi.advanceTimersByTime(3_900));
  expect(line()).not.toBeNull();
  act(() => vi.advanceTimersByTime(200));
  expect(line()).toBeNull();

  act(() => post({ message: "Moved T-1 to Trash", undo: () => {} }));
  act(() => vi.advanceTimersByTime(9_000));
  fireEvent.pointerEnter(line()!);
  act(() => vi.advanceTimersByTime(30_000));
  expect(line()).not.toBeNull();
  fireEvent.pointerLeave(line()!);
  act(() => vi.advanceTimersByTime(1_100));
  expect(line()).toBeNull();
});

test("the newest message replaces the last, and a failure stays as an alert", () => {
  region();
  act(() => post({ message: "First" }));
  act(() => post({ tone: "error", message: "Couldn't move T-1" }));
  expect(screen.queryByText("First")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("Couldn't move T-1");
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(line()).toBeNull();
});

test("Undo runs the undo; a failed undo turns into the failure with Retry", async () => {
  region();
  const undo = vi
    .fn()
    .mockRejectedValueOnce(new Error("workspace is read-only"))
    .mockResolvedValueOnce(undefined);
  act(() => post({ message: "Removed the link to T-2", undo }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  });
  expect(undo).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert").textContent).toContain(
    "Couldn't undo. The result couldn't be confirmed.",
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });
  expect(undo).toHaveBeenCalledTimes(2);
  expect(line()).toBeNull();
});

test("an action that posts its own outcome keeps that outcome on screen", async () => {
  // Retry that succeeds says what happened ("Archived Launch · Undo"); closing
  // the failed line must not close the line that replaced it.
  region();
  act(() =>
    post({
      tone: "error",
      message: "Couldn't archive Launch",
      action: {
        label: "Retry",
        run: () => post({ message: "Archived Launch", undo: () => {} }),
      },
    }),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });
  expect(screen.getByRole("status").textContent).toContain("Archived Launch");
});

test("outside a region posting does nothing", () => {
  render(<Poster targetRef={postRef} />);
  act(() => post({ message: "Nowhere" }));
  expect(line()).toBeNull();
});
