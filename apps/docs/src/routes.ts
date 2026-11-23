import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("download", "routes/download.tsx"),
  route("changelog", "routes/changelog.tsx"),
  route("docs/*", "routes/docs.tsx"),
  route("api/search", "routes/search.ts"),

  // Plain-text copies of the documentation for agents.
  route("llms.txt", "llms/index.ts"),
  route("llms-full.txt", "llms/full.ts"),
  route("llms.mdx/docs/*", "llms/mdx.ts"),

  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
