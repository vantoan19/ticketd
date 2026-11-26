import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  BUY_ME_A_COFFEE_NAME,
  BUY_ME_A_COFFEE_URL,
  REPOSITORY_URL,
} from "@/lib/support-links";

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

test("the funding file and the app give the same Buy me a coffee name", () => {
  expect(funding("buy_me_a_coffee") ?? "").toBe(BUY_ME_A_COFFEE_NAME);
});

test("the page address is built from that one name, or missing without it", () => {
  expect(BUY_ME_A_COFFEE_URL).toBe(
    BUY_ME_A_COFFEE_NAME
      ? `https://buymeacoffee.com/${BUY_ME_A_COFFEE_NAME}`
      : null,
  );
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
  const patterns = (typeof opener === "object" ? opener.allow : [])!.map(
    ({ url }) =>
      new RegExp(
        `^${url.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
      ),
  );
  const allowed = (url: string) => patterns.some((p) => p.test(url));
  expect(allowed(REPOSITORY_URL)).toBe(true);
  expect(
    allowed(BUY_ME_A_COFFEE_URL ?? "https://buymeacoffee.com/example"),
  ).toBe(true);
});
