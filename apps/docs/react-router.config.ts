import type { Config } from "@react-router/dev/config";
import { copyFile, glob, readdir, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { createGetUrl, getSlugs } from "fumadocs-core/source";
import { siteBase } from "./site-base.ts";

const getUrl = createGetUrl("/docs");

// A static site: every page, the search index and the Markdown copies are
// written at build time, so any static web server can host the output.
export default {
  appDirectory: "src",
  basename: siteBase,
  ssr: false,
  routeDiscovery: { mode: "initial" },
  async prerender({ getStaticPaths }) {
    const paths = [...getStaticPaths(), "/404"];
    for await (const entry of glob("**/*.mdx", { cwd: "content/docs" })) {
      const slugs = getSlugs(entry);
      paths.push(
        getUrl(slugs),
        `/llms.mdx/docs/${[...slugs, "content.md"].join("/")}`,
      );
    }
    return paths;
  },
  async buildEnd({ reactRouterConfig }) {
    const root = join(reactRouterConfig.buildDirectory, "client");
    if (siteBase !== "/") {
      // React Router prerenders into the URL path. Pages mounts the uploaded
      // artifact there already, alongside the assets emitted by Vite.
      const routes = join(root, siteBase);
      for (const name of await readdir(routes))
        await rename(join(routes, name), join(root, name));
      await rmdir(routes);
    }
    await copyFile(join(root, "404/index.html"), join(root, "404.html"));
  },
} satisfies Config;
