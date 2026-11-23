// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProofScreen } from "./ProofScreen";
import { stops } from "./stops";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

afterEach(cleanup);

const handoff = (selected: number) => (
  <ProofScreen stop={stops[1]!} selected={selected} choose={() => {}} />
);

it("settles a visible retry that finished while a different feature was selected", () => {
  const view = render(handoff(1));
  const board = screen.getByAltText<HTMLImageElement>(/^Plan board\./);
  fireEvent.error(board);
  fireEvent.click(screen.getByRole("button", { name: "Reload preview" }));
  view.rerender(handoff(2));

  // Browsers keep the previous picture on screen while the new one loads.
  // Returning to its completed bitmap does not dispatch a second load event.
  Object.defineProperties(board, {
    currentSrc: { value: board.src },
    complete: { value: true },
    naturalWidth: { value: 800 },
  });
  fireEvent.load(board);
  view.rerender(handoff(1));

  expect(screen.queryByRole("status")).toBeNull();
  expect(board.closest("[aria-busy=true]")).toBeNull();
  expect(board.src).toContain("?retry=1");
});

it("reuses a recovered image after retrying another feature", () => {
  const view = render(handoff(1));
  for (const [index, title] of [
    [1, /^Plan board\./],
    [2, /^Ticket detail\./],
  ] as const) {
    view.rerender(handoff(index));
    const photo = screen.getByAltText<HTMLImageElement>(title);
    fireEvent.error(photo);
    fireEvent.click(screen.getByRole("button", { name: "Reload preview" }));
    fireEvent.load(photo);
  }

  view.rerender(handoff(1));
  const board = screen.getByAltText<HTMLImageElement>(/^Plan board\./);
  expect(board.src).toContain("?retry=1");
});
