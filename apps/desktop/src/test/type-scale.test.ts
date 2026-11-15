import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Guards the type scale in DESIGN.md section 3: 12 caption, 14 interface,
// 13 mono code, 16 long-form reading, 24 titles, 32 spacious section titles.

const srcDir = join(__dirname, "..");

function filesUnder(dir: string, extension: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path, extension);
    return path.endsWith(extension) && !path.includes(".test.") ? [path] : [];
  });
}

const ALLOWED_SIZES = new Set([
  "12px",
  "14px",
  "16px",
  "24px",
  "32px",
  "inherit",
  "0", // hides a label so only the icon shows
]);

describe("type scale", () => {
  it("uses only scale font sizes in CSS", () => {
    const offenders: string[] = [];
    for (const file of filesUnder(srcDir, ".css")) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = rule[1] ?? "";
        const body = rule[2] ?? "";
        const size = body.match(/font-size:\s*([^;]+);/)?.[1]?.trim();
        if (
          !size ||
          size.startsWith("var(--text-") ||
          ALLOWED_SIZES.has(size)
        ) {
          continue;
        }
        const isCode =
          size === "13px" &&
          (/font-family:[^;]*mono/.test(body) ||
            /\b(code|pre)\b/.test(selector));
        if (!isCode) {
          offenders.push(`${file}: ${selector.trim()} { font-size: ${size} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("defines the scale tokens with the DESIGN.md sizes", () => {
    const css = readFileSync(join(srcDir, "styles.css"), "utf8");
    for (const token of [
      "--text-caption: 12px",
      "--text-ui: 14px",
      "--text-code: 13px",
      "--text-reading: 16px",
      "--text-reading-line: 26px",
      "--text-doc: 15px",
      "--text-doc-line: 24px",
      "--text-doc-title: 28px",
      "--text-doc-title-line: 36px",
      "--text-section-line: 40px",
      "--text-title: 24px",
      "--text-section: 32px",
    ]) {
      expect(css).toContain(token);
    }
  });

  it("avoids off-scale Tailwind text sizes in components", () => {
    const offenders: string[] = [];
    for (const file of filesUnder(srcDir, ".tsx")) {
      const source = readFileSync(file, "utf8");
      const pattern =
        /(?<![\w-])(?:[\w[\]=-]+:)*text-(base|lg|xl|[3-9]xl)(?![\w-])/g;
      for (const match of source.matchAll(pattern)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
