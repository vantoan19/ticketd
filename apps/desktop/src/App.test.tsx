// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

afterEach(() => {
  vi.useRealTimers();
  bridge.invoke.mockReset();
});

test("refreshes clean content and preserves a draft when saved content changes", async () => {
  vi.useFakeTimers();
  let saved = {
    id: "1",
    reference: "T-1",
    title: "First",
    body: "Old",
    status: "todo",
  };
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "list_tickets") return [saved];
    throw new Error("unexpected write");
  });
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  saved = { ...saved, title: "External" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByLabelText("Title")).toHaveProperty("value", "External");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1900);
  });
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "My draft" },
  });
  saved = { ...saved, title: "Another change" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(screen.getByLabelText("Title")).toHaveProperty("value", "My draft");
  expect(screen.getByText(/Saved content changed/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reload saved content" }));
  expect(screen.getByLabelText("Title")).toHaveProperty(
    "value",
    "Another change",
  );
});
