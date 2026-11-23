import { renderToStaticMarkup } from "react-dom/server";
import { Square, SquareCheck } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import type { Root } from "mdast";
import { links } from "../links";

const asset = z.object({
  name: z.string(),
  browser_download_url: z.string().url(),
  state: z.string(),
});
const record = z.object({
  name: z.string().nullable(),
  tag_name: z.string(),
  published_at: z.string().nullable(),
  html_url: z.string().url(),
  body: z.string().nullable().optional(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(asset),
});
export interface Release {
  name: string;
  tag: string;
  date: string;
  url: string;
  preview: boolean;
  notes: string;
  assets: { name: string; url: string }[];
}
export type Feed = { status: "published" | "unavailable"; releases: Release[] };
const api = "https://api.github.com/repos/vantoan19/ticketd/releases";
let cache: { until: number; value: Promise<Feed> } | undefined;

function releaseAlerts() {
  return (root: Root) => {
    for (const block of root.children) {
      if (block.type !== "blockquote") continue;
      const paragraph = block.children[0];
      if (paragraph?.type !== "paragraph") continue;
      const first = paragraph.children[0];
      if (first?.type !== "text") continue;
      const marker =
        /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/.exec(
          first.value,
        );
      const kind = marker?.[1];
      if (!kind) continue;
      first.value = first.value.slice(marker[0].length);
      if (!first.value) paragraph.children.shift();
      if (!paragraph.children.length) block.children.shift();
      block.children.unshift({
        type: "paragraph",
        data: { hProperties: { className: ["release-alert-title"] } },
        children: [
          { type: "text", value: kind[0] + kind.slice(1).toLowerCase() },
        ],
      });
    }
  };
}

function releaseNotes(body: string, base: string, tag: string) {
  // Releases share one changelog page and may reuse the same footnote names.
  const prefix = "release-" + Buffer.from(tag).toString("base64url") + "-";
  const footnoteLabel = prefix + "footnotes";
  return renderToStaticMarkup(
    <Markdown
      skipHtml
      remarkPlugins={[remarkGfm, releaseAlerts]}
      remarkRehypeOptions={{ clobberPrefix: prefix }}
      components={{
        img: ({ alt }) => (alt ? <span>{alt}</span> : null),
        h1: ({ children }) => <h3>{children}</h3>,
        h2: ({ id, className, children }) => (
          <h3
            id={id === "footnote-label" ? footnoteLabel : id}
            className={className}
          >
            {children}
          </h3>
        ),
        input: ({ checked }) => {
          const Mark = checked ? SquareCheck : Square;
          return (
            <>
              <Mark
                className="release-task-mark"
                size={15}
                aria-hidden="true"
              />
              <span className="sr-only">
                {checked ? "Completed task. " : "Open task. "}
              </span>
            </>
          );
        },
        pre: ({ children }) => (
          <pre tabIndex={0} role="region" aria-label="Code block">
            {children}
          </pre>
        ),
        table: ({ children }) => (
          <div
            className="release-table-scroll"
            role="region"
            aria-label="Release notes table"
            tabIndex={0}
          >
            <table>{children}</table>
          </div>
        ),
        a: ({ href, node, children, ...attributes }) => {
          if (!href) return <>{children}</>;
          const url = URL.parse(href, base);
          const footnote =
            node?.properties.dataFootnoteRef !== undefined ||
            node?.properties.dataFootnoteBackref !== undefined;
          return url?.protocol === "https:" ? (
            <a
              {...attributes}
              href={footnote ? href : url.href}
              aria-describedby={
                attributes["aria-describedby"] === "footnote-label"
                  ? footnoteLabel
                  : attributes["aria-describedby"]
              }
            >
              {children}
            </a>
          ) : (
            <>{children}</>
          );
        },
      }}
    >
      {body}
    </Markdown>,
  );
}

export function publishedReleases(data: unknown): Release[] {
  return z
    .array(record)
    .parse(data)
    .flatMap((r) => {
      if (
        r.draft ||
        !r.published_at ||
        !Number.isFinite(Date.parse(r.published_at)) ||
        !r.html_url.startsWith(links.repository + "/releases/tag/")
      )
        return [];
      return [
        {
          name: r.name?.trim() || r.tag_name,
          tag: r.tag_name,
          date: r.published_at,
          url: r.html_url,
          preview: r.prerelease,
          notes: r.body?.trim()
            ? releaseNotes(r.body, r.html_url, r.tag_name)
            : "",
          assets: r.assets
            .filter(
              (a) =>
                a.state === "uploaded" &&
                a.browser_download_url.startsWith(
                  links.repository + "/releases/download/",
                ),
            )
            .map((a) => ({ name: a.name, url: a.browser_download_url })),
        },
      ];
    });
}

async function readFeed(): Promise<Feed> {
  const releases: Release[] = [];
  try {
    for (let page = 1; ; page++) {
      const response = await fetch(api + "?per_page=100&page=" + page, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "ticketd-docs",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok)
        throw Error("GitHub Releases returned " + response.status);
      releases.push(...publishedReleases(await response.json()));
      if (!response.headers.get("link")?.includes('rel="next"')) break;
    }
    releases.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    return { status: "published", releases };
  } catch (error) {
    console.warn(
      "Release information unavailable during site rendering:",
      error instanceof Error ? error.message : "request failed",
    );
    return { status: "unavailable", releases: [] };
  }
}
/** Fetched by the dev server or static build. Visitors never need an API token. */
export function getReleases() {
  if (!cache || Date.now() >= cache.until)
    cache = { until: Date.now() + 300_000, value: readFeed() };
  return cache.value;
}

const platforms = {
  macos: { desktop: /\.dmg$/i, cli: /^ticketd-cli-.*macos-arm64\.tar\.gz$/i },
  ubuntu: { desktop: /\.deb$/i, cli: /^ticketd-cli-.*linux-x86_64\.tar\.gz$/i },
  windows: { desktop: /\.msi$/i, cli: /^ticketd-cli-.*windows-x86_64\.zip$/i },
} as const;
export function platformDownloads(feed: Feed) {
  const current = feed.releases.find((r) => !r.preview) ?? feed.releases[0];
  const assets = current?.assets ?? [];
  const groups = Object.fromEntries(
    Object.entries(platforms).map(([os, type]) => [
      os,
      {
        desktop: assets.find((a) => type.desktop.test(a.name))?.url ?? null,
        cli: assets.find((a) => type.cli.test(a.name))?.url ?? null,
      },
    ]),
  ) as Record<
    keyof typeof platforms,
    { desktop: string | null; cli: string | null }
  >;
  return {
    status: feed.status,
    release: current
      ? { name: current.name, url: current.url, preview: current.preview }
      : null,
    groups,
  };
}
