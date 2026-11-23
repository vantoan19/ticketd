// @vitest-environment jsdom
import { expect, it } from "vitest";
import { platformDownloads, publishedReleases } from "./releases.server";
import { links } from "../links";

it("keeps drafts, unpublished dates and external asset URLs out of a public release", () => {
  const url = links.releases + "/tag/example";
  const candidate = {
    draft: false,
    prerelease: true,
    published_at: "2026-01-01T00:00:00Z",
    name: "Example",
    tag_name: "example",
    html_url: url,
    body:
      "> [!IMPORTANT]\n> **First launch.** Read the guide.\n\n**Full Changelog**: " +
      links.repository +
      "/compare/base...example",
    assets: [],
  };
  const asset = {
    name: "ticketd.dmg",
    state: "uploaded",
    browser_download_url: links.releases + "/download/example/ticketd.dmg",
  };
  const releases = publishedReleases([
    { ...candidate, draft: true },
    { ...candidate, published_at: null },
    {
      ...candidate,
      assets: [
        asset,
        { ...asset, browser_download_url: "https://example.org/example.dmg" },
      ],
    },
  ]);
  expect(releases).toHaveLength(1);
  expect(releases[0]?.preview).toBe(true);
  expect(releases[0]?.notes).toContain(
    'class="release-alert-title">Important</p>',
  );
  expect(releases[0]?.notes).toContain("<strong>First launch.</strong>");
  expect(releases[0]?.notes).toContain(
    'href="' + links.repository + '/compare/base...example"',
  );
  const { groups } = platformDownloads({ status: "published", releases });
  expect(groups.macos.desktop).toEqual(asset.browser_download_url);
  expect(groups.windows.desktop).toBeNull();
  expect(groups.macos.cli).toBeNull();
});

it("keeps footnotes and their return links inside the release that owns them", () => {
  const releases = publishedReleases(
    ["main/example", "next"].map((tag) => ({
      name: tag,
      tag_name: tag,
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00Z",
      html_url: links.releases + "/tag/" + tag,
      body: "First[^x] and again[^x]. [Guide](guide.md)\n\n[^x]: A footnote.",
      assets: [],
    })),
  );
  const page = new DOMParser().parseFromString(
    releases.map((r) => "<article>" + r.notes + "</article>").join(""),
    "text/html",
  );
  const ids = Array.from(page.querySelectorAll("[id]"), (el) => el.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const [i, article] of Array.from(
    page.querySelectorAll("article"),
  ).entries()) {
    const links = article.querySelectorAll<HTMLAnchorElement>(
      "[data-footnote-ref], [data-footnote-backref]",
    );
    expect(links).toHaveLength(4);
    for (const link of links) {
      const target = link.getAttribute("href")!;
      expect(target.startsWith("#")).toBe(true);
      expect(article.contains(page.getElementById(target.slice(1)))).toBe(true);
      if (link.hasAttribute("data-footnote-ref")) {
        const label = page.getElementById(
          link.getAttribute("aria-describedby")!,
        );
        expect(article.contains(label)).toBe(true);
        expect(label?.textContent).toBe("Footnotes");
      } else expect(link.getAttribute("aria-label")).toBeTruthy();
    }
    expect(
      article
        .querySelector("a:not([data-footnote-ref], [data-footnote-backref])")
        ?.getAttribute("href"),
    ).toBe(new URL("guide.md", releases[i]!.url).href);
  }
});
