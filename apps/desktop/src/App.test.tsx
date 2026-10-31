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
    trashed: false,
    reference: "T-1",
    title: "First",
    body: "Old",
    status: "Todo",
    tags: [],
    project_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  bridge.invoke.mockImplementation(
    async (command: string, args?: { patch?: { title?: string } }) => {
      if (command === "list_projects" || command === "list_efforts") return [];
      if (command === "list_notes") return [];
      if (command === "find_tickets") return [saved];
      if (command === "ticket_history") return [];
      if (command === "change_ticket" && args?.patch?.title) {
        saved = { ...saved, title: args.patch.title };
        return saved;
      }
      throw new Error("unexpected write");
    },
  );
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
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1900);
  });
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Overwrite" },
  });
  saved = { ...saved, title: "External again" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  fireEvent.click(screen.getByRole("button", { name: "Save my draft" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(saved.title).toBe("Overwrite");
});
