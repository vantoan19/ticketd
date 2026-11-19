// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { coldTokenCache } from "@/test/motion-tokens";
import { MotionProvider } from "@/components/ui/motion";
import type { StatusCounts, Ticket } from "@/lib/api/client";
import { TestReads } from "@/lib/workspace-reads/testing";
import { frames } from "@/test/motion-clock";
import {
  EXIT_MS,
  holdKey,
  motionTestbed,
  SETTLED_MS,
} from "@/test/motion-testbed";
import { TicketList } from "./TicketList";
import type { RowScope } from "./ticket-row";

// How the ticket list moves (DESIGN.md section 12). Timing comes from the real
// tokens and the clock is the test's own (test/motion-clock), so nothing here
// depends on how fast the machine runs.

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const STAGGER_MS = 24;
const testbed = motionTestbed();

const ticket = (n: number, overrides: Partial<Ticket> = {}): Ticket => ({
  id: String(n),
  trashed: false,
  reference: `T-KQ${n}`,
  title: `Ticket ${n}`,
  status: "Todo",
  body: "",
  tags: [],
  project_id: null,
  plan_id: null,
  availability: "Ready",
  parent: null,
  children: [],
  duplicate_of: null,
  duplicates: [],
  prerequisites: [],
  ...overrides,
});
const tickets = (count: number) =>
  Array.from({ length: count }, (_, i) => ticket(i + 1));
const scope: RowScope = {
  showPlan: true,
  showProject: true,
  plans: [],
  projects: [],
};
const noCounts: StatusCounts = {
  total: 0,
  todo: 0,
  in_progress: 0,
  in_review: 0,
  done: 0,
  canceled: 0,
  duplicate: 0,
};

function List({
  tickets,
  selected = null,
  empty,
  cascade = false,
  onCascaded,
  grouped = false,
}: {
  tickets: Ticket[];
  selected?: string | null;
  empty?: string;
  cascade?: boolean;
  onCascaded?: () => void;
  grouped?: boolean;
}) {
  return (
    <MotionProvider>
      <TestReads>
        <TicketList
          tickets={tickets}
          selected={selected}
          onOpen={vi.fn()}
          bulkSelection={[]}
          onToggle={vi.fn()}
          selectable
          scope={scope}
          cascade={cascade}
          {...(onCascaded && { onCascaded })}
          {...(grouped && { grouping: { counts: noCounts } })}
          {...(empty && { empty: <p>{empty}</p> })}
        />
      </TestReads>
    </MotionProvider>
  );
}

const rowOf = (title: string) => screen.getByText(title).closest("li")!;

test("a created row starts soft and below its place, with its space closed", () => {
  const { rerender } = render(<List tickets={[ticket(1)]} />);
  expect(rowOf("Ticket 1").style.opacity).toBe("1");
  rerender(<List tickets={[ticket(1), ticket(2)]} />);
  const { opacity, transform, filter, height, overflow } =
    rowOf("Ticket 2").style;
  expect(opacity).toBe("0");
  expect(transform).toContain("translateY(6px)");
  expect(filter).toBe("blur(4px)");
  expect(height).toBe("0px");
  // Clipped only while its space opens: the open row's highlight must be able
  // to glide in from the row it left.
  expect(overflow).toBe("clip");
});

test("a created row settles into place", async () => {
  const { rerender } = render(<List tickets={[ticket(1)]} />);
  rerender(<List tickets={[ticket(1), ticket(2)]} />);
  await frames();
  await testbed.advance(SETTLED_MS);
  expect(rowOf("Ticket 2").style.opacity).toBe("1");
});

test("a settled row carries no blur filter and no clip", async () => {
  // The clock is real here: the library reaches its settled style only then.
  testbed.realTime();
  const { rerender } = render(<List tickets={[ticket(1)]} />);
  rerender(<List tickets={[ticket(1), ticket(2)]} />);
  await waitFor(
    () => {
      const { filter, overflow } = rowOf("Ticket 2").style;
      expect(filter).toBe("none");
      expect(overflow).toBe("visible");
    },
    { timeout: 10_000 },
  );
  expect(rowOf("Ticket 1").style.overflow).toBe("visible");
});

test("a trashed row stays while it fades and its space closes", async () => {
  const { rerender } = render(<List tickets={[ticket(1), ticket(2)]} />);
  rerender(<List tickets={[ticket(1)]} />);
  await frames();
  expect(screen.queryByText("Ticket 2")).not.toBeNull();
  await testbed.advance(EXIT_MS - 10);
  expect(screen.queryByText("Ticket 2")).not.toBeNull();
  await testbed.advance(SETTLED_MS);
  expect(screen.queryByText("Ticket 2")).toBeNull();
});

test("a trashed row leaves at once under reduced motion", async () => {
  testbed.reduceMotion();
  const { rerender } = render(<List tickets={[ticket(1), ticket(2)]} />);
  rerender(<List tickets={[ticket(1)]} />);
  await frames();
  expect(screen.queryByText("Ticket 2")).toBeNull();
});

test("a trashed row leaves at once while a key repeats", async () => {
  const { rerender } = render(<List tickets={[ticket(1), ticket(2)]} />);
  holdKey();
  rerender(<List tickets={[ticket(1)]} />);
  await frames();
  expect(screen.queryByText("Ticket 2")).toBeNull();
});

test("the open ticket's highlight is one element that follows the open ticket", () => {
  const rows = [ticket(1), ticket(2)];
  const { rerender } = render(<List tickets={rows} selected="T-KQ1" />);
  const highlight = () => document.querySelectorAll('[data-slot="glide"]');
  expect(highlight()).toHaveLength(1);
  expect(rowOf("Ticket 1").contains(highlight()[0]!)).toBe(true);
  rerender(<List tickets={rows} selected="T-KQ2" />);
  expect(highlight()).toHaveLength(1);
  expect(rowOf("Ticket 2").contains(highlight()[0]!)).toBe(true);
});

test("a row at rest does not clip, so the highlight is seen gliding in from its neighbour", () => {
  render(<List tickets={tickets(2)} selected="T-KQ1" />);
  expect(rowOf("Ticket 1").style.overflow).not.toBe("clip");
  expect(rowOf("Ticket 2").style.overflow).not.toBe("clip");
});

test("a released row shows the arrival fill once it is let go", () => {
  const { rerender } = render(<List tickets={[ticket(1), ticket(2)]} />);
  const row = rowOf("Ticket 1");
  fireEvent.pointerEnter(row);
  rerender(<List tickets={[ticket(1, { status: "Done" }), ticket(2)]} />);
  // Held where it was while the pointer is on it.
  expect(row.querySelector('[data-slot="arrival"]')).toBeNull();
  fireEvent.pointerLeave(row);
  fireEvent.click(document.body);
  const fill = row.querySelector('[data-slot="arrival"]');
  expect(fill).not.toBeNull();
  // Its own word: `data-arriving` is the page's, which keeps a cascade away.
  expect(row.getAttribute("data-arrival-fill")).toBe("true");
  expect(row.hasAttribute("data-arriving")).toBe(false);
});

test("no ticket is highlighted until one is open", () => {
  render(<List tickets={[ticket(1)]} />);
  expect(document.querySelector('[data-slot="glide"]')).toBeNull();
});

test("the empty state fades up once the last row is gone", async () => {
  const { rerender } = render(
    <List tickets={[ticket(1)]} empty="No tickets match" />,
  );
  expect(screen.queryByText("No tickets match")).toBeNull();
  rerender(<List tickets={[]} empty="No tickets match" />);
  const state = screen
    .getByText("No tickets match")
    .closest('[data-slot="appear"]') as HTMLElement;
  expect(state.style.opacity).toBe("0");
  expect(state.style.filter).toBe("blur(4px)");
  await frames();
  await testbed.advance(SETTLED_MS);
  expect(state.style.opacity).toBe("1");
});

// The list's own spacing (its top and bottom padding) closes with the rows, so
// the empty state settles where it ends instead of snapping up when the list,
// holding only that spacing, is taken out.
test("the list's own spacing closes with its last rows", async () => {
  const { container, rerender } = render(
    <List tickets={[ticket(1), ticket(2)]} empty="No tickets match" />,
  );
  const rows = container.querySelector(".ticket-rows")!;
  expect(rows.hasAttribute("data-empty")).toBe(false);
  rerender(<List tickets={[]} empty="No tickets match" />);
  // The rows are still fading out, and the spacing is already closing.
  expect(screen.queryByText("Ticket 1")).not.toBeNull();
  expect(rows.hasAttribute("data-empty")).toBe(true);
  rerender(<List tickets={[ticket(1)]} empty="No tickets match" />);
  expect(rows.hasAttribute("data-empty")).toBe(false);
});

test.each([false, true])(
  "the empty list closes its padding without removing its box (bulk bar: %s)",
  async (bulkBar) => {
    const css = readFileSync(
      join(__dirname, "ticket-list.css"),
      "utf8",
    ).replace(/@import [^;]+;/g, "");
    const view = (rows: Ticket[]) => (
      <>
        <style>{css}</style>
        <div className="ticket-list">
          <List tickets={rows} empty="No tickets match" />
          {bulkBar && <div className="bulk-bar" />}
        </div>
      </>
    );
    const { container, rerender } = render(view([ticket(1)]));
    container
      .querySelector<HTMLElement>(".ticket-list")!
      .style.setProperty("--list-overlays-height", "4px");
    const rows = container.querySelector(".ticket-rows")!;
    expect(getComputedStyle(rows).paddingBottom).not.toBe("0px");
    rerender(view([]));
    await frames();
    // Use the complete owning stylesheet: a correct empty rule alone can be
    // overridden by the pane's later overlay or bulk-bar inset.
    const style = getComputedStyle(rows);
    expect(style.paddingBottom).toBe("0px");
    expect(style.paddingTop).toBe("0px");
    await testbed.advance(SETTLED_MS);
    expect(rows.childElementCount).toBe(0);
    // jsdom does not interpolate padding. Keeping the box after the rows leave
    // lets that CSS transition finish in a browser, without exposing an empty
    // list to assistive technology.
    expect(getComputedStyle(rows).display).not.toBe("none");
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText("No tickets match")).toBeTruthy();
  },
);

test("the stylesheet closes the list's padding on the smooth spring", () => {
  const css = readFileSync(join(__dirname, "ticket-list.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const rule = (selector: string) =>
    css.split("}").find((block) => block.trim().startsWith(selector + " {")) ??
    "";
  expect(rule(".ticket-rows")).toContain(
    "transition: padding var(--spring-smooth-t) var(--spring-smooth)",
  );
});

test("an empty list shows its empty state at once, without fading in", () => {
  render(<List tickets={[]} empty="Nothing here yet" />);
  expect(screen.getByText("Nothing here yet")).toBeTruthy();
  const state = screen
    .getByText("Nothing here yet")
    .closest<HTMLElement>('[data-slot="appear"]');
  expect(state?.style.opacity).not.toBe("0");
});

test("every ticket row is marked for a page arrival; a group header is not", () => {
  render(<List tickets={tickets(2)} grouped />);
  const rows = [...document.querySelectorAll("ul.ticket-rows > li")];
  expect(rows.map((row) => row.getAttribute("data-arrive"))).toEqual([
    null,
    "row",
    "row",
  ]);
});

// The cascade: back from the Board, or in place of the placeholders.

test("a cascade fades the rows up top first, in place, with no height", async () => {
  render(<List tickets={tickets(9)} cascade />);
  const eighth = rowOf("Ticket 8");
  expect(eighth.style.opacity).toBe("0");
  expect(eighth.style.transform).toContain("translateY(6px)");
  expect(eighth.style.height).toBe("");
  await frames();
  // Row 8 waits seven steps: just short of that, nothing has moved.
  await testbed.advance(7 * STAGGER_MS - 10);
  expect(eighth.style.opacity).toBe("0");
  expect(Number(rowOf("Ticket 2").style.opacity)).toBeGreaterThan(0);
  await testbed.advance(SETTLED_MS);
  expect(eighth.style.opacity).toBe("1");
});

test("the cascade asks to be cleared once, as the list mounts", () => {
  const onCascaded = vi.fn();
  const { rerender } = render(
    <List tickets={tickets(2)} cascade onCascaded={onCascaded} />,
  );
  expect(onCascaded).toHaveBeenCalledTimes(1);
  rerender(<List tickets={tickets(2)} onCascaded={onCascaded} />);
  expect(onCascaded).toHaveBeenCalledTimes(1);
});

test("a row that arrives after the cascade opens its own space, with no stagger", async () => {
  const { rerender } = render(<List tickets={tickets(9)} cascade />);
  await frames();
  await testbed.advance(SETTLED_MS);
  // The pane may still say cascade; only the rows there at mount took part.
  rerender(<List tickets={tickets(10)} cascade />);
  const added = rowOf("Ticket 10");
  expect(added.style.height).toBe("0px");
  await frames();
  await testbed.advance(STAGGER_MS);
  expect(Number(added.style.opacity)).toBeGreaterThan(0);
});

test("no cascade plays while a page arrival is running", () => {
  const page = document.body.appendChild(document.createElement("div"));
  page.dataset.arriving = "";
  const onCascaded = vi.fn();
  render(<List tickets={tickets(3)} cascade onCascaded={onCascaded} />);
  page.remove();
  expect(rowOf("Ticket 3").style.opacity).toBe("1");
  // The request is still handed back, so it cannot fire on a later mount.
  expect(onCascaded).toHaveBeenCalledTimes(1);
});

test("rows present when the list mounts without a cascade do not animate", () => {
  render(<List tickets={tickets(3)} />);
  expect(rowOf("Ticket 3").style.opacity).toBe("1");
});

// Groups: the header's count crossfades, and its gap opens with it.

test("a group's count crossfades when it changes", async () => {
  const { rerender } = render(<List tickets={tickets(2)} grouped />);
  const count = () =>
    document.querySelector<HTMLElement>(
      ".ticket-group-header [data-slot=count]",
    )!;
  expect(count().textContent).toBe("2");
  rerender(<List tickets={tickets(3)} grouped />);
  // Both numbers are there while one fades out and the other in.
  expect(count().textContent).toContain("2");
  expect(count().textContent).toContain("3");
  await frames();
  await testbed.advance(SETTLED_MS);
  expect(count().textContent).toBe("3");
});

test("a group's count keeps its noun for a screen reader, outside the crossfade", () => {
  render(<List tickets={tickets(2)} grouped />);
  const header = document.querySelector<HTMLElement>(".ticket-group-header")!;
  expect(header.textContent).toContain("2 tickets");
  expect(header.querySelector("[data-slot=count] .sr-only")).toBeNull();
});

test("the gap above a group is its margin: none above the first, 6px above the rest", () => {
  render(<List tickets={[ticket(1), ticket(2, { status: "Done" })]} grouped />);
  const headers = [
    ...document.querySelectorAll<HTMLElement>(".ticket-group-header"),
  ];
  expect(headers.map((header) => header.style.marginTop)).toEqual([
    "0px",
    "6px",
  ]);
});

test("a created group opens its gap with its height instead of popping it in", () => {
  const { rerender } = render(<List tickets={[ticket(1)]} grouped />);
  rerender(
    <List tickets={[ticket(1), ticket(2, { status: "Done" })]} grouped />,
  );
  const added = document.querySelector<HTMLElement>(
    '.ticket-group-header[data-status="Done"]',
  )!;
  expect(added.style.height).toBe("0px");
  expect(added.style.marginTop).toBe("0px");
});

// The tokens: one read for the whole render (a long list is 300 rows).

test("the motion tokens are read once for a render, not once per row", () => {
  const rootReads = (count: number) => {
    const { rerender, unmount } = render(<List tickets={tickets(count)} />);
    coldTokenCache();
    const read = vi.spyOn(window, "getComputedStyle");
    rerender(<List tickets={tickets(count)} />);
    const reads = read.mock.calls.filter(
      ([element]) => element === document.documentElement,
    ).length;
    read.mockRestore();
    unmount();
    return reads;
  };
  expect(rootReads(3)).toBeGreaterThan(0);
  expect(rootReads(60)).toBe(rootReads(3));
});

// The cascade is one-shot and only for what can be seen.

test("a row that leaves and comes back opens its own space; it does not take part in the cascade again", async () => {
  const { rerender } = render(<List tickets={tickets(4)} cascade />);
  await frames();
  await testbed.advance(SETTLED_MS);
  rerender(<List tickets={[ticket(1), ticket(2), ticket(4)]} cascade />);
  await frames();
  await testbed.advance(SETTLED_MS);
  expect(screen.queryByText("Ticket 3")).toBeNull();
  rerender(<List tickets={tickets(4)} cascade />);
  const back = rowOf("Ticket 3");
  expect(back.style.height).toBe("0px");
  // The third row of a cascade waits two steps; a row opening its space does not.
  await frames();
  await testbed.advance(STAGGER_MS);
  expect(Number(back.style.opacity)).toBeGreaterThan(0);
});

test("a cascade moves only the rows that can be on screen, and the rest are simply there", async () => {
  const height = window.innerHeight;
  // Ten rows of 36px.
  Object.defineProperty(window, "innerHeight", {
    value: 360,
    configurable: true,
  });
  try {
    render(<List tickets={tickets(60)} cascade />);
    const rows = [
      ...document.querySelectorAll<HTMLElement>("ul.ticket-rows > li"),
    ];
    expect(rows.filter((row) => row.style.opacity === "0")).toHaveLength(10);
    expect(rowOf("Ticket 10").style.opacity).toBe("0");
    // Below the window: no fade, no rise, no blur.
    const below = rowOf("Ticket 11");
    expect(below.style.opacity).toBe("1");
    expect(below.style.transform).not.toContain("translateY(6px)");
    expect(below.style.filter).not.toContain("blur(4px)");
    await frames();
    await testbed.advance(SETTLED_MS);
    expect(rowOf("Ticket 10").style.opacity).toBe("1");
  } finally {
    Object.defineProperty(window, "innerHeight", {
      value: height,
      configurable: true,
    });
  }
});

test("a row below the first screen, added by a later page, opens its own space", () => {
  const { rerender } = render(<List tickets={tickets(60)} cascade />);
  rerender(<List tickets={tickets(61)} cascade />);
  expect(rowOf("Ticket 61").style.height).toBe("0px");
});

// A leaving row closes its space with its fade, so the rows below glide up.

test("a leaving row closes its height with its fade instead of keeping it until it is gone", async () => {
  const { rerender } = render(<List tickets={tickets(3)} />);
  rerender(<List tickets={[ticket(1), ticket(3)]} />);
  const leaving = rowOf("Ticket 2");
  await frames();
  await testbed.advance(EXIT_MS / 2);
  expect(screen.queryByText("Ticket 2")).not.toBeNull();
  expect(leaving.style.height).toBe("0px");
  expect(leaving.style.overflow).toBe("clip");
  expect(Number(leaving.style.opacity)).toBeLessThan(1);
});

test("a leaving group header closes its gap with its height", async () => {
  const { rerender } = render(
    <List tickets={[ticket(1), ticket(2, { status: "Done" })]} grouped />,
  );
  rerender(<List tickets={[ticket(1)]} grouped />);
  const leaving = document.querySelector<HTMLElement>(
    '.ticket-group-header[data-status="Done"]',
  )!;
  await frames();
  await testbed.advance(EXIT_MS / 2);
  expect(leaving.style.height).toBe("0px");
  // The 6px above it is closing with it, not left standing.
  expect(parseFloat(leaving.style.marginTop)).toBeLessThan(6);
});
