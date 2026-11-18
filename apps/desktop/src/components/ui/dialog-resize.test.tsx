// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./dialog";

// The New ticket dialog glides when Expand is pressed, and only then: a window
// resize moves its edges with the window (nothing animates while a panel is
// being resized, DESIGN.md section 12).

const styles = readFileSync(join(__dirname, "..", "..", "styles.css"), "utf8");

let restoreTokens: () => void;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
  restoreTokens();
  vi.useRealTimers();
});

function Create({ expanded }: { expanded: boolean }) {
  return (
    <Dialog open>
      <DialogContent surface="create" expanded={expanded}>
        <DialogTitle>New ticket</DialogTitle>
        <DialogDescription>Create</DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

const dialog = () => document.querySelector<HTMLElement>(".ui-dialog")!;

it("is marked as resizing only while an expand or collapse plays", () => {
  const { rerender } = render(<Create expanded={false} />);
  expect(dialog().hasAttribute("data-resizing")).toBe(false);

  rerender(<Create expanded />);
  expect(dialog().hasAttribute("data-resizing")).toBe(true);
  act(() => {
    vi.advanceTimersByTime(600);
  });
  expect(dialog().hasAttribute("data-resizing")).toBe(false);

  rerender(<Create expanded={false} />);
  expect(dialog().hasAttribute("data-resizing")).toBe(true);
});

it("a window resize interrupts the size glide without stopping the next deliberate change", () => {
  const { rerender } = render(<Create expanded={false} />);
  rerender(<Create expanded />);
  act(() => vi.advanceTimersByTime(100));
  expect(dialog().hasAttribute("data-resizing")).toBe(true);

  fireEvent.resize(window);
  expect(dialog().hasAttribute("data-resizing")).toBe(false);

  act(() => vi.advanceTimersByTime(100));
  rerender(<Create expanded={false} />);
  expect(dialog().hasAttribute("data-resizing")).toBe(true);
  // The interrupted expansion's old timer must not cut this collapse short.
  act(() => vi.advanceTimersByTime(240));
  expect(dialog().hasAttribute("data-resizing")).toBe(true);
  act(() => vi.advanceTimersByTime(200));
  expect(dialog().hasAttribute("data-resizing")).toBe(false);

  rerender(<Create expanded />);
  expect(dialog().hasAttribute("data-resizing")).toBe(true);
});

it("excludes size transitions after a resize while retaining the theme fade", () => {
  // jsdom checks the cascade, not native cancellation of an existing transition.
  const sheet = document.createElement("style");
  sheet.textContent = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(
      ([, selector]) =>
        selector?.includes('.ui-dialog[data-surface="create"]') ||
        selector?.includes(":root[data-theme-fading] *"),
    )
    // jsdom drops mixed element/pseudo-element lists; only the element applies here.
    .map(([, selector, body]) => {
      const elements = (selector ?? "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(",")
        .filter((part) => !part.includes("::"));
      return `${elements.join(",")} {${body ?? ""}}`;
    })
    .join("\n");
  document.head.append(sheet);
  try {
    const { rerender } = render(<Create expanded={false} />);
    rerender(<Create expanded />);
    fireEvent.resize(window);
    expect(dialog().hasAttribute("data-resizing")).toBe(false);
    expect(getComputedStyle(dialog()).transitionProperty).toBe("none");

    document.documentElement.setAttribute("data-theme-fading", "");
    const properties = getComputedStyle(dialog()).transitionProperty;
    expect(properties).toContain("background-color");
    expect(properties).toContain("box-shadow");
    expect(properties).not.toMatch(/width|height|all/);
  } finally {
    document.documentElement.removeAttribute("data-theme-fading");
    sheet.remove();
  }
});

it("its size transition is declared only for that moment", () => {
  const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({
    selector: (rule[1] ?? "").replace(/\s+/g, " ").trim(),
    body: rule[2] ?? "",
  }));
  const transitions = rules.filter(
    (rule) =>
      rule.selector.includes('.ui-dialog[data-surface="create"]') &&
      /transition:/.test(rule.body),
  );
  expect(transitions.length).toBeGreaterThan(0);
  for (const rule of transitions) {
    expect(rule.selector).toContain("[data-resizing]");
    expect(rule.body).toMatch(/width var\(--spring-smooth-t\)/);
    expect(rule.body).toMatch(/height var\(--spring-smooth-t\)/);
  }
});
