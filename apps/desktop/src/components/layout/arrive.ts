import {
  blur,
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

function css(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/** Easing in the CSS tokens' own spelling, which the Web Animations API takes. */
function easing(name: string): string {
  return css(name) || "linear";
}

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
        easing: easing("--ease-out"),
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
          easing: easing("--spring-smooth"),
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
      easing: easing("--ease-in"),
      fill: "forwards",
    },
  );
  animation.onfinish = done;
  animation.oncancel = done;
}

/** How long, in seconds, an exit takes: what a new page waits for. */
export function exitDuration(): number {
  return exitTransition().duration;
}
