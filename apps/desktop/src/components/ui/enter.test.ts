import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { enter } from "./enter";

// A page's own entrance is CSS (enter.css), which jsdom does not run, so these
// check the markers it plays from and the rules that decide when it plays.

const css = readFileSync(join(__dirname, "enter.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, selector = "", body = ""]) => ({
    selector: selector.trim().replace(/\s+/g, " "),
    body,
  }),
);

it("marks an element as a step of its page's entrance", () => {
  const props = enter(3);
  expect(props["data-enter"]).toBe("");
  expect(props.style).toEqual({ "--enter-step": 3 });
  expect(enter().style).toEqual({ "--enter-step": 0 });
});

it("plays only on the live page, so the picture of the page that left never replays it", () => {
  const playing = rules.filter((rule) => /animation:/.test(rule.body));
  expect(playing.map((rule) => rule.selector)).toEqual([
    ".view-region [data-own-entrance] [data-enter]",
  ]);
});

it("holds the new page's animations until the old page's picture is gone", () => {
  const hold = rules.find((rule) => rule.body.includes("paused"));
  expect(hold?.selector).toBe(
    ".content-panel:has(> .view-departing) > .view-region [data-own-entrance] *",
  );
  expect(hold?.body).toContain("animation-play-state: paused");
});

it("steps the cascade by whole stagger steps, eight at most", () => {
  const delay = rules.find((rule) => rule.body.includes("animation-delay"));
  expect(delay?.body).toContain(
    "calc(var(--stagger) * min(var(--enter-step, 0), 7))",
  );
});
