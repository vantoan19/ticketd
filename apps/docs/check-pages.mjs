import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// GitHub Pages serves the uploaded artifact at the root of ticketd.dev.
const base = "/";
const root = new URL("./build/client/", import.meta.url);
const paths = await readdir(root, { recursive: true, withFileTypes: true });
const files = new Set(
  paths
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(fileURLToPath(root), path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    ),
);
const read = (file) => readFile(new URL(file, root), "utf8");
const checked = new Set();

function checkUrl(url, from) {
  assert.ok(url.startsWith(base), `${from} links outside the site: ${url}`);
  const target = decodeURIComponent(url.slice(base.length).split(/[?#]/)[0]);
  if (checked.has(target)) return;
  const index = path.posix.join(target, "index.html");
  assert.ok(
    files.has(index) || files.has(target),
    `${from} links to missing ${url}`,
  );
  checked.add(target);
}

for (const file of files) {
  if (file.endsWith(".html")) {
    const html = await read(file);
    for (const [, url] of html.matchAll(/\b(?:src|href)="(\/(?!\/)[^"]*)"/g))
      checkUrl(url, file);
    for (const [, list] of html.matchAll(/\b(?:image)?srcset="([^"]+)"/gi))
      for (const item of list.split(","))
        checkUrl(item.trim().split(/\s/)[0], file);
  }
  if (
    file.endsWith(".md") ||
    (file.startsWith("llms") && file.endsWith(".txt"))
  ) {
    for (const [, url] of (await read(file)).matchAll(
      /\]\((\/(?!\/)[^)\s]*)\)/g,
    ))
      checkUrl(url, file);
  }
}

for (const route of [
  "index.html",
  "_.data",
  "docs/install/index.html",
  "docs/install.data",
  "download/index.html",
  "changelog/index.html",
  "llms.txt",
  "llms-full.txt",
  "llms.mdx/docs/content.md",
  "api/search",
]) {
  assert.ok((await read(route)).length, `Missing content in ${route}`);
}
assert.match(await read("index.html"), /<h1 id="hero-title">/);
const missing = await read("404.html");
assert.equal(missing, await read("404/index.html"));
assert.doesNotMatch(missing, /<script\b[^>]*type="module"/);
assert.ok(JSON.parse(await read("api/search")));
console.log(`Checked ${checked.size} site URLs and the Pages entry points.`);
