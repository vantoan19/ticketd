import { links, siteUrl } from "../links";
import { llms, loader } from "fumadocs-core/source";
import { renderPlaceholder } from "fumadocs-core/mdx-plugins/remark-llms.runtime";
import { docs } from "../../.source/server";
import { docsRoute, getPageMarkdownUrl } from "./shared";

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: docsRoute,
});

export const docsLlms = llms(source, {
  renderUrl(item, context) {
    const page = source.getNodePage(item, context.lang);
    return page ? getPageMarkdownUrl(page).url : siteUrl(item.url);
  },
  async renderPage(page) {
    const content = await renderPlaceholder(
      await page.data.getText("processed"),
      {
        Card: ({ attributes, children }) =>
          `- [${attributes.title}](${attributes.href}) ${children.trim()}`,
        Callout: ({ attributes, children }) => {
          const text = [
            attributes.title && `**${attributes.title}**`,
            children.trim(),
          ]
            .filter(Boolean)
            .join("\n\n");
          return text
            .split("\n")
            .map((line) => (line ? "> " + line : ">"))
            .join("\n");
        },
      },
    );
    const markdown = content
      .replaceAll(
        "](docs/adr/",
        "](" + links.repository + "/blob/main/docs/adr/",
      )
      .replace(
        /\]\((\/(?!\/)[^)\s]*)\)/g,
        (_, url: string) => `](${siteUrl(url)})`,
      );
    return `# ${page.data.title} (${siteUrl(page.url)})\n\n${markdown}`;
  },
});
