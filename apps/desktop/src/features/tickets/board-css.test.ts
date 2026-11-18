import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// jsdom lays nothing out, so the rules that keep the board's cards honest are
// checked in the stylesheets themselves.
const css = (...path: string[]) =>
  readFileSync(join(__dirname, ...path), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (source: string, selector: string) => {
  const at = source.indexOf(`${selector} {`);
  return at < 0 ? "" : source.slice(at, source.indexOf("}", at));
};

it("a card does not shrink: an entering one (overflow: hidden) would sit at 0 height in a full column", () => {
  expect(rule(css("ticket-board.css"), ".board-card-container")).toMatch(
    /flex-shrink:\s*0/,
  );
});

it("the loading note waits out the loading delay, then fades in", () => {
  const note = rule(
    css(
      "..",
      "..",
      "components",
      "ui",
      "surface-roles",
      "tickets-ticket-board.css",
    ),
    ".board-column-note[data-loading]",
  );
  expect(note).toMatch(/animation:[^;]*var\(--dur-loading-delay\)[^;]*both/);
});
