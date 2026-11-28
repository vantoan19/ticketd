import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BUY_ME_A_COFFEE_URL, REPOSITORY_URL } from "@/lib/support-links";

const desktop = join(__dirname, "..", "..");
const read = (...path: string[]) =>
  readFileSync(join(desktop, ...path), "utf8");

/** The value of a key in the funding file; empty when the key has none. */
function funding(key: string): string | null {
  const line = read("..", "..", ".github", "FUNDING.yml")
    .split("\n")
    .find((candidate) => candidate.startsWith(`${key}:`));
  return line === undefined
    ? null
    : line
        .slice(key.length + 1)
        .replace(/#.*$/, "")
        .trim();
}

test("GitHub funding and the app point to the same Ko-fi profile", () => {
  const name = funding("ko_fi");
  expect(BUY_ME_A_COFFEE_URL).toBe(name ? `https://ko-fi.com/${name}` : null);
});

test("the packaged app is allowed to open both support links", () => {
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
  const allowed = typeof opener === "object" ? opener.allow : undefined;
  expect(allowed).toContainEqual({ url: REPOSITORY_URL });
  if (BUY_ME_A_COFFEE_URL) {
    expect(allowed).toContainEqual({ url: BUY_ME_A_COFFEE_URL });
  }
});
