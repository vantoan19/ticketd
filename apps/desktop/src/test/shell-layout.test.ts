import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// DESIGN.md section 5: the shell stays locked to the window and only panes
// scroll. An absolutely positioned descendant (an sr-only status deep in a long
// pane) whose containing block is the viewport extends the document, so the
// whole window scrolls and the sidebar moves with it.
const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
const rule = (selector: string) =>
  new RegExp(`\n${selector.replace(".", "[.]")} [{]([^}]*)[}]`).exec(
    css,
  )?.[1] ?? "";

it.each([".workspace", ".content-panel"])(
  "%s contains absolutely positioned descendants and cannot scroll",
  (selector) => {
    expect(rule(selector)).toMatch(/position: relative;/);
    expect(rule(selector)).toMatch(/overflow: clip;/);
  },
);

it("the collapsed sidebar keeps the manage menus and the source Retry reachable", () => {
  const hidden = [...css.matchAll(/(\n[^{}\n]*[{][^}]*display: none;[^}]*})/g)]
    .map((m) => m[1] ?? "")
    .filter((block) => block.includes("[data-collapsed]"));
  const names = hidden.map((block) => block.split("{")[0]?.trim());
  expect(names.join("\n")).not.toMatch(
    /sidebar-heading|sidebar-source > button/,
  );
});

it("the Plan list toolbar shrinks its summary, not its Filter control", () => {
  const plan = readFileSync(
    join(__dirname, "..", "features/plans/plan.css"),
    "utf8",
  );
  expect(plan).toMatch(/[.]plan-list-summary [{][^}]*text-overflow: ellipsis;/);
  expect(plan).toMatch(
    /[.]plan-list-toolbar > :not[(][^)]*[)] [{]\s*flex: none;/,
  );
  expect(rule(".ticket-scroll")).toMatch(/overflow-x: hidden;/);
});

it("the split switches on the content panel's width, not the window's", () => {
  const read = (path: string) =>
    readFileSync(join(__dirname, "..", path), "utf8");
  for (const file of [
    "styles.css",
    "features/tickets/ticket-board.css",
    "features/tickets/TicketWorkspaceView.tsx",
  ])
    expect(read(file)).not.toMatch(/1071/);
  expect(read("styles.css")).toMatch(
    /@container plan-workspace [(]max-width: 839px[)]/,
  );
});

it("Progress stays visible under forced colours", () => {
  expect(css).toMatch(
    /@media [(]forced-colors: active[)] [{][^]*?[.]ui-progress [{][^}]*border: 1px solid CanvasText;/,
  );
});

it("the window never scrolls and only the list rows scroll under a fixed header", () => {
  // The pane is a clipping column; if it were the scroller, the header would
  // scroll away with the rows.
  expect(rule(".ticket-list")).toMatch(/display: flex;/);
  expect(rule(".ticket-list")).toMatch(/flex-direction: column;/);
  expect(rule(".ticket-list")).toMatch(/overflow: hidden;/);
  expect(rule(".ticket-list")).not.toMatch(/overflow-y: auto;/);
  expect(rule(".ticket-scroll")).toMatch(/flex: 1 1 0;/);
  expect(rule(".ticket-scroll")).toMatch(/min-height: 0;/);
  expect(rule(".ticket-scroll")).toMatch(/overflow-y: auto;/);
  expect(rule(".ticket-scroll")).toMatch(/overflow-x: hidden;/);
});
