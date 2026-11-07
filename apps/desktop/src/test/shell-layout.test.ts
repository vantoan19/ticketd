import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// DESIGN.md section 5: the shell stays locked to the window and only panes
// scroll. An absolutely positioned descendant (an sr-only status deep in a long
// pane) whose containing block is the viewport extends the document, so the
// whole window scrolls and the sidebar moves with it.
const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
const rule = (selector: string) =>
  new RegExp(`\n${selector.replace(".", "[.]")} [{]([^}]*)[}]`).exec(
    css,
  )?.[1] ?? "";

it.each([".workspace", ".content-panel"])(
  "%s contains absolutely positioned descendants and cannot scroll",
  (selector) => {
    expect(rule(selector)).toMatch(/position: relative;/);
    expect(rule(selector)).toMatch(/overflow: clip;/);
  },
);
