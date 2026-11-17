// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { MarkdownDocument } from "./MarkdownDocument";

// Checking a checklist item (DESIGN.md section 12): the box fills and its tick
// pops in, the strike-through draws and the text dims, all as CSS transitions
// that run when the item changes. Unchecking is at once. jsdom does not run
// stylesheets, so the state change is tested on the document and the motion on
// the stylesheet's rules.

vi.mock("mermaid", () => ({ default: { initialize: vi.fn() } }));
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }),
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);

const styles = readFileSync(join(__dirname, "..", "..", "styles.css"), "utf8");

/** The declarations of the first rule whose selector list contains `selector`. */
function rule(selector: string): string {
  const at = styles.indexOf(selector);
  const open = styles.indexOf("{", at);
  return at < 0 ? "" : styles.slice(open + 1, styles.indexOf("}", open));
}

test("checking an item changes the same box, so its transitions run", () => {
  const { rerender } = render(<MarkdownDocument source={"- [ ] Verify"} />);
  const box = screen.getByRole("img", { name: "Not done" });
  expect(box.hasAttribute("data-checked")).toBe(false);
  // The tick is always in the box; the stylesheet hides it until checked.
  expect(box.querySelector("svg")).not.toBeNull();
  rerender(<MarkdownDocument source={"- [x] Verify"} />);
  const done = screen.getByRole("img", { name: "Done" });
  expect(done).toBe(box);
  expect(done.hasAttribute("data-checked")).toBe(true);
  expect(done.querySelector("svg")).not.toBeNull();
});

test("only the done state carries the transitions, so unchecking is at once", () => {
  expect(rule(".markdown-check[data-checked] {")).toContain("transition:");
  expect(rule(".markdown-check {")).not.toContain("transition");
  expect(rule(".markdown-check[data-checked] svg {")).toContain(
    "var(--spring-glide)",
  );
  expect(rule(".markdown-check svg {")).not.toContain("transition");
  // The strike has no length at rest and draws from the start of the text
  // when the item is done; the transition sits on the done state only.
  const rest = rule(".markdown-document .markdown-task-text,");
  expect(rest).toMatch(/0\s+1px/);
  expect(rest).not.toContain("transition");
  const done = rule("> .markdown-task-text,\n.rich-document li:has");
  expect(done).toContain("background-size: 100% 1px");
  expect(done).toContain("background-size var(--dur-enter)");
});
