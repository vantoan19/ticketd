import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

// Guards DESIGN.md section 11: stylesheets take colors and radii from the
// tokens in styles.css and never override with !important. Findings that
// predate this check are counted per file in KNOWN; a count may only fall.

const srcDir = join(__dirname, "..");

const KNOWN: Record<string, number> = {
  "features/documents/context-graph.css": 12,
  "features/documents/documents.css": 8,
  "features/markdown/markdown-editor.css": 5,
  "features/plans/plan.css": 8,
  "features/projects/projects.css": 6,
  "features/settings/restore-review.css": 6,
  "features/settings/settings.css": 9,
  "features/settings/sources/sources.css": 8,
  "features/tickets/activity.css": 3,
  "features/tickets/backlinks.css": 1,
  "features/tickets/create-ticket.css": 3,
  "features/tickets/dependency-graph.css": 6,
  "features/tickets/description.css": 1,
  "features/tickets/duplicate-review.css": 3,
  "features/tickets/inbox.css": 3,
  "features/tickets/linked-work.css": 2,
  "features/tickets/properties.css": 1,
  "features/tickets/publication.css": 3,
  "features/tickets/subtickets.css": 1,
  "features/tickets/ticket-board.css": 7,
  "features/tickets/ticket-detail.css": 3,
  "features/tickets/ticket-documents.css": 3,
  "features/tickets/ticket-filters.css": 6,
  "features/tickets/ticket-list.css": 5,
  "styles.css": 34,
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

/** Raw colors, literal radii and !important, outside token definitions. */
function findings(css: string): string[] {
  const found: string[] = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const declaration of (rule[2] ?? "").split(";")) {
      const [property = "", ...rest] = declaration.split(":");
      const name = property.trim();
      const value = rest.join(":").trim();
      if (!name || !value || name.startsWith("--")) continue;
      const rawColor = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i;
      const literalRadius =
        /radius$/.test(name) &&
        /\d(?:px|rem)\b/.test(value) &&
        !value.includes("var(");
      if (rawColor.test(value) || literalRadius)
        found.push(`${name}: ${value}`);
      if (value.includes("!important")) found.push(`${name}: ${value}`);
    }
  }
  return found;
}

it("stylesheets take colors and radii from the design tokens", () => {
  const counts: Record<string, number> = {};
  const added: string[] = [];
  for (const file of filesUnder(srcDir)) {
    const key = relative(srcDir, file).replaceAll("\\", "/");
    const list = findings(readFileSync(file, "utf8"));
    if (list.length > 0) counts[key] = list.length;
    if (list.length > (KNOWN[key] ?? 0))
      added.push(`${key}:\n    ${list.join("\n    ")}`);
  }
  expect(
    counts,
    [
      "A count rose: replace the new value with a token from styles.css,",
      "such as var(--border), var(--radius), var(--radius-panel) or",
      "var(--radius-pill). A count fell: lower it in KNOWN to match.",
      ...added,
    ].join("\n"),
  ).toEqual(KNOWN);
});
