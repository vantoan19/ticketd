// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { OpenEvidence } from "./evidence-test-support";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

test("says an unfolded empty evidence section is empty, with one Add evidence action", async () => {
  bridge.invoke.mockResolvedValue([]);
  render(<OpenEvidence reference="T-KQ5" />);
  expect(await screen.findByText("No evidence yet.")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Add evidence" })).toHaveLength(
    1,
  );
  expect(screen.queryByLabelText("Name")).toBeNull();
});

test("copies any evidence value and keeps Edit and Delete in the row menu", async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  bridge.invoke.mockResolvedValue([
    {
      id: "c",
      kind: "commit",
      name: "Fix",
      value: "abc1234",
      editing_agent: null,
      created_at: "2026-10-31T10:00:00Z",
      updated_at: "2026-10-31T10:00:00Z",
    },
  ]);
  render(<OpenEvidence reference="T-KQ6" />);
  await screen.findByText("abc1234");
  fireEvent.click(screen.getByRole("button", { name: "Copy Fix" }));
  expect(copy).toHaveBeenCalledWith("abc1234");
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Actions for Fix" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  expect(
    await screen.findByRole("dialog", { name: "Edit evidence" }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Fix");
  Reflect.deleteProperty(navigator, "clipboard");
});
