import { readFileSync } from "node:fs";
import { join } from "node:path";

// The motion tokens as styles.css declares them, so tests exercise the real
// values instead of copies. jsdom does not load the stylesheet.
const styles = readFileSync(
  join(__dirname, "..", "styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function declarations(css: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    const [, name = "", value = ""] = m;
    found[name] ??= value.trim();
  }
  return found;
}

/** Every token the light `:root` defines (the first declaration of each name). */
export const rootTokens = declarations(styles);

/** The tokens the reduced-motion media query overrides. */
export const reducedTokens = declarations(
  styles.match(
    /@media \(prefers-reduced-motion: reduce\) \{\s*:root,[^{]*\{([^}]*)\}/,
  )?.[1] ?? "",
);

/** The tokens `<html data-motion="instant">` overrides while keys repeat. */
export const instantTokens = declarations(
  styles.match(/:root\[data-motion="instant"\]\s*\{([^}]*)\}/)?.[1] ?? "",
);

/** Apply tokens to the document, as the stylesheet would. */
export function applyTokens(tokens: Record<string, string>): () => void {
  const root = document.documentElement;
  const names = Object.keys(tokens);
  for (const name of names) root.style.setProperty(name, tokens[name] ?? "");
  return () => {
    for (const name of names) root.style.removeProperty(name);
  };
}

let cold = 0;
/**
 * Empty lib/motion-tokens' cache as a token change would (a change to the
 * root's inline style), so the next read is a real one a test can count.
 */
export function coldTokenCache() {
  document.documentElement.style.setProperty("--test-cold", String(++cold));
}
