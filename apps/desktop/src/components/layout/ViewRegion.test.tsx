// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ViewRegion } from "@/components/layout/ViewRegion";
import { launch } from "@/components/layout/launch";
import {
  applyTokens,
  instantTokens,
  reducedTokens,
  rootTokens,
} from "@/test/motion-tokens";

// Switching pages and the launch cascade (DESIGN.md section 12, the arrival
// contract). jsdom has no layout and no Web Animations, so `animate` is a spy
// whose animations settle when the test says so, and the tokens are the real
// ones from styles.css.

type Played = {
  element: Element;
  options: KeyframeAnimationOptions;
  onfinish: null | (() => void);
  oncancel: null | (() => void);
  finished: Promise<unknown>;
  settle: () => void;
};

const played: Played[] = [];
const animate = vi.fn(function (
  this: Element,
  _keyframes: unknown,
  options: KeyframeAnimationOptions,
) {
  let settle = () => {};
  const finished = new Promise<unknown>(
    (resolve) => (settle = () => resolve(0)),
  );
  const animation = {
    element: this,
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
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  restoreTokens();
  // @ts-expect-error jsdom has no animate; remove the spy
  delete Element.prototype.animate;
});

function useTokens(tokens: Record<string, string>) {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...tokens });
}

// Opacity and blur only; each rising element also has a transform animation.
const fades = () =>
  played.filter((one) => one.options.easing?.startsWith("cubic-bezier"));
const delayOf = (one: Played) => Math.round(one.options.delay ?? 0);
const arrivals = () =>
  fades().filter((one) => one.options.fill === "backwards");

function Panel({
  page,
  children,
}: {
  page: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="content-panel">
      <ViewRegion page={page}>
        {children ?? <section>{page}</section>}
      </ViewRegion>
    </main>
  );
}

// jsdom reports no client rects; a page with a box is on show.
function giveBoxes() {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
}

// Elements sit at `data-y` (default 0) in a 100px-tall page.
function layOut() {
  giveBoxes();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top = Number(this.dataset.y ?? 0);
      const bottom = this.dataset.y === undefined ? 100 : top + 10;
      return {
        top,
        bottom,
        left: 0,
        right: 100,
        width: 100,
        height: bottom - top,
      } as DOMRect;
    },
  );
}

function Rows({ count, y }: { count: number; y?: (row: number) => number }) {
  return (
    <section>
      <header data-arrive="header" data-y="0" />
      <ul>
        {Array.from({ length: count }, (_, row) => (
          <li key={row} data-arrive="row" data-y={y ? y(row) : row}>
            {row}
          </li>
        ))}
      </ul>
    </section>
  );
}

it("lays the page that left over the panel to fade out, and holds the new one back", () => {
  giveBoxes();
  const { container, rerender } = render(<Panel page="tickets" />);
  rerender(<Panel page="plans" />);
  const departing = container.querySelector(".view-departing");
  expect(departing?.textContent).toBe("tickets");
  expect(departing?.getAttribute("aria-hidden")).toBe("true");
  expect(departing?.hasAttribute("inert")).toBe(true);
  // The picture fades out for the exit time; the page that arrives waits it out.
  expect(played[0]?.options).toMatchObject({ duration: 150, fill: "forwards" });
  expect(played.slice(1).map((one) => one.options.delay)).toEqual([150, 150]);
  expect(
    container.querySelector('[data-slot="view-region"]')?.textContent,
  ).toBe("plans");
});

it("removes the picture when its fade ends", () => {
  giveBoxes();
  const { container, rerender } = render(<Panel page="tickets" />);
  rerender(<Panel page="plans" />);
  act(() => played[0]?.onfinish?.());
  expect(container.querySelector(".view-departing")).toBeNull();
});

it("does not animate when the page stays the same", () => {
  giveBoxes();
  const { rerender } = render(<Panel page="tickets" />);
  rerender(<Panel page="tickets" />);
  expect(animate).not.toHaveBeenCalled();
});

it.each([
  ["reduced motion", reducedTokens],
  ["a held key or rapid clicks", instantTokens],
])("changes page at once under %s", (_name, tokens) => {
  giveBoxes();
  useTokens(tokens);
  const { container, rerender } = render(<Panel page="tickets" />);
  rerender(<Panel page="plans" />);
  expect(animate).not.toHaveBeenCalled();
  expect(container.querySelector(".view-departing")).toBeNull();
});

it("the new page's header arrives first, then its rows a stagger step apart", () => {
  layOut();
  const { rerender } = render(<Panel page="tickets" />);
  rerender(
    <Panel page="plans">
      <Rows count={3} />
    </Panel>,
  );
  // Everything waits for the old page to go (150ms); header, then rows 24ms apart.
  expect(arrivals().map(delayOf)).toEqual([150, 174, 198, 222]);
  expect(arrivals()[0]?.element.getAttribute("data-arrive")).toBe("header");
  expect(arrivals()[1]?.element.textContent).toBe("0");
});

it("a cascade stops after eight steps, and later rows arrive with the last", () => {
  layOut();
  const { rerender } = render(<Panel page="tickets" />);
  rerender(
    <Panel page="plans">
      <Rows count={12} />
    </Panel>,
  );
  const delays = arrivals().map(delayOf);
  expect(delays.slice(0, 8)).toEqual([150, 174, 198, 222, 246, 270, 294, 318]);
  expect(new Set(delays.slice(7))).toEqual(new Set([318]));
  expect(delays).toHaveLength(13);
});

it("rows below the fold are not animated", () => {
  layOut();
  const { rerender } = render(<Panel page="tickets" />);
  rerender(
    <Panel page="plans">
      <Rows count={40} y={(row) => row * 10} />
    </Panel>,
  );
  // The page is 100px tall: rows 0 to 9 are in it, header included.
  expect(arrivals()).toHaveLength(1 + 10);
});

it("the page carries data-arriving until its arrival settles", async () => {
  layOut();
  const { container, rerender } = render(<Panel page="tickets" />);
  rerender(
    <Panel page="plans">
      <Rows count={2} />
    </Panel>,
  );
  const page = container.querySelector("section");
  expect(page?.hasAttribute("data-arriving")).toBe(true);
  await act(async () => {
    for (const one of played) one.settle();
  });
  expect(page?.hasAttribute("data-arriving")).toBe(false);
});

it("a second arrival on the same page keeps the marker until it settles too", async () => {
  layOut();
  const { container, rerender } = render(<Panel page="tickets" />);
  rerender(
    <Panel page="plans">
      <Rows count={1} />
    </Panel>,
  );
  const first = [...played];
  rerender(
    <Panel page="tickets">
      <Rows count={1} />
    </Panel>,
  );
  const page = container.querySelector("section");
  await act(async () => {
    for (const one of first) one.settle();
  });
  expect(page?.hasAttribute("data-arriving")).toBe(true);
  await act(async () => {
    for (const one of played) one.settle();
  });
  expect(page?.hasAttribute("data-arriving")).toBe(false);
});

it("a page without markers arrives as a whole, and is marked while it does", () => {
  giveBoxes();
  const { container, rerender } = render(<Panel page="tickets" />);
  rerender(<Panel page="plans" />);
  expect(arrivals()).toHaveLength(1);
  expect(
    container.querySelector("section")?.hasAttribute("data-arriving"),
  ).toBe(true);
});

it("a page that owns its entrance is not animated, though the old one still leaves", () => {
  layOut();
  const { container, rerender } = render(<Panel page="tickets" />);
  rerender(
    <Panel page="settings">
      <section data-own-entrance>
        <header data-arrive="header" />
      </section>
    </Panel>,
  );
  expect(played).toHaveLength(1);
  expect(played[0]?.options.fill).toBe("forwards");
  expect(container.querySelector(".view-departing")).not.toBeNull();
  expect(container.querySelector("[data-arriving]")).toBeNull();
});

it("a page inside a host that owns its entrance is left alone too", () => {
  layOut();
  const { rerender } = render(<Panel page="tickets" />);
  rerender(
    <Panel page="projects">
      <div className="management-host">
        <section data-own-entrance />
      </div>
    </Panel>,
  );
  expect(played).toHaveLength(1);
});

it("the picture keeps its ids as data-id: out of getElementById, still in reach of CSS", () => {
  giveBoxes();
  const { container, rerender } = render(
    <Panel page="tickets">
      <section id="page">
        <div id="list" />
        <svg>
          <marker id="arrow" />
        </svg>
      </section>
    </Panel>,
  );
  rerender(<Panel page="plans" />);
  const picture = container.querySelector(".view-departing");
  expect(picture?.querySelector("#list")).toBeNull();
  expect(picture?.querySelector('[data-id="list"]')).not.toBeNull();
  expect(picture?.querySelector('[data-id="page"]')).not.toBeNull();
  expect(document.getElementById("list")).toBeNull();
  // SVG references like url(#arrow) must still resolve inside the picture.
  expect(picture?.querySelector("#arrow")).not.toBeNull();
});

const source = join(__dirname, "..", "..");
function stylesheets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? stylesheets(join(directory, entry.name))
      : entry.name.endsWith(".css")
        ? [join(directory, entry.name)]
        : [],
  );
}

it("every rule that keys layout on a panel id also matches the picture's data-id", () => {
  for (const file of stylesheets(source)) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const id of ["list", "detail", "chat-list", "chat-detail"]) {
      const bare = new RegExp(`#${id}(?![\\w-])`, "g");
      const paired = `:is(#${id}, [data-id="${id}"])`;
      expect(
        css.split(paired).join("").match(bare),
        `${file} #${id}`,
      ).toBeNull();
    }
  }
});

it("the Projects page host has a box, so a switch can fade it", () => {
  const css = readFileSync(join(source, "styles.css"), "utf8");
  const rule = /\.management-host:not\(\[hidden\]\)\s*\{([^}]*)\}/.exec(
    css,
  )?.[1];
  expect(rule).not.toContain("display: contents");
  expect(rule).toContain("display: flex");
});

function workspace(rows = 9) {
  const root = document.createElement("div");
  root.innerHTML = `<nav class="sidebar"></nav>
    <main class="content-panel"><div class="ticket-list">
    <header data-arrive="header"></header>
    <ul class="ticket-rows">${'<li data-arrive="row"></li>'.repeat(rows)}</ul></div></main>`;
  return root;
}

it("launches with the sidebar, then the pane, the header and the first rows in a cascade", () => {
  layOut();
  launch(workspace());
  // sidebar, pane, header, then rows, one stagger step apart: eight steps in all.
  expect(arrivals().map(delayOf)).toEqual([
    0, 24, 48, 72, 96, 120, 144, 168, 168, 168, 168, 168,
  ]);
});

it("launch leaves loading placeholders alone", () => {
  layOut();
  const root = workspace(0);
  root.querySelector("ul")!.innerHTML = "<li></li><li></li>";
  launch(root);
  // sidebar, pane, header
  expect(arrivals()).toHaveLength(3);
});

it("launch does not wait for rows that arrive later: they belong to their list", () => {
  layOut();
  const root = workspace(0);
  launch(root);
  const before = animate.mock.calls.length;
  root.querySelector("ul")!.innerHTML = '<li data-arrive="row"></li>';
  return Promise.resolve().then(() =>
    expect(animate.mock.calls.length).toBe(before),
  );
});

it("the launch marks the pane as arriving until it settles", async () => {
  layOut();
  const root = workspace();
  launch(root);
  const pane = root.querySelector(".content-panel");
  expect(pane?.hasAttribute("data-arriving")).toBe(true);
  await act(async () => {
    for (const one of played) one.settle();
  });
  expect(pane?.hasAttribute("data-arriving")).toBe(false);
});

it("launches nothing under reduced motion", () => {
  useTokens(reducedTokens);
  const root = workspace();
  launch(root);
  expect(animate).not.toHaveBeenCalled();
  expect(root.querySelector("[data-arriving]")).toBeNull();
});
