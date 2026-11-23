import type { Route } from "./+types/mdx";
import { docsLlms, source } from "@/lib/source.server";

export async function loader({ params }: Route.LoaderArgs) {
  const slugs = params["*"].split("/").filter((v) => v.length > 0);
  // The last segment is the appended "content.md".
  if (slugs.pop() !== "content.md")
    return new Response("not found", { status: 404 });
  const page = source.getPage(slugs);
  if (!page) return new Response("not found", { status: 404 });
  return new Response(await docsLlms.page(page), {
    headers: { "Content-Type": "text/markdown" },
  });
}
