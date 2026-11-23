export const links = {
  repository: "https://github.com/vantoan19/ticketd",
  releases: "https://github.com/vantoan19/ticketd/releases",
  license: "https://github.com/vantoan19/ticketd/blob/main/LICENSE",
  development:
    "https://github.com/vantoan19/ticketd/blob/main/docs/development.md",
} as const;

/** Absolute URL path for ordinary anchors, static assets and text resources.
 * React Router links already apply the configured basename. */
export function siteUrl(path: string) {
  return path.startsWith("/") && !path.startsWith("//")
    ? import.meta.env.BASE_URL.slice(0, -1) + path
    : path;
}
