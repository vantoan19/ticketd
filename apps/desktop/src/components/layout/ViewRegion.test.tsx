// @vitest-environment jsdom
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

// Switching pages and the launch cascade (DESIGN.md section 12). jsdom has no
// layout and no Web Animations, so `animate` is a spy and the tokens are the
// real ones from styles.css.

const animate = vi.fn(
  (_keyframes: unknown, options: KeyframeAnimationOptions) => {
    const animation = {
      options,
      onfinish: null as null | (() => void),
      oncancel: null as null | (() => void),
    };
    return animation as unknown as Animation;
  },
);

let restoreTokens: () => void;
beforeEach(() => {
  animate.mockClear();
  Element.prototype.animate = animate as unknown as Element["animate"];
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
  restoreTokens();
  // @ts-expect-error jsdom has no animate; remove the spy
  delete Element.prototype.animate;
});

function useTokens(tokens: Record<string, string>) {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...tokens });
}

function Panel({ page }: { page: string }) {
  return (
    <main className="content-panel">
      <ViewRegion page={page}>
        <section>{page}</section>
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

it("lays the page that left over the panel to fade out, and holds the new one back", () => {
  giveBoxes();
  const { container, rerender } = render(<Panel page="tickets" />);
  rerender(<Panel page="plans" />);
  const departing = container.querySelector(".view-departing");
  expect(departing?.textContent).toBe("tickets");
  expect(departing?.getAttribute("aria-hidden")).toBe("true");
  expect(departing?.hasAttribute("inert")).toBe(true);
  // The picture fades out for the exit time; the page that arrives waits it out.
  const calls = animate.mock.calls.map(([, options]) => options);
  expect(calls[0]).toMatchObject({ duration: 150, fill: "forwards" });
  expect(calls.slice(1).map((options) => options.delay)).toEqual([150, 150]);
  expect(
    container.querySelector('[data-slot="view-region"]')?.textContent,
  ).toBe("plans");
});

it("removes the picture when its fade ends", () => {
  giveBoxes();
  const { container, rerender } = render(<Panel page="tickets" />);
  rerender(<Panel page="plans" />);
  const fade = animate.mock.results[0]?.value as unknown as {
    onfinish: () => void;
  };
  act(() => fade.onfinish());
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

function workspace() {
  const root = document.createElement("div");
  root.innerHTML = `<nav class="sidebar"></nav>
    <main class="content-panel"><div class="ticket-list"><header class="ui-pane-header"></header>
    <ul class="ticket-rows">${"<li></li>".repeat(9)}</ul></div></main>`;
  return root;
}

it("launches with the sidebar, then the pane, header and the first rows in a cascade", () => {
  launch(workspace());
  const delays = animate.mock.calls
    .map(([, options]) => options)
    // Opacity and blur only; each rising element also has a transform animation.
    .filter((options) => options.easing?.startsWith("cubic-bezier"))
    .map((options) => Math.round(options.delay ?? 0));
  // sidebar, pane, header, then five rows, one stagger step apart.
  expect(delays).toEqual([0, 24, 48, 72, 96, 120, 144, 168]);
});

it("launches rows that arrive after the first paint", async () => {
  const root = workspace();
  const list = root.querySelector("ul")!;
  list.innerHTML = "";
  launch(root);
  const before = animate.mock.calls.length;
  list.innerHTML = "<li></li><li></li>";
  await vi.waitFor(() =>
    expect(animate.mock.calls.length).toBeGreaterThan(before),
  );
});

it("launches nothing under reduced motion", () => {
  useTokens(reducedTokens);
  launch(workspace());
  expect(animate).not.toHaveBeenCalled();
});
