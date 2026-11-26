import { expect, test } from "vitest";
import { updateClampLines } from "./update-clamp";

const link = "[run.log](ticketd://attachment/workspace/a1)";
const picture = "![Dashboard](ticketd://attachment/workspace/p1)";

test("plain text clamps at eight lines", () => {
  expect(updateClampLines("Partial captures now refund the amount.")).toBe(8);
});

test("a lone attachment link, which is a card, clamps at forty", () => {
  expect(updateClampLines(`See\n\n${link}\n`)).toBe(40);
  expect(updateClampLines(`See ${link} for details`)).toBe(8);
});

test("a picture adds its own 240px of height to the allowance", () => {
  expect(updateClampLines(`Before the fix:\n\n${picture}\n`)).toBe(22);
  expect(updateClampLines(`${picture}\n\n${picture}`)).toBe(36);
});

test("a picture and a card row add up", () => {
  expect(updateClampLines(`${picture}\n\n${link}`)).toBe(54);
});
