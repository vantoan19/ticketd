import { expect, test } from "vitest";
import { scopeIsPath, splitPath } from "@/features/chats/files";
import { tailLength } from "@/features/chats/FileName";

test("a path splits into its folder and its name", () => {
  expect(splitPath("gen/icons.py")).toEqual({
    folder: "gen/",
    name: "icons.py",
  });
  expect(splitPath("README.md")).toEqual({ folder: "", name: "README.md" });
  expect(splitPath("~/notes/today.md")).toEqual({
    folder: "~/notes/",
    name: "today.md",
  });
  // A folder reads as its own last part.
  expect(splitPath("src/auth/")).toEqual({ folder: "src/", name: "auth" });
});

test("a long path is cut from its start, and its name is never cut", () => {
  const long =
    "/private/tmp/claude-501/-Users-someone-Projects/scratchpad/content.py";
  const { folder, name } = splitPath(long);
  expect(name).toBe("content.py");
  expect(folder.startsWith("…/")).toBe(true);
  expect(folder.endsWith("scratchpad/")).toBe(true);
  expect((folder + name).length).toBeLessThanOrEqual(48);
  // A single folder part that cannot fit leaves only the ellipsis.
  expect(splitPath(`${"x".repeat(60)}/a.ts`)).toEqual({
    folder: "…/",
    name: "a.ts",
  });
  // A short path is left as it is.
  expect(splitPath("src/a/b/c.ts", 48)).toEqual({
    folder: "src/a/b/",
    name: "c.ts",
  });
});

test("a glob is a pattern, not a place", () => {
  expect(scopeIsPath("src/auth")).toBe(true);
  expect(scopeIsPath("src/**/*.ts")).toBe(false);
});

test("a file name keeps its extension as the tail that never gives way", () => {
  expect(tailLength("rate-limit-configuration-loader.test.ts")).toBe(3);
  expect(tailLength("a-very-long-component.test.tsx")).toBe(4);
  // No extension, or a dotfile: the last six characters.
  expect(tailLength("Makefile-with-a-long-name")).toBe(6);
  expect(tailLength(".gitignore")).toBe(6);
  // A long extension is cut to twelve.
  expect(tailLength("archive.verylongextension-name")).toBe(12);
});
