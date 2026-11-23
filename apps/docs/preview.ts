import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { siteBase } from "./site-base.ts";

/** Preview the same directory indexes, resources and 404 status as a static host. */
function prerenderedPreview(): Plugin {
  return {
    name: "prerendered-directory-index",
    async configurePreviewServer(server) {
      const root = path.resolve(server.config.root, server.config.build.outDir);
      const prefix = server.config.base.slice(0, -1);
      const pages = new Map<string, string>();
      for await (const file of glob("**/index.html", { cwd: root })) {
        const name = "/" + file.split(path.sep).join("/");
        pages.set(name.slice(0, -"/index.html".length) || "/", name);
      }
      server.middlewares.use((req, res, next) => {
        if (req.url) {
          const url = new URL(req.url, "http://localhost");
          if (prefix && url.pathname === prefix) {
            res.writeHead(301, { Location: server.config.base + url.search });
            return res.end();
          }
          if (!url.pathname.startsWith(server.config.base)) return next();
          const pathname = url.pathname.slice(prefix.length);
          const index = pages.get(pathname.replace(/\/$/, "") || "/");
          if (index) req.url = prefix + index + url.search;
          if (pathname.startsWith("/assets/"))
            res.setHeader(
              "Cache-Control",
              "public, max-age=31536000, immutable",
            );
          if (pathname === "/api/search")
            res.setHeader("Content-Type", "application/json; charset=utf-8");
        }
        next();
      });
      // Vite has already served every existing asset when this handler runs.
      return () => {
        server.middlewares.use(async (req, res) => {
          const page = req.headers.accept?.includes("text/html");
          res.statusCode = 404;
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader(
            "Content-Type",
            page ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
          );
          if (req.method === "HEAD") return res.end();
          res.end(
            page ? await readFile(path.join(root, "404.html")) : "Not found",
          );
        });
      };
    },
  };
}

export default defineConfig({
  base: siteBase,
  appType: "custom",
  build: { outDir: "build/client" },
  plugins: [prerenderedPreview()],
});
