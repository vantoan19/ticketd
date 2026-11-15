// @vitest-environment jsdom
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

it("a module-load failure has a visible restart step when the native watchdog reveals it", () => {
  const html = readFileSync(join(desktop, "index.html"), "utf8");
  const page = new DOMParser().parseFromString(html, "text/html");
  const failure = page.getElementById("startup-failure");
  expect(failure).not.toBeNull();
  expect(failure?.hidden).toBe(true);
  const fallback = readFileSync(
    join(desktop, "public", "startup-fallback.js"),
    "utf8",
  );
  page.documentElement.dataset.theme = "dark";
  runInNewContext(fallback, { document: page });
  expect(failure?.hidden).toBe(false);
  expect(failure?.style.backgroundColor).toBe("rgb(10, 10, 10)");
  expect(failure?.style.color).toBe("rgb(237, 237, 237)");
  expect(failure?.style.position).toBe("fixed");
  expect(failure?.style.inset).toBe("0px");
  expect(failure?.textContent).toContain("Quit and reopen ticketd");
  page.documentElement.dataset.theme = "light";
  runInNewContext(fallback, { document: page });
  expect(failure?.style.backgroundColor).toBe("rgb(250, 250, 250)");
  expect(failure?.style.color).toBe("rgb(23, 23, 23)");

  // React replaces the initial content. A stalled native paint must reveal the
  // usable application without replacing it with a spurious startup error.
  const root = page.getElementById("root");
  if (root) root.innerHTML = "<main><h1>All tickets</h1></main>";
  runInNewContext(fallback, { document: page });
  expect(root?.textContent).toBe("All tickets");
});
