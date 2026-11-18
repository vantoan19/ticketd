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

it("the Plan summary reserves its two rows and truncates the purpose", () => {
  const plan = readFileSync(
    join(__dirname, "..", "features/plans/plan.css"),
    "utf8",
  );
  const context = /\n[.]plan-context [{]([^}]*)[}]/.exec(plan)?.[1] ?? "";
  expect(context).toMatch(/height: 96px;/);
  expect(context).not.toMatch(/flex-wrap: wrap/);
  expect(plan).toMatch(/[.]plan-purpose-text [{][^}]*text-overflow: ellipsis;/);
  expect(plan).toMatch(/[.]plan-progress [{][^}]*flex: none;/);
  expect(rule(".ticket-scroll")).toMatch(/overflow-x: hidden;/);
});

it("the split switches on the content panel's settled width, not the window's", () => {
  const read = (path: string) =>
    readFileSync(join(__dirname, "..", path), "utf8");
  for (const file of [
    "styles.css",
    "features/tickets/ticket-board.css",
    "features/tickets/TicketWorkspaceView.tsx",
  ])
    expect(read(file)).not.toMatch(/1071/);
  // useNarrowPane measures the content panel and waits for its width to hold
  // still; the layout follows that one state (data-narrow), never a live
  // container query, which would flip it every frame of the sidebar's spring.
  const view = read("features/tickets/TicketWorkspaceView.tsx");
  expect(view).toMatch(/useNarrowPane\(workspaceRef, STACK_MIN_WIDTH\)/);
  expect(view).toMatch(/data-narrow=\{narrow \|\| undefined\}/);
});

it("the stacked panes follow the settled narrow state, not a container query", () => {
  const styles = readFileSync(join(__dirname, "..", "styles.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ");
  // No container query flips the ticket workspace's panes.
  expect(styles).not.toMatch(/@container plan-workspace \(max-width: 879px\)/);
  // Each stacked rule is keyed on data-narrow, at no added specificity (:where),
  // so it competes with the other layouts' rules exactly as before.
  for (const selector of [
    '.ticket-workspace:where([data-narrow]) :is(#list, [data-view-id="list"]) {',
    '.ticket-workspace:where([data-narrow]):not([data-pane-leaving="detail"]) :is(#detail, [data-view-id="detail"]),',
    ".ticket-workspace:where([data-narrow]) .split-handle {",
    '.ticket-workspace:where([data-narrow]).narrow-detail :is(#list, [data-view-id="list"]) {',
    '.ticket-workspace:where([data-narrow]).narrow-detail :is(#detail, [data-view-id="detail"]) {',
    ".ticket-workspace:where([data-narrow]).narrow-detail .return-to-list {",
    ".ticket-workspace:where([data-narrow]) .expand-ticket {",
  ])
    expect(styles).toContain(selector);
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

it("a path shortens in its middle first, then at its end, always with an ellipsis", () => {
  const paths = readFileSync(
    join(__dirname, "..", "components/ui/patterns.css"),
    "utf8",
  );
  const block = (selector: string) =>
    new RegExp(`\n${selector.replace(".", "[.]")} [{]([^}]*)[}]`).exec(
      paths,
    )?.[1] ?? "";
  // U22: weighted shrinking still hands the end a fraction of a pixel, and its
  // ellipsis then takes two characters. Only one part may flex at a time: the
  // middle grows into the room the end leaves (never past its own text) and
  // never shrinks below room for its ellipsis; the end only shrinks.
  expect(block(".ui-path-middle")).toMatch(/flex: 1 0 0;/);
  expect(block(".ui-path-middle")).toMatch(/min-width: [1-9]/);
  expect(block(".ui-path-middle")).toMatch(/max-width: max-content;/);
  // Then the last folders, which the line's edge must never cut mid-character.
  expect(block(".ui-path-tail")).toMatch(/flex: 0 1 auto;/);
  expect(block(".ui-path-tail")).toMatch(/min-width: 0;/);
  expect(block(".ui-path-tail")).toMatch(/overflow: hidden;/);
  expect(block(".ui-path-tail")).toMatch(/text-overflow: ellipsis;/);
});

it("a long Chat title gives way before the harness and folder trigger", () => {
  const chats = readFileSync(
    join(__dirname, "..", "features/chats/chats.css"),
    "utf8",
  );
  const title = /\n[.]chat-head-title [{]([^}]*)[}]/.exec(chats)?.[1] ?? "";
  // U20, U23: only one of the two flexes at a time. The title fills what the
  // trigger leaves, up to its text; it never shrinks below the lesser of its
  // text and 40%, so the trigger is cut only when the title needs that room.
  expect(title).toMatch(/flex: 1 0 40%;/);
  expect(title).toMatch(/max-width: max-content;/);
  const detail = readFileSync(
    join(__dirname, "..", "features/chats/ChatDetail.tsx"),
    "utf8",
  );
  expect(detail).not.toMatch(
    /className="[^"]*max-w-[^"]*"\s+aria-label="Harness and folder"/,
  );
});
