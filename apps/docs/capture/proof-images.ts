import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import sharp from "sharp";
import type { Plugin } from "vite";
import { frameFor } from "../src/journey/framing.ts";
import {
  captureFile,
  viewImages,
  type Crop,
} from "../src/journey/image-crop.ts";
import { viewportOf } from "../src/journey/captures.ts";
import { stops } from "../src/journey/stops.ts";

interface ImageJob {
  source: string;
  crop: Crop;
  width: number;
}

/** Only the visible part of each desktop capture crosses the wire in the story.
 * The browser still has the entire 2x screen available when someone opens it. */
export function proofImages(): Plugin {
  const directory = new URL("../screens/", import.meta.url);
  const jobs = new Map<string, ImageJob>();
  for (const feature of stops.flatMap((stop) => stop.features)) {
    for (const theme of ["light", "dark"] as const) {
      for (const phone of [false, true]) {
        const width = viewportOf(feature.screen, phone).width * 2;
        const source = fileURLToPath(
          new URL(captureFile(feature.screen, theme, width, phone), directory),
        );
        for (const { url, width, crop } of viewImages(
          feature.screen,
          theme,
          frameFor(feature, phone),
        )) {
          jobs.set(url, { source, width, crop });
        }
      }
    }
  }
  async function render(job: ImageJob) {
    // Refreshed captures keep their filenames. Read their current contents so
    // a long-running dev server does not crop a cached version of the file.
    return sharp(await readFile(job.source))
      .extract(job.crop)
      .resize({ width: job.width })
      .webp({ lossless: true, effort: 4 })
      .toBuffer();
  }
  return {
    name: "ticketd-desktop-image-views",
    async generateBundle() {
      if (this.environment.config.consumer !== "client") return;
      for (const name of await readdir(directory)) {
        if (name.endsWith(".webp"))
          this.emitFile({
            type: "asset",
            fileName: "screens/" + name,
            source: await readFile(new URL(name, directory)),
          });
      }
      for (const [url, job] of jobs) {
        this.emitFile({
          type: "asset",
          fileName: url.slice(1),
          source: await render(job),
        });
      }
    },
    configureServer(server) {
      // The capture script publishes by replacing the directory. Some watchers
      // report only the new directory. Pass the bounds change through Vite so
      // its crop URLs, the rendered pins and the open page refresh together.
      const screens = resolve(fileURLToPath(directory));
      const bounds = fileURLToPath(new URL("regions.json", directory));
      let refresh: ReturnType<typeof setTimeout> | undefined;
      server.watcher.on("addDir", (added) => {
        if (resolve(added) !== screens) return;
        clearTimeout(refresh);
        refresh = setTimeout(() => server.watcher.emit("change", bounds), 80);
      });
      server.httpServer?.once("close", () => clearTimeout(refresh));
      server.middlewares.use(server.config.base, async (req, res, next) => {
        const job = jobs.get(req.url?.split("?", 1)[0] ?? "");
        if (!job) return next();
        try {
          res.setHeader("Content-Type", "image/webp");
          res.setHeader("Cache-Control", "no-cache");
          res.end(req.method === "HEAD" ? undefined : await render(job));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
