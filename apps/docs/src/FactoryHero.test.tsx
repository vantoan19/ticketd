import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import FactoryHero from "./FactoryHero";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const ticket = () =>
  within(
    screen.getByRole("article", {
      name: "T-12: Rate-limit failed login attempts",
    }),
  );

test("one action runs the exchange and stops for human review", () => {
  vi.useFakeTimers();
  render(<FactoryHero />);
  expect(ticket().getByText("Draft")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "See it work" }));
  expect(ticket().getByText("Todo")).toBeTruthy();
  act(() => vi.advanceTimersByTime(2000));
  expect(ticket().getByText("In progress")).toBeTruthy();
  expect(ticket().queryByText(/PR #87/)).toBeNull();
  act(() => vi.advanceTimersByTime(2000));
  expect(ticket().getByText("In review")).toBeTruthy();
  expect(ticket().getByText("↗ PR #87")).toBeTruthy();
  expect(ticket().getByText("✓ Checks passed")).toBeTruthy();
  act(() => vi.advanceTimersByTime(30000));
  expect(ticket().getByText("In review")).toBeTruthy();
  expect(screen.queryByText("Ready", { exact: true })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Approve the example" }));
  expect(ticket().getByText("Done")).toBeTruthy();
  expect(screen.getByText("Ready", { exact: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Run it again" }));
  expect(ticket().getByText("Todo")).toBeTruthy();
  expect(ticket().queryByText(/PR #87/)).toBeNull();
});

test("pause and source inspection preserve progress, reset cancels playback", () => {
  vi.useFakeTimers();
  const { unmount } = render(<FactoryHero />);
  fireEvent.click(screen.getByRole("button", { name: "See it work" }));
  fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
  act(() => vi.advanceTimersByTime(10000));
  expect(ticket().getByText("Todo")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue demo" }));
  act(() => vi.advanceTimersByTime(2000));
  fireEvent.click(screen.getByRole("button", { name: /Login hardening spec/ }));
  act(() => vi.advanceTimersByTime(10000));
  expect(
    screen.getByRole("article", { name: "Login hardening specification" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Back to T-12/ }));
  expect(ticket().getByText("In progress")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue demo" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Reset the factory example" }),
  );
  act(() => vi.advanceTimersByTime(10000));
  expect(ticket().getByText("Draft")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "See it work" }));
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("reduced motion shows the returned report immediately and still requires review", () => {
  vi.useFakeTimers();
  render(<FactoryHero reducedMotion />);
  fireEvent.click(screen.getByRole("button", { name: "See it work" }));
  expect(ticket().getByText("In review")).toBeTruthy();
  expect(vi.getTimerCount()).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Approve the example" }));
  expect(ticket().getByText("Done")).toBeTruthy();
});
