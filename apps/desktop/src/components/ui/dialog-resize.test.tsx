// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
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
