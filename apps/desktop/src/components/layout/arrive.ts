import {
  blur,
  cssEasing,
  enterTransition,
  exitTransition,
  rise,
  spring,
  staggerDelay,
} from "@/lib/motion-tokens";

// Motion for DOM the shell does not render itself: a page that was already
// there, a snapshot of the one that just left. Components use the primitives in
// components/ui/motion; these are the same entrance and exit, played with the
// Web Animations API on an existing element. Every time comes from the tokens,
// so reduced motion and the input guard (a held key, rapid clicks) make each
// call do nothing at all.

type Options = {
  /** Place in a cascade: later items start a stagger step after earlier ones. */
  index?: number;
  /** Seconds to wait before starting, on top of the cascade. */
  delay?: number;
  /** Fade in place, without rising. */
  fade?: boolean;
};

const seconds = (value: number) => value * 1000;

function canAnimate(element: Element): boolean {
  return typeof element.animate === "function";
}

/** Fade up from a soft blur and settle into place. Returns the animations. */
export function arrive(
  element: Element,
  { index = 0, delay = 0, fade = false }: Options = {},
): Animation[] {
  const enter = enterTransition();
  if (enter.duration === 0 || !canAnimate(element)) return [];
  const wait = seconds(staggerDelay(index) + delay);
  const animations = [
    element.animate(
      [
        { opacity: 0, filter: `blur(${blur("in")}px)` },
        { opacity: 1, filter: "blur(0px)" },
      ],
      {
        duration: seconds(enter.duration),
        delay: wait,
        easing: cssEasing("--ease-out"),
        fill: "backwards",
      },
    ),
  ];
  const settle = spring("smooth");
  if (!fade && settle.duration > 0)
    animations.push(
      element.animate(
        [
          { transform: `translateY(${rise("row")}px)` },
          { transform: "translateY(0)" },
        ],
        {
          duration: seconds(settle.duration),
          delay: wait,
          easing: cssEasing("--spring-smooth"),
          fill: "backwards",
        },
      ),
    );
  return animations;
}

/**
 * Fade out to a slight blur, faster than an entrance, then run `done`. Without
 * motion `done` runs at once.
 */
export function leave(element: Element, done: () => void): void {
  const exit = exitTransition();
  if (exit.duration === 0 || !canAnimate(element)) {
    done();
    return;
  }
  const animation = element.animate(
    [
      { opacity: 1, filter: "blur(0px)" },
      { opacity: 0, filter: `blur(${blur("out")}px)` },
    ],
    {
      duration: seconds(exit.duration),
      easing: cssEasing("--ease-in"),
      fill: "forwards",
    },
  );
  animation.onfinish = done;
  animation.oncancel = done;
}

const latest = new WeakMap<Element, symbol>();

/**
 * The header and the visible rows marked `data-arrive` inside `root`: headers
 * first at step `first`, then the rows one stagger step apart in document
 * order. Rows below the fold are left alone and rows past the last step arrive
 * with it. Placeholders carry no marker, so they never join.
 */
function cascade(root: HTMLElement, first: number, delay: number): Animation[] {
  const frame = root.getBoundingClientRect();
  const shown = (element: Element) => {
    const box = element.getBoundingClientRect();
    return (
      element.getClientRects().length > 0 &&
      box.bottom > frame.top &&
      box.top < frame.bottom
    );
  };
  const marked = (kind: "header" | "row") =>
    [...root.querySelectorAll(`[data-arrive="${kind}"]`)].filter(shown);
  return [
    ...marked("header").flatMap((header) =>
      arrive(header, { index: first, delay }),
    ),
    ...marked("row").flatMap((row, step) =>
      arrive(row, { index: first + 1 + step, delay }),
    ),
  ];
}

/** `root` carries `data-arriving` until the last of `animations` has settled. */
function holdArriving(root: HTMLElement, animations: Animation[]) {
  if (animations.length === 0) return;
  const mine = Symbol("arrival");
  latest.set(root, mine);
  root.setAttribute("data-arriving", "");
  void Promise.allSettled(animations.map((one) => one.finished)).then(() => {
    // A newer arrival on the same root owns the marker now.
    if (latest.get(root) === mine) root.removeAttribute("data-arriving");
  });
}

/**
 * A page arrives (DESIGN.md section 12): its header fades up, then its visible
 * rows follow a stagger step apart. A page with neither marker fades up whole.
 * `delay` is how long the old page takes to leave.
 */
export function arrivePage(page: HTMLElement, delay = 0): void {
  const parts = cascade(page, 0, delay);
  holdArriving(page, parts.length > 0 ? parts : arrive(page, { delay }));
}

/**
 * The window opening (DESIGN.md section 12): the sidebar fades in, the pane
 * follows a step later, then the header and visible rows inside it.
 */
export function arriveWorkspace(
  sidebar: Element | null,
  pane: HTMLElement | null,
): void {
  if (sidebar) arrive(sidebar, { fade: true });
  if (pane)
    holdArriving(pane, [...arrive(pane, { index: 1 }), ...cascade(pane, 2, 0)]);
}
