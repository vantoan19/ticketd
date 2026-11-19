// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installWidthQueries, WIDTH_PANES, widthTokens } from "./width-queries";

// The large panes' breakpoints come from a ResizeObserver, not container
// queries (lib/width-queries explains why). jsdom has neither layout nor a
// ResizeObserver, so the observer is a stand-in the test reports sizes through.

let report: (target: Element, width: number) => void;
const observed = new Set<Element>();
class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    report = (target, width) =>
      callback(
        [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
  }
  observe(target: Element) {
    observed.add(target);
  }
  unobserve(target: Element) {
    observed.delete(target);
  }
  disconnect() {
    observed.clear();
  }
}

let stop: () => void;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  stop = installWidthQueries(document.body);
});
afterEach(() => {
  stop();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const settle = () => new Promise((resolve) => setTimeout(resolve));

it("writes the breakpoints a pane mounted later is within, and clears them while it has no size", async () => {
  const pane = document.createElement("section");
  pane.className = "ticket-list";
  document.body.append(pane);
  await settle();
  expect(observed.has(pane)).toBe(true);

  report(pane, 700);
  const tokens = pane.getAttribute("data-width")?.split(" ") ?? [];
  expect(tokens).toContain("max-799");
  expect(tokens).not.toContain("max-640");

  report(pane, 0);
  expect(pane.hasAttribute("data-width")).toBe(false);

  pane.remove();
  await settle();
  expect(observed.has(pane)).toBe(false);
});

it("every breakpoint a stylesheet matches is one the observer writes, inclusive like the query", () => {
  const srcDir = join(__dirname, "..");
  const files = (readdirSync(srcDir, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".css"))
    .map((file) =>
      readFileSync(join(srcDir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
    );
  const used = new Set(
    files.flatMap((css) =>
      [...css.matchAll(/data-width~="((?:max|min)-\d+)"/g)].map((m) => m[1]!),
    ),
  );
  expect(used.size).toBeGreaterThan(10);
  for (const token of used) {
    const [kind, value] = token.split("-") as ["max" | "min", string];
    const edge = Number(value);
    const outside = kind === "max" ? edge + 1 : edge - 1;
    expect(widthTokens(edge).split(" "), token).toContain(token);
    expect(widthTokens(outside).split(" "), token).not.toContain(token);
  }
  // A measured pane is no longer a query container: resizing one would
  // restyle its whole subtree again.
  for (const pane of WIDTH_PANES.split(", "))
    for (const css of files)
      for (const [, body] of css.matchAll(
        new RegExp(`\\n\\${pane} \\{([^}]*)\\}`, "g"),
      ))
        expect(body, pane).not.toMatch(/container(-type)?:/);
});
