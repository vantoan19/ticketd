import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

// Guards DESIGN.md section 4 "Focus": keyboard focus is an outline, so it
// never shares a property with a control's edge or an overlay's elevation.
// When focus was a box-shadow, the pointer-modality reset (box-shadow: none)
// stripped the shadow of every menu and outline button focused by script after
// a click (shell SH-01, list B-01, chat CH-02), and `inset var(--focus-ring)`
// inset only the first layer of the two-layer token (chat CH-01). jsdom has no
// stylesheet cascade, so these checks read the rules themselves.

const srcDir = join(__dirname, "..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

type Rule = { file: string; selector: string; body: string };

const rules: Rule[] = filesUnder(srcDir).flatMap((file) => {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    file: relative(srcDir, file).replaceAll("\\", "/"),
    selector: (match[1] ?? "").replace(/\s+/g, " ").trim(),
    body: (match[2] ?? "").replace(/\s+/g, " ").trim(),
  }));
});

const describe = (rule: Rule) => `${rule.file}: ${rule.selector}`;

it("no rule insets the two-layer focus ring", () => {
  expect(
    rules.filter((rule) => /inset\s+var\(--focus-ring\)/.test(rule.body)),
  ).toEqual([]);
});

it("keyboard focus is drawn with outline, never with box-shadow", () => {
  const shadowFocus = rules.filter(
    (rule) =>
      /:focus/.test(rule.selector) &&
      /box-shadow:[^;]*(?:--focus-ring|var\(--ring\))/.test(rule.body),
  );
  expect(shadowFocus.map(describe)).toEqual([]);
});

it("the pointer-modality reset clears outline only", () => {
  const reset = rules.filter((rule) =>
    rule.selector.includes('[data-input="pointer"]'),
  );
  expect(reset.length).toBeGreaterThan(0);
  expect(
    reset.filter((rule) => /box-shadow/.test(rule.body)).map(describe),
  ).toEqual([]);
});

it("menus, popovers, dialogs and sheets keep their elevation", () => {
  const overlay =
    /\.ui-(?:menu|popover|dialog|sheet)\b|data-slot="(?:dropdown-menu-content|dropdown-menu-sub-content|popover-content|select-content|dialog-content|sheet-content)"/;
  const stripped = rules.filter(
    (rule) =>
      rule.selector
        .split(",")
        .some((part) => overlay.test(part.split(/[\s>+~]+/).at(-1) ?? "")) &&
      /box-shadow:\s*none/.test(rule.body),
  );
  expect(stripped.map(describe)).toEqual([]);

  const shadowOf = (selector: string) =>
    rules.find(
      (rule) =>
        rule.file === "styles.css" &&
        rule.selector.split(",").some((part) => part.trim() === selector) &&
        /box-shadow/.test(rule.body),
    )?.body;
  expect(shadowOf(".ui-menu")).toContain("var(--shadow-menu)");
  expect(shadowOf(".ui-popover")).toContain("var(--shadow-large)");
  expect(shadowOf(".ui-dialog")).toContain("var(--shadow-modal)");
  expect(shadowOf(".ui-sheet")).toContain("var(--shadow-modal)");
});
