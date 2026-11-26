import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const desktop = join(__dirname, "..", "..", "..");
const read = (...path: string[]) =>
  readFileSync(join(desktop, ...path), "utf8");

test("the packaged app may open every agent's help page, which an opened agent offers as Get <agent>", () => {
  const capability = JSON.parse(
    read("src-tauri", "capabilities", "default.json"),
  ) as {
    permissions: (string | { identifier: string; allow?: { url: string }[] })[];
  };
  const opener = capability.permissions.find(
    (permission) =>
      typeof permission === "object" &&
      permission.identifier === "opener:allow-open-url",
  );
  const patterns = (typeof opener === "object" ? opener.allow : [])!.map(
    ({ url }) =>
      new RegExp(
        `^${url.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
      ),
  );
  // Each descriptor's help_url, as written in the core's harness table.
  const urls = [
    ...read(
      "..",
      "..",
      "crates",
      "ticketd-core",
      "src",
      "harnesses.rs",
    ).matchAll(/help_url: "(https:[^"]+)"/g),
  ].map((match) => match[1]!);
  expect(urls.length).toBeGreaterThanOrEqual(3);
  for (const url of urls)
    expect(
      patterns.some((pattern) => pattern.test(url)),
      url,
    ).toBe(true);
});
