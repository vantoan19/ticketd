import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Rules the live verification found broken at small sizes (860x700, the folded
// rail). jsdom has no layout, so each rule is asserted where it is written.
const src = (...parts: string[]) =>
  readFileSync(join(__dirname, "..", ...parts), "utf8");
const css = src("styles.css");
const block = (text: string, selector: string) =>
  new RegExp(`${selector.replace(/[.[\]()>=]/g, "\\$&")} [{]([^}]*)[}]`).exec(
    text,
  )?.[1] ?? "";

it("the folded rail centres a line's action and hides the words that only repeat the line", () => {
  expect(
    block(
      css,
      ".sidebar[data-collapsed] .sidebar-source > button:not(.sidebar-source-line)",
    ),
  ).toMatch(/margin-left: 0;/);
  expect(
    block(css, ".sidebar[data-collapsed] .sidebar-source > [data-rail-hidden]"),
  ).toMatch(/display: none;/);
});

it("the Ticket sources table keeps one line per cell and drops the sign-in column when narrow", () => {
  const table = src("features", "settings", "pages", "sources-table.css");
  expect(table).toMatch(
    /\.sources-table thead th,\s*\.sources-table tbody td \{\s*white-space: nowrap;/,
  );
  expect(table).toMatch(
    /@media \(max-width: 900px\) \{\s*\.sources-table \.sources-table-signs \{\s*display: none;/,
  );
});

it("a command wraps instead of scrolling inside its box, and its copy button copies it whole", () => {
  const code = src("components", "ui", "command-block.tsx");
  expect(code).toMatch(/break-words/);
  expect(code).not.toMatch(/overflow-x-auto|whitespace-nowrap/);
});

it("a skill folder is the board's 12px regular mono caption", () => {
  const settings = src(
    "components",
    "ui",
    "surface-roles",
    "settings-settings.css",
  );
  const rule = block(settings, ".agent-skill-path .ui-path-text");
  expect(rule).toMatch(/font-size: var\(--text-caption\);/);
  expect(rule).toMatch(/font-weight: 400;/);
});

it("a restore point's time stays on one line", () => {
  expect(src("features", "settings", "pages", "BackupsSection.tsx")).toMatch(
    /whitespace-nowrap">\{when\}/,
  );
});
