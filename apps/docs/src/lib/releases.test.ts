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
