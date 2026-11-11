import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

const server = createFromSource(source, { language: "english" });

// Prerendered: the index is a static file and searching runs in the browser.
export async function loader() {
  return server.staticGET();
}
