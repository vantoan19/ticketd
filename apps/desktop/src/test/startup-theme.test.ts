import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

// The blocking script must work before React and its dependencies load, under
// the desktop's script-src 'self' policy (no inline script allowance).
const desktop = join(__dirname, "..", "..");
const bootstrap = readFileSync(join(desktop, "public", "theme.js"), "utf8");

it("starts the webview in the stored theme before loading application modules", () => {
  for (const [stored, systemDark, expected] of [
    ['{"theme":"dark"}', false, "dark"],
    ['{"theme":"light"}', true, "light"],
    ['{"theme":"system"}', true, "dark"],
    ["corrupt", true, "dark"],
    [null, false, "light"],
  ] as const) {
    const root = {
      dataset: { theme: "" },
      classList: { toggle() {} },
      style: { colorScheme: "" },
    };
    runInNewContext(bootstrap, {
      localStorage: { getItem: () => stored },
      matchMedia: () => ({ matches: systemDark }),
      document: { documentElement: root },
    });
    expect(root.dataset.theme).toBe(expected);
    expect(root.style.colorScheme).toBe(expected);
  }
  const html = readFileSync(join(desktop, "index.html"), "utf8");
  expect(html.indexOf('src="/theme.js"')).toBeLessThan(
    html.indexOf('type="module"'),
  );
  const config = JSON.parse(
    readFileSync(join(desktop, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  expect(config.app.windows[0].visible).toBe(false);
});
