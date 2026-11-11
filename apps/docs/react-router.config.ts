import type { Config } from "@react-router/dev/config";
import { glob } from "node:fs/promises";
import { createGetUrl, getSlugs } from "fumadocs-core/source";

const getUrl = createGetUrl("/docs");

// A static site: every page, the search index and the Markdown copies are
// written at build time, so any static web server can host the output.
export default {
  appDirectory: "src",
  ssr: false,
  async prerender({ getStaticPaths }) {
    const paths = [...getStaticPaths()];
    for await (const entry of glob("**/*.mdx", { cwd: "content/docs" })) {
      const slugs = getSlugs(entry);
      paths.push(
        getUrl(slugs),
        `/llms.mdx/docs/${[...slugs, "content.md"].join("/")}`,
      );
    }
    return paths;
  },
} satisfies Config;
