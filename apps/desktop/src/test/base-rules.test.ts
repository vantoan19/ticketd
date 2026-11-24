import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Guards shared rules in styles.css that features rely on outside their
// usual context (DESIGN.md sections 3 and 11). jsdom has no stylesheet
// cascade, so these read the rules themselves.

const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
/** Splits a selector list on its top-level commas, not those inside :not(). */
function selectorList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.replace(/\s+/g, " ").trim());
}

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: selectorList(match[1] ?? ""),
  body: match[2] ?? "",
}));

it("loading skeletons respect the visibility of hidden layout reserves", () => {
  const patterns = readFileSync(
    join(__dirname, "..", "components", "ui", "patterns.css"),
    "utf8",
  );
  const animation = patterns.match(
    /@keyframes skeleton-appear\s*\{([\s\S]*?)\n\}/,
  );
  expect(animation).not.toBeNull();
  expect(animation?.[1]).not.toMatch(/visibility\s*:/);
});

it("styles a record link wherever it is used, not only inside Markdown", () => {
  // The attachment preview is portalled outside .markdown-document, so its
  // "Used in" links rendered as bare centred buttons (shell AT-11). RecordLink
  // carries its own rule in the shared patterns, not a Markdown descendant.
  const patterns = readFileSync(
    join(__dirname, "..", "components", "ui", "patterns.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const link = [...patterns.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) =>
    selectorList(match[1] ?? "").includes(".ui-record-link"),
  );
  expect(link?.[2]).toMatch(/text-decoration:\s*underline/);
});

it("draws only text-like inputs as 40px fields", () => {
  // Radios were 40px tall boxes with a surface fill (chat CH-42).
  const fields = rules.filter(
    (rule) =>
      rule.selectors.some((part) => part.startsWith("input:")) &&
      /(?:^|;)\s*(?:height|padding|background):/.test(rule.body),
  );
  expect(fields.length).toBeGreaterThan(0);
  for (const rule of fields)
    for (const part of rule.selectors.filter((p) => p.startsWith("input:")))
      for (const type of ["checkbox", "radio", "range", "file"])
        expect(part, part).toContain(`[type="${type}"]`);
});

it("gives unclassed text in the body and every overlay the working role", () => {
  const base = rules.find((rule) =>
    ["body", ".ui-dialog", ".ui-popover", ".ui-menu"].every((selector) =>
      rule.selectors.includes(selector),
    ),
  );
  expect(base?.body).toContain("font-size: var(--text-ui)");
  expect(base?.body).toContain("line-height: var(--text-ui-line)");
});

it("the settings page keeps its scrollbar gutter, so a longer page does not shift its column", () => {
  // jsdom has no layout; a classic scrollbar appearing narrows the column by ~8px.
  const layout = readFileSync(
    join(__dirname, "..", "features/settings/layout/settings-layout.css"),
    "utf8",
  );
  const page = /\.settings-page\s*\{([^}]*)\}/.exec(layout)?.[1] ?? "";
  expect(page).toMatch(/scrollbar-gutter:\s*stable/);
});
