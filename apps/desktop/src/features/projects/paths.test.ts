import { expect, test } from "vitest";
import { splitPathMiddle, withoutVerbatim } from "./paths";

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

test("a shown path drops the Windows verbatim prefix", () => {
  expect(withoutVerbatim(String.raw`\\?\C:\ws\chats\f4f6`)).toBe(
    String.raw`C:\ws\chats\f4f6`,
  );
  expect(withoutVerbatim("/home/me/ws")).toBe("/home/me/ws");
});
