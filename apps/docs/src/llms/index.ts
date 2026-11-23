import { docsLlms } from "@/lib/source.server";

export async function loader() {
  return new Response(await docsLlms.index());
}
