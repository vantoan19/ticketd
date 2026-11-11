import { createGetUrl } from "fumadocs-core/source";

export const docsRoute = "/docs";
export const docsContentRoute = "/llms.mdx/docs";

export const gitConfig = {
  user: "vantoan19",
  repo: "ticketd",
  branch: "main",
  contentDir: "apps/docs/content/docs",
};

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: {
  slugs: string[];
  locale?: string | undefined;
}) {
  const segments = [...page.slugs, "content.md"];
  return { segments, url: getContentUrl(segments, page.locale) };
}
