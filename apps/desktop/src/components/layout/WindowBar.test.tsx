// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { WindowBar } from "./WindowBar";

const win = vi.hoisted(() => ({
  isDecorated: vi.fn(async () => false),
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn(async () => () => {}),
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

afterEach(() => {
  cleanup();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

test("an undecorated window gets the app's title bar with its three controls", async () => {
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  const { container } = render(<WindowBar />);
  (await screen.findByRole("button", { name: "Close" })).click();
  expect(win.close).toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Minimize" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Maximize" })).toBeTruthy();
  // The bar itself is the drag handle, and the shell makes room for it.
  expect(container.querySelector("[data-tauri-drag-region]")).not.toBeNull();
  expect(document.documentElement.hasAttribute("data-window-bar")).toBe(true);
});

test("a window with its native bar, or no desktop shell, gets nothing", () => {
  const { container } = render(<WindowBar />);
  expect(container.firstChild).toBeNull();
});
