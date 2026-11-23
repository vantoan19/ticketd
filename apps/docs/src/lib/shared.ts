import { createGetUrl } from "fumadocs-core/source";
import { siteUrl } from "../links";

export const docsRoute = "/docs";
export const docsContentRoute = "/llms.mdx/docs";

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: {
  slugs: string[];
  locale?: string | undefined;
}) {
  const segments = [...page.slugs, "content.md"];
  return { segments, url: siteUrl(getContentUrl(segments, page.locale)) };
}
