import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { createServer } from "vite";
import {
  featureRef,
  featuredTicket,
  planName,
  report,
} from "../src/demo/workspace.ts";
import { measureRegions } from "./regions.mjs";
import { seedWorkspace } from "./seed.mjs";

const site = fileURLToPath(new URL("../", import.meta.url)),
  repo = path.resolve(site, "../..");
const desktop = path.join(repo, "apps/desktop"),
  target = path.join(repo, "target");
const cli = path.join(
  target,
  "debug",
  process.platform === "win32" ? "ticketd.exe" : "ticketd",
);
const output = path.join(site, "screens");
const boardCard = '[data-board-reference="' + featureRef + '"]';
await mkdir(target, { recursive: true });
const fixture = await mkdtemp(path.join(target, "site-capture-"));
const generated = path.join(fixture, "images");
const size = { width: 1280, height: 740 };
// Capture the same native window at a desktop and a narrow desktop width. The
// Plan keeps two neighbouring flow lanes visible. The other narrow windows use
// the app's minimum width, so its panes and text wrap as they do in the product.
async function photograph(page, name, theme, compact, previous) {
  const viewport = compact
    ? { width: name === "plan" ? 640 : 480, height: size.height }
    : size;
  if (compact) {
    await page.setViewportSize(viewport);
    if (name === "board" || name === "done")
      await page.locator(boardCard).scrollIntoViewIfNeeded();
  }
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const regions = await measureRegions(name, page, viewport);
  if (previous) {
    for (const [id, target] of Object.entries(regions)) {
      if (
        Object.keys(target).some(
          (key) => Math.abs(target[key] - previous[id][key]) > 2,
        )
      )
        throw Error("Themes disagree on the bounds of " + name + "/" + id);
    }
  }
  const pixels = await page.screenshot({
    animations: "disabled",
    scale: "device",
  });
  const widths = compact
    ? [viewport.width, viewport.width * 2]
    : [640, 1280, 2560];
  for (const width of widths) {
    const file =
      [name, ...(compact ? ["compact"] : []), theme, width].join("-") + ".webp";
    await sharp(pixels)
      .resize({ width })
      .webp(
        width === viewport.width * 2
          ? { lossless: true, effort: 5 }
          : { quality: 90, effort: 5, smartSubsample: true },
      )
      .toFile(path.join(generated, file));
  }
  return { viewport, regions };
}
let server, browser;
try {
  const seeds = seedWorkspace(fixture, cli);
  // Keep relative times identical across both themes, including on slower machines.
  const asOf = new Date();
  server = await createServer({
    root: desktop,
    configFile: path.join(desktop, "vite.config.ts"),
    logLevel: "warn",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [
      {
        name: "ticketd-capture-entry",
        transformIndexHtml: {
          order: "pre",
          handler(html) {
            return html
              .replace("</head>", '<link rel="icon" href="data:,"></head>')
              .replace(
                'src="/src/main.tsx"',
                'src="/@fs/' +
                  path
                    .join(site, "capture", "entry.tsx")
                    .replaceAll("\\", "/") +
                  '"',
              );
          },
        },
      },
    ],
  });
  await server.listen();
  const origin = "http://127.0.0.1:" + server.httpServer.address().port;
  browser = await chromium.launch(
    process.env.CAPTURE_BROWSER_CHANNEL
      ? { channel: process.env.CAPTURE_BROWSER_CHANNEL }
      : {},
  );
  await mkdir(generated);
  const regions = {};
  const compact = {};
  for (const theme of ["light", "dark"]) {
    for (const [name, seed] of [
      ["plan", seeds.planned],
      ["context", seeds.planned],
      ["board", seeds.working],
      ["done", seeds.done],
      ["ticket", seeds.reported],
      ["evidence", seeds.review],
      ["inbox", seeds.review],
      ["rules", seeds.review],
      ["rules-triage", seeds.review],
      ["rules-weekly", seeds.review],
    ]) {
      const context = await browser.newContext({
        viewport: size,
        deviceScaleFactor: 2,
        colorScheme: theme,
        reducedMotion: "reduce",
        timezoneId: "UTC",
        locale: "en-US",
        serviceWorkers: "block",
      });
      try {
        await context.addInitScript(
          ({ theme, seed, name }) => {
            localStorage.setItem(
              "ticketd.preferences",
              JSON.stringify({ theme }),
            );
            window.captureWorkspace = seed;
            window.captureAutomations = name.startsWith("rules");
          },
          { theme, seed, name },
        );
        const page = await context.newPage();
        await page.clock.setFixedTime(asOf);
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text());
        });
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(origin);
        await page.getByRole("navigation", { name: "Plan scopes" }).waitFor();
        if (
          ["plan", "context", "board", "ticket", "done", "evidence"].includes(
            name,
          )
        ) {
          await page
            .getByRole("navigation", { name: "Plan scopes" })
            .getByRole("button", { name: planName })
            .click();
          await page
            .getByRole("radiogroup", { name: "Plan view" })
            .getByRole("radio", { name: name === "plan" ? "Flow" : "Board" })
            .click();
          if (name === "plan")
            await page
              .getByRole("button", {
                name: featureRef + " " + featuredTicket.title,
              })
              .first()
              .waitFor();
          else await page.locator(boardCard).waitFor();
          if (name === "ticket" || name === "context" || name === "evidence") {
            await page.locator(boardCard).click();
            await page
              .getByText(featuredTicket.body, { exact: true })
              .first()
              .waitFor();
            if (name === "evidence") {
              await page
                .getByText("Boundary tests", { exact: true })
                .first()
                .scrollIntoViewIfNeeded();
            }
            if (name === "ticket")
              await page.getByText(report, { exact: false }).first().waitFor();
          }
        } else if (name === "inbox") {
          await page
            .getByRole("navigation")
            .getByRole("button", { name: /^Inbox/ })
            .first()
            .click();
          await page
            .getByRole("heading", { name: /^Needs you/ })
            .first()
            .waitFor();
        } else {
          await page
            .getByRole("navigation")
            .getByRole("button", { name: /^Automations/ })
            .first()
            .click();
          const rule =
            name === "rules"
              ? "Review notification"
              : name === "rules-triage"
                ? "Triage security tickets"
                : "Weekly review";
          await page
            .getByRole("button", { name: new RegExp(rule) })
            .first()
            .click();
          await page
            .getByRole("heading", { name: rule, exact: true })
            .waitFor();
        }
        const wide = await photograph(page, name, theme, false, regions[name]);
        const narrow = await photograph(
          page,
          name,
          theme,
          true,
          compact[name]?.regions,
        );
        if (theme === "light") {
          regions[name] = wide.regions;
          compact[name] = narrow;
        }
        if (errors.length) throw Error(errors.join("\n"));
        console.log("Captured", name, theme);
      } catch (error) {
        const page = context.pages()[0];
        console.error(
          (await page?.locator("body").innerText())?.slice(0, 2000),
        );
        throw error;
      } finally {
        await context.close();
      }
    }
  }
  await writeFile(
    path.join(generated, "regions.json"),
    JSON.stringify({ viewport: size, screens: regions, compact }, null, 2) +
      "\n",
  );
  // Publish a complete set only after every screen in both themes succeeded.
  await mkdir(path.dirname(output), { recursive: true });
  const previous = path.join(fixture, "previous");
  let hadPrevious = false;
  try {
    await rename(output, previous);
    hadPrevious = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(generated, output);
  } catch (error) {
    if (hadPrevious) await rename(previous, output);
    throw error;
  }
} finally {
  await browser?.close();
  await server?.close();
  await rm(fixture, { recursive: true, force: true });
}
