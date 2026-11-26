import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// jsdom has no layout: these read the stylesheet for the rules the reader's geometry rests on.
const css = readFileSync(join(__dirname, "documents.css"), "utf8");
/** The bodies of every rule that has exactly this selector, one after another. */
const rule = (selector: string) => {
  const bodies: string[] = [];
  for (let at = css.indexOf(`${selector} {`); at >= 0;) {
    bodies.push(css.slice(at, css.indexOf("}", at)));
    at = css.indexOf(`${selector} {`, at + 1);
  }
  expect(bodies.length, `${selector} has a rule`).toBeGreaterThan(0);
  return bodies.join("\n");
};

it("gives the reader's scrollbar its room and the left gutter the same, so the column stays centred", () => {
  const main = rule(".document-main");
  // `scroll`, so a Document too short to scroll keeps the room too; WebKit ignores
  // `scrollbar-gutter: stable` then, and leaves the left gutter out of a flex container.
  expect(main).toContain("overflow-y: scroll");
  expect(main).toMatch(
    /padding-inline: calc\(72px \+ var\(--scrollbar-size\)\) 72px/,
  );
});

it("hangs the rail from a track no wider than the column, so nothing makes the reader scroll sideways", () => {
  const track = rule(".document-rail-track");
  expect(track).toContain("width: var(--rail-column)");
  expect(css).not.toContain("rail-reserve");
  expect(rule(".document-rail")).toContain(
    "left: calc(100% + var(--rail-gap))",
  );
});

it("keeps 72px between the text and the ticks' hover area, which ends 12px from the edge", () => {
  // The hover area is 36px wide: 12 + 36 + 24 clear = 72.
  expect(rule(".document-outline")).toContain(
    "right: calc(22px - var(--outline-hit))",
  );
});

it("keeps a folded row on one line: only the group name sets a wrap mode, never the folded summary or the page", () => {
  // `text-wrap` is a shorthand that also sets text-wrap-mode, which would cancel the row's nowrap.
  expect(rule(".markdown-document .folded-summary")).not.toContain("text-wrap");
  expect(rule(".context-view-wrapper > .cgraph-page")).not.toContain(
    "text-wrap",
  );
  expect(css.match(/text-wrap:/g)).toHaveLength(1);
  expect(rule(".documents-group-name")).toContain("text-wrap: wrap");
  expect(
    rule(
      ".document-workspace .document-body .markdown-document > [data-folded]",
    ),
  ).toContain("white-space: nowrap");
});

it("shortens the Plan's name first, then the title, and never the slash", () => {
  expect(rule(".document-bar .document-plan-crumb")).toMatch(
    /flex: 0 1000 auto/,
  );
  const name = rule(".document-plan-crumb-name");
  expect(name).toContain("overflow: hidden");
  expect(name).toContain("text-overflow: ellipsis");
  expect(rule(".document-crumb-title")).toContain("text-overflow: ellipsis");
  expect(rule(".document-crumb-sep")).toContain("flex: none");
});

it("puts the full-width rail 100px down at rest and 28px under the bar once the reader scrolls", () => {
  // The scroller's 36px padding minus 16 leaves the track 20px under the bar; the rail adds 8.
  expect(rule(".document-rail-track")).toContain("top: -16px");
  expect(rule(".document-rail")).toContain("top: 8px");
});

it("scrolls the Documents list under its header, which spans the pane", () => {
  expect(rule(".documents-list-view")).toContain("overflow: hidden");
  expect(rule(".documents-list-body")).toContain("overflow-y: scroll");
});
