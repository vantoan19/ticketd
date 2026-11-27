import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { bugReportUrl } from "@/lib/issue-url";

const details = {
  version: "0.2.0 (commit 361b5938)",
  environment: "macOS 15.1 aarch64, desktop app",
};

test("the bug form's own version and environment fields are filled through its address", () => {
  const url = new URL(bugReportUrl(details));
  expect(`${url.origin}${url.pathname}`).toBe(
    "https://github.com/vantoan19/ticketd/issues/new",
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    template: "bug_report.yml",
    ...details,
  });
});

test("the query carries only the form's fields, and awkward text stays one value", () => {
  const url = new URL(
    bugReportUrl({ version: "1 & 2=3", environment: "a/b?c#d %" }),
  );
  expect([...url.searchParams.keys()]).toEqual([
    "template",
    "version",
    "environment",
  ]);
  expect(url.searchParams.get("version")).toBe("1 & 2=3");
  expect(url.searchParams.get("environment")).toBe("a/b?c#d %");
  expect(url.hash).toBe("");
});

test("the form defines the fields the address fills", () => {
  const form = readFileSync(
    new URL(
      "../../../../.github/ISSUE_TEMPLATE/bug_report.yml",
      import.meta.url,
    ),
    "utf8",
  );
  expect(form).toMatch(/- type: input\s+id: version\b/);
  expect(form).toMatch(/- type: input\s+id: environment\b/);
});

/** The opener's scope is a glob where `*` matches anything, `/` included. */
function inScope(pattern: string, url: string) {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(url);
}

test("the address passes the opener capability scope", () => {
  const capability = JSON.parse(
    readFileSync(
      new URL("../../src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    ),
  ) as {
    permissions: Array<
      string | { identifier: string; allow?: { url: string }[] }
    >;
  };
  const opener = capability.permissions.find(
    (permission) =>
      typeof permission !== "string" &&
      permission.identifier === "opener:allow-open-url",
  );
  const allowed = (typeof opener === "object" ? opener.allow : undefined) ?? [];
  const url = bugReportUrl(details);
  expect(allowed.some(({ url: pattern }) => inScope(pattern, url))).toBe(true);
});
