import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Guards the scoped theme tokens: data-theme-preview gives a subtree a theme's
// tokens (Appearance shows both themes at once), so the token blocks must keep
// the attribute in their selectors.

const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");

function selectorOf(declaration: string, last = false): string {
  const token = `--${declaration}:`;
  const start = last ? css.lastIndexOf(token) : css.indexOf(token);
  const open = css.lastIndexOf("{", start);
  const before = css.slice(0, open);
  return before
    .slice(before.lastIndexOf("}") + 1)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

it("applies the light tokens to :root and any data-theme-preview subtree", () => {
  expect(selectorOf("background")).toBe(":root, [data-theme-preview]");
});

it("applies the dark tokens to the dark root and data-theme-preview=dark", () => {
  const dark = selectorOf("syntax-title", true);
  expect(dark).toBe(':root[data-theme="dark"], [data-theme-preview="dark"]');
});
