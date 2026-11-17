import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Guards the motion of menus, popovers, tooltips and dialogs (DESIGN.md section
// 12). jsdom has no stylesheet cascade, so these read the rules themselves.

const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selector: (match[1] ?? "").replace(/\s+/g, " ").trim(),
  body: match[2] ?? "",
}));

/** The `animation` declared for exactly this selector, if any. */
function animation(selector: string): string | undefined {
  return rules
    .filter((rule) => rule.selector === selector)
    .map((rule) => /animation:\s*([^;]+)/.exec(rule.body)?.[1])
    .find(Boolean);
}

it("a tooltip fades in after the hover delay but opens at once beside another", () => {
  expect(animation('.ui-tooltip[data-state="delayed-open"]')).toMatch(
    /tooltip-enter var\(--dur-2\)/,
  );
  expect(animation('.ui-tooltip[data-state="instant-open"]')).toBeUndefined();
  expect(animation('.ui-tooltip[data-state="closed"]')).toMatch(
    /var\(--dur-exit\)/,
  );
});

it("a dialog rises on the smooth spring and leaves in the exit time", () => {
  expect(animation('.ui-dialog[data-state="open"]')).toMatch(
    /dialog-enter var\(--spring-smooth-t\) var\(--spring-smooth\)/,
  );
  expect(animation('.ui-dialog[data-state="closed"]')).toMatch(
    /var\(--dur-exit\)/,
  );
});

it("the command palette moves as any dialog does", () => {
  const own = rules.filter(
    (rule) =>
      rule.selector.includes('[data-size="palette"]') &&
      /animation:/.test(rule.body),
  );
  expect(own).toEqual([]);
});

it("menus and popovers leave faster than they arrive", () => {
  const enter = animation(
    '.ui-popover[data-state="open"], .ui-menu[data-state="open"]',
  );
  const leave = animation(
    '.ui-popover[data-state="closed"], .ui-menu[data-state="closed"]',
  );
  expect(enter).toMatch(/menu-enter var\(--dur-3\)/);
  expect(leave).toMatch(/menu-leave var\(--dur-2\)/);
});
