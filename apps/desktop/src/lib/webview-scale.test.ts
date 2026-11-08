import { expect, test, vi } from "vitest";
import { outOfStep, repair } from "./webview-scale";

const window150 = { scale: 1.5, width: 1920, height: 1158 };

test("a page drawn at its window's scale and size is in step", () => {
  // CSS pixels are whole numbers, so a page can be a pixel short of the window.
  expect(outOfStep({ dpr: 1.5, width: 1280, height: 771 }, window150)).toBe(
    false,
  );
});

test("a page that lost its display scale after sleep is out of step", () => {
  // WebView2 drew at 100% in a 150% window: the UI shrank to two thirds.
  expect(outOfStep({ dpr: 1, width: 1920, height: 1158 }, window150)).toBe(
    true,
  );
});

test("a page smaller than its window is out of step", () => {
  // The other symptom: blank space right and below the page.
  expect(outOfStep({ dpr: 1.5, width: 900, height: 600 }, window150)).toBe(
    true,
  );
});

test("repair resizes the window by a pixel and back, which redraws WebView2", async () => {
  const calls: string[] = [];
  const win = {
    isMaximized: vi.fn(async () => false),
    innerSize: vi.fn(async () => ({ width: 1920, height: 1158 })),
    setSize: vi.fn(async (size: { width: number; height: number }) => {
      calls.push(`${size.width}x${size.height}`);
    }),
    unmaximize: vi.fn(async () => {}),
    maximize: vi.fn(async () => {}),
  };
  await repair(win);
  expect(calls).toEqual(["1921x1158", "1920x1158"]);
});

test("repair restores and re-maximizes a maximized window instead", async () => {
  const win = {
    isMaximized: vi.fn(async () => true),
    innerSize: vi.fn(async () => ({ width: 1920, height: 1158 })),
    setSize: vi.fn(async () => {}),
    unmaximize: vi.fn(async () => {}),
    maximize: vi.fn(async () => {}),
  };
  await repair(win);
  expect(win.setSize).not.toHaveBeenCalled();
  expect(win.unmaximize).toHaveBeenCalled();
  expect(win.maximize).toHaveBeenCalled();
});
