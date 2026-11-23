import type { ReactNode } from "react";
import type { Route } from "./+types/docs";
import { RootProvider } from "fumadocs-ui/provider/react-router";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { Header as DocsHeader } from "fumadocs-ui/layouts/docs/slots/header";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { flattenTree } from "fumadocs-core/page-tree";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import collections from "../../.source/browser";
import { source } from "../lib/source.server";
import { getPageMarkdownUrl } from "../lib/shared";
import { siteUrl } from "../links";
import { baseOptions } from "../lib/layout.shared";
import { getMDXComponents } from "../components/mdx";
import SearchDialog from "../components/search";
import { CopyMarkdown } from "../components/CopyMarkdown";
import { docsSidebar } from "../components/DocsSidebar";
import { useProgressiveControls } from "../components/useHydrated";
import "./docs.css";

export async function loader({ params }: Route.LoaderArgs) {
  const slugs = params["*"].split("/").filter(Boolean);
  const page = source.getPage(slugs);
  if (!page) throw new Response("Not found", { status: 404 });
  return {
    path: page.path,
    markdownUrl: getPageMarkdownUrl(page).url,
    pageTree: await source.serializePageTree(source.getPageTree()),
  };
}

const components = getMDXComponents();
function DocumentationNav() {
  return (
    <nav className="doc-subnav" aria-label="Documentation">
      <DocsHeader />
    </nav>
  );
}

const articles = collections.docs.createClientLoader<{
  markdownUrl: string;
  navigation: ReactNode;
}>({
  component({ frontmatter, toc, default: Body }, { markdownUrl, navigation }) {
    return (
      <DocsPage
        toc={toc}
        tableOfContent={{
          container: { role: "navigation", "aria-labelledby": "toc-title" },
        }}
        tableOfContentPopover={{
          container: { role: "navigation", "aria-label": "Article sections" },
          trigger: {
            "aria-description": "Show or hide the sections in this article.",
          },
        }}
      >
        <title>{frontmatter.title + " · ticketd"}</title>
        <meta name="description" content={frontmatter.description} />
        <link rel="alternate" type="text/markdown" href={markdownUrl} />
        <DocsTitle className="doc-heading" id="main-content" tabIndex={-1}>
          {frontmatter.title}
        </DocsTitle>
        <DocsDescription className="doc-dek">
          {frontmatter.description}
        </DocsDescription>
        <div className="doc-actions">
          {navigation ?? <CopyMarkdown key={markdownUrl} url={markdownUrl} />}
          <a href={markdownUrl}>Read as Markdown ↗</a>
        </div>
        <DocsBody className="doc-prose">
          <Body components={components} />
        </DocsBody>
      </DocsPage>
    );
  },
});

export default function Page({ loaderData }: Route.ComponentProps) {
  const { pageTree, path, markdownUrl } = useFumadocsLoader(loaderData);
  const { interactive, nativeProps } = useProgressiveControls();
  const navigation = interactive ? null : (
    <details
      className="static-doc-nav"
      {...nativeProps}
      suppressHydrationWarning
    >
      <summary>All documentation</summary>
      <ul>
        {flattenTree(pageTree.children).map((item) => (
          <li key={item.url}>
            <a href={siteUrl(item.url)}>{item.name}</a>
          </li>
        ))}
      </ul>
    </details>
  );
  const content = articles.useContent(path, { markdownUrl, navigation });
  return (
    <RootProvider theme={{ enabled: false }} search={{ SearchDialog }}>
      <DocsLayout
        {...baseOptions()}
        tree={pageTree}
        slots={{ header: DocumentationNav, sidebar: docsSidebar }}
      >
        {content}
      </DocsLayout>
    </RootProvider>
  );
}
