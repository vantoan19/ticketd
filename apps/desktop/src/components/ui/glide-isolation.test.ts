import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Every Glide site isolates the container of its items, never each item
// (DESIGN.md section 12). The highlight is `z-index: -1`: in an isolated item
// it would paint above every earlier item it passes on the way down.

const src = join(__dirname, "..", "..");
const css = (...path: string[]) =>
  readFileSync(join(src, ...path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The selectors of every rule that makes its own stacking context isolated. */
function isolating(source: string): string[] {
  const found: string[] = [];
  for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    if (/isolation:\s*isolate/.test(rule[2] ?? ""))
      for (const selector of (rule[1] ?? "").split(","))
        found.push(selector.trim().replace(/\s+/g, " "));
  return found;
}

const sites = [
  {
    name: "the sidebar nav",
    file: ["styles.css"],
    container: ".sidebar-body",
    row: /^\.sidebar-nav/,
  },
  {
    name: "the Settings nav",
    file: ["features", "settings", "settings.css"],
    container: ".settings-nav",
    row: /^\.settings-nav-row/,
  },
  {
    name: "the ticket list",
    file: ["features", "tickets", "ticket-list.css"],
    container: ".ticket-rows",
    row: /^\.ticket-rows /,
  },
  {
    name: "menus and popovers",
    file: ["styles.css"],
    container: ".ui-menu",
    row: /menu-item|\[role="menuitem"\]|\[cmdk-item\]/,
  },
  {
    name: "the command list",
    file: ["styles.css"],
    container: '[data-slot="command-list"]',
    row: /command-item|\[cmdk-item\]/,
  },
  {
    name: "the select list",
    file: ["styles.css"],
    container: ".ui-popover",
    row: /select-item|\[role="option"\]/,
  },
  {
    name: "segmented controls",
    file: ["styles.css"],
    container: ".ui-segmented",
    row: /\[role="(radio|tab)"\]/,
  },
];

describe.each(sites)("$name", ({ file, container, row }) => {
  const selectors = isolating(css(...file));
  test("isolates the container of its rows", () => {
    expect(selectors).toContain(container);
  });
  test("does not isolate each row", () => {
    expect(selectors.filter((selector) => row.test(selector))).toEqual([]);
  });
});

test("the open ticket row does not paint its hover fill over the highlight", () => {
  expect(css("features", "tickets", "ticket-list.css")).toMatch(
    /\.ticket-rows li:has\(> \[data-slot="glide"\]\)\s*\{\s*background: transparent;/,
  );
});
