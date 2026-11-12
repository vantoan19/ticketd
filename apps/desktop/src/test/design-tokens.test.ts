import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

// Guards DESIGN.md section 11: stylesheets take colors and radii from the
// tokens in styles.css and never override with !important. Findings that
// predate this check are counted per file in KNOWN; a count may only fall.

const srcDir = join(__dirname, "..");

// Every remaining entry has its reason in the stylesheet. The !important ones
// beat the panel library's inline flex and display on the ticket workspace, or
// implement reduced motion. The #000 of a mask is alpha, not a color.
const KNOWN: Record<string, number> = {
  "features/documents/context-graph.css": 2,
  "features/tickets/ticket-board.css": 4,
  "styles.css": 11,
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
      // A literal fallback, var(--radius-md, 8px), hides a raw value inside a token.
      const literalFallback = /var[(][^)]*, *[^)]*(?:#[0-9a-f]{3,8}|[0-9]px)/i;
      if (rawColor.test(value) || literalRadius || literalFallback.test(value))
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

it("no custom property is defined in terms of itself", () => {
  // A self-reference is invalid at computed-value time, so every use of the
  // token silently computes to its initial value (border-radius: 0).
  const cyclic: string[] = [];
  for (const file of filesUnder(srcDir)) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]*)/g)) {
      const [, name = "", value = ""] = m;
      if (new RegExp("var[(] *" + name + " *[,)]").test(value))
        cyclic.push(`${relative(srcDir, file)}: ${name}: ${value.trim()}`);
    }
  }
  expect(cyclic).toEqual([]);
});

it("the radius tokens match DESIGN.md section 4", () => {
  const css = readFileSync(join(srcDir, "styles.css"), "utf8");
  // The light token block: :root plus any data-theme-preview subtree.
  const root = css.slice(
    0,
    css.indexOf("}", css.indexOf("[data-theme-preview] {")),
  );
  const radius = (name: string) =>
    new RegExp(name + ": *([^;]+);").exec(root)?.[1]?.trim();
  expect(radius("--radius")).toBe("6px");
  expect(radius("--radius-segment")).toBe("4px");
  expect(radius("--radius-panel")).toBe("12px");
  expect(radius("--radius-pill")).toBe("9999px");
});

it("feature stylesheets do not restyle a shared part's colour, type or fill", () => {
  // docs/agents/ui.md step 1: a change to colour, type, size or shape of a
  // shared part is a variant on the part, not a selector in a feature file.
  const restyled: string[] = [];
  for (const file of filesUnder(srcDir)) {
    const key = relative(srcDir, file).replaceAll("\\", "/");
    if (key === "styles.css") continue;
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (rule[1] ?? "").trim();
      const last = selector.split(/[\s>+~,]+/).at(-1) ?? "";
      if (
        /\[data-(?:slot="(?:badge|section-header-actions|section-header-caption)"|variant="(?:source|tag|doc)")\]/.test(
          last,
        ) &&
        /(?:^|[;\s])(?:background|color|font-size|line-height)\s*:/.test(
          rule[2] ?? "",
        )
      )
        restyled.push(`${key}: ${selector}`);
    }
  }
  expect(restyled).toEqual([]);
});

it("the utility radii that shadcn parts use resolve to the one --radius", () => {
  // `rounded-md` and `rounded-lg` come from the Tailwind theme; a literal there
  // (Tailwind's own lg is 8px) puts an 8px corner beside the 6px of everything else.
  const css = readFileSync(join(srcDir, "styles.css"), "utf8");
  const theme = css.slice(css.indexOf("@theme inline"));
  for (const name of ["--radius-md", "--radius-lg"])
    expect(
      new RegExp(name + ": *([^;]+);").exec(theme)?.[1]?.trim(),
      name,
    ).toBe("var(--radius)");
});
