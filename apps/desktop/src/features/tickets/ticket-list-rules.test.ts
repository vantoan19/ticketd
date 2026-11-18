import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// jsdom has no stylesheet cascade or layout, so the rules that make the list's
// motion work are read as text (DESIGN.md section 12).

const read = (...path: string[]) =>
  readFileSync(join(__dirname, "..", "..", ...path), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
const rulesOf = (css: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? "").replace(/\s+/g, " ").trim(),
    body: match[2] ?? "",
  }));

const list = rulesOf(read("features", "tickets", "ticket-list.css"));

it("the Item's own 36px floor is what would hold a leaving row open", () => {
  // The library measures where the row's height can go. With a floor under it,
  // that is the row's own height, and the row keeps its space through the fade
  // and then drops it in one frame.
  const item = rulesOf(read("styles.css")).find(
    (rule) => rule.selector === ".ui-item",
  );
  expect(item?.body).toMatch(/min-height:\s*36px/);
});

it("a ticket row has no height floor, so its space can close with its fade", () => {
  const row = list.find((rule) => rule.selector === ".ticket-rows li");
  expect(row?.body).toMatch(/min-height:\s*0\b/);
});

it("nothing after it gives a row a floor again, touch included", () => {
  const floors = list.filter(
    (rule) =>
      /min-height/.test(rule.body) &&
      /\.ticket-rows( >)? li|\.ticket-rows > li/.test(rule.selector) &&
      rule.selector !== ".ticket-rows li",
  );
  expect(floors).toEqual([]);
});

it("the selection cell still sets a touch row's 44px", () => {
  const touch = list.find(
    (rule) =>
      rule.selector === ".ticket-select" &&
      /min-height:\s*44px/.test(rule.body),
  );
  expect(touch).toBeDefined();
});

it("the check's pop leaves no fill, which would hold the box at full opacity and stop it fading when cleared", () => {
  const pop = rulesOf(
    read("components", "ui", "surface-roles", "tickets-ticket-list.css"),
  ).find(
    (rule) => rule.selector === '.ticket-rows input[type="checkbox"]:checked',
  );
  expect(pop?.body).toMatch(/animation:\s*ticket-check-in/);
  expect(pop?.body).not.toMatch(/\b(both|forwards)\b/);
});

it("the reference column fits the longest reference with a gap before the title, at every width", () => {
  // The list sets --reference-chars to its longest reference; the Geist Mono
  // reference reserves that many `ch` and a gap, and the column grows to it
  // from its 62px floor, the same for every row (#289).
  const reference = list.find(
    (rule) => rule.selector === '.ticket-row > [data-slot="reference"]',
  );
  expect(reference?.body).toMatch(
    /min-width:\s*calc\(var\(--reference-chars, 0\) \* 1ch \+ 6px\)/,
  );
  const templates = list
    .filter((rule) => rule.selector === ".ticket-list .ticket-row")
    .map((rule) => /grid-template-columns:\s*([^;]+)/.exec(rule.body)?.[1]);
  expect(templates).toHaveLength(4);
  for (const template of templates)
    expect(template).toMatch(/^26px minmax\(62px, max-content\) /);
});
