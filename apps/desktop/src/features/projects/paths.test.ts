import { expect, test } from "vitest";
import { splitPathMiddle } from "./paths";

test("a POSIX path keeps its root and last two folders and shrinks the rest", () => {
  expect(splitPathMiddle("/var/lib/data/repos/api/src")).toEqual({
    lead: "/var/",
    middle: "lib/data/repos/",
    tail: "api/src",
  });
});

test("a Windows path shrinks between its drive and last two folders", () => {
  expect(splitPathMiddle("\\\\?\\C:\\Windows\\Temp\\run\\repos\\api")).toEqual({
    lead: "C:\\",
    middle: "Windows\\Temp\\run\\",
    tail: "repos\\api",
  });
});
