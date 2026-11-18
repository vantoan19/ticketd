// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ViewRegion } from "@/components/layout/ViewRegion";
import type { Ticket } from "@/lib/api/client";
import { TestReads } from "@/lib/workspace-reads/testing";
import { Visibility } from "@/lib/workspace-reads/Visibility";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
import { TicketList } from "./TicketList";
import { TicketRowsSkeleton } from "./TicketRowsSkeleton";
import type { RowScope } from "./ticket-row";

// A ticket list inside the real ViewRegion (DESIGN.md section 12, the arrival
// contract): the page's arrival belongs to the shell, and the list's own
// cascade stays out of its way. jsdom has no layout and no Web Animations, so
// `animate` is a spy and the rows' own motion is not mounted (no
// MotionProvider): a row then keeps the style it would start from, which says
// whether the list meant to cascade it.

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

type Played = {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  finished: Promise<unknown>;
  settle: () => void;
};
const played: Played[] = [];
const animate = vi.fn(function (
  this: Element,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
) {
  let settle = () => {};
  const finished = new Promise<unknown>(
    (resolve) => (settle = () => resolve(0)),
  );
  const animation = {
    element: this,
    keyframes,
    options,
    onfinish: null,
    oncancel: null,
    finished,
    settle,
  } as Played;
  played.push(animation);
  return animation as unknown as Animation;
});

let restoreTokens: () => void;
beforeEach(() => {
  played.length = 0;
  animate.mockClear();
  Element.prototype.animate = animate as unknown as Element["animate"];
  restoreTokens = applyTokens(rootTokens);
  // Every element is in a 100px-tall page, so every row is on show.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 100,
    left: 0,
    right: 100,
    width: 100,
    height: 100,
  } as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  restoreTokens();
  // @ts-expect-error jsdom has no animate; remove the spy
  delete Element.prototype.animate;
});

const ticket = (n: number): Ticket => ({
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
});
const scope: RowScope = {
  showPlan: true,
  showProject: true,
  plans: [],
  projects: [],
};

function Page({ cascade = false }: { cascade?: boolean }) {
  return (
    <section>
      <header data-arrive="header" />
      <TestReads>
        <TicketList
          tickets={[ticket(1), ticket(2), ticket(3)]}
          selected={null}
          onOpen={vi.fn()}
          bulkSelection={[]}
          onToggle={vi.fn()}
          selectable
          scope={scope}
          cascade={cascade}
        />
      </TestReads>
    </section>
  );
}

function Panel({ page, children }: { page: string; children?: ReactNode }) {
  return (
    <main className="content-panel">
      <ViewRegion page={page}>
        {children ?? <section>{page}</section>}
      </ViewRegion>
    </main>
  );
}

const rowOf = (title: string) => screen.getByText(title).closest("li")!;
// Opacity and blur only; each rising element also has a transform animation,
// and the page's own plain fade (what holds its unmarked parts back) has no blur.
const arrivals = () =>
  played.filter(
    (one) =>
      one.options.easing?.startsWith("cubic-bezier") &&
      one.options.fill === "backwards" &&
      "filter" in one.keyframes[0]!,
  );

test("the shell cascades the list's rows with the page, in order, and the list adds nothing", () => {
  const { rerender } = render(<Panel page="inbox" />);
  rerender(
    <Panel page="tickets">
      <Page />
    </Panel>,
  );
  const [header, ...rows] = arrivals();
  expect(header?.element.getAttribute("data-arrive")).toBe("header");
  expect(rows.map((one) => one.element)).toEqual([
    rowOf("Ticket 1"),
    rowOf("Ticket 2"),
    rowOf("Ticket 3"),
  ]);
  // Header, then a 24ms step per row, after the old page's 150ms.
  expect(arrivals().map((one) => Math.round(one.options.delay ?? 0))).toEqual([
    150, 174, 198, 222,
  ]);
  expect(rowOf("Ticket 1").style.opacity).toBe("1");
});

test("a cascade the list is asked for while the page arrives is handed back unplayed", () => {
  const { rerender, container } = render(<Panel page="inbox" />);
  rerender(
    <Panel page="tickets">
      <Page />
    </Panel>,
  );
  expect(
    container.querySelector("section")?.hasAttribute("data-arriving"),
  ).toBe(true);
  // The reads settle and the list is asked to cascade, mid-arrival.
  rerender(
    <Panel page="tickets">
      <Page cascade />
    </Panel>,
  );
  expect(rowOf("Ticket 3").style.opacity).toBe("1");
  expect(rowOf("Ticket 3").style.transform).not.toContain("translateY(6px)");
});

test("once the arrival has settled the list cascades its rows again", async () => {
  const { rerender, container } = render(<Panel page="inbox" />);
  rerender(
    <Panel page="tickets">
      <Page />
    </Panel>,
  );
  await act(async () => {
    for (const one of played) one.settle();
  });
  expect(container.querySelector("[data-arriving]")).toBeNull();
  // A list that mounts now, asked to cascade, is not behind an arrival.
  render(<Page cascade />);
  const [, later] = screen.getAllByText("Ticket 3");
  expect(later?.closest("li")?.style.opacity).toBe("0");
});

test("placeholders are not rows of the arrival, and the real rows that replace them are", () => {
  const { rerender } = render(<Panel page="inbox" />);
  rerender(
    <Panel page="tickets">
      <section>
        <header data-arrive="header" />
        <TicketRowsSkeleton count={4} />
      </section>
    </Panel>,
  );
  // Only the header: no placeholder row carries the marker.
  expect(arrivals()).toHaveLength(1);
  expect(
    document.querySelectorAll('ul.ticket-rows > li[data-arrive="row"]'),
  ).toHaveLength(0);
  rerender(
    <Panel page="tickets">
      <Page cascade />
    </Panel>,
  );
  expect(
    document.querySelectorAll('ul.ticket-rows > li[data-arrive="row"]'),
  ).toHaveLength(3);
});

// The First-run handover: the list is hidden under the guide, then the first
// ticket arrives in the very commit that shows the list.
function Handover({ hidden, tickets }: { hidden: boolean; tickets: Ticket[] }) {
  return (
    <Visibility hidden={hidden}>
      <TestReads>
        <TicketList
          tickets={tickets}
          empty={<p>No tickets yet</p>}
          selected={null}
          onOpen={vi.fn()}
          bulkSelection={[]}
          onToggle={vi.fn()}
          selectable
          scope={scope}
        />
      </TestReads>
    </Visibility>
  );
}

test("while the list is hidden its empty state is not there to fade out behind the guide", () => {
  const { rerender } = render(<Handover hidden tickets={[]} />);
  expect(screen.queryByText("No tickets yet")).toBeNull();
  rerender(<Handover hidden={false} tickets={[]} />);
  expect(screen.queryByText("No tickets yet")).not.toBeNull();
});

test("the first row that arrives as the list is shown has no arrival of its own, the shell's is the only one", () => {
  const { rerender } = render(<Handover hidden tickets={[]} />);
  rerender(<Handover hidden={false} tickets={[ticket(1)]} />);
  expect(screen.queryByText("No tickets yet")).toBeNull();
  // Not left at the start of its own entrance (opacity 0, below its place).
  expect(rowOf("Ticket 1").style.opacity).toBe("1");
  expect(rowOf("Ticket 1").style.transform).not.toContain("translateY(6px)");
});

test("a row added to a list that stays shown still arrives by itself", () => {
  const { rerender } = render(<Handover hidden={false} tickets={[]} />);
  rerender(<Handover hidden={false} tickets={[ticket(1)]} />);
  expect(rowOf("Ticket 1").style.opacity).toBe("0");
});
