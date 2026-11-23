// The project Pages URL has a repository prefix. Local development uses the domain root.
export const siteBase =
  process.env.DOCS_PROJECT_PAGES === "1" ? "/ticketd/" : "/";
