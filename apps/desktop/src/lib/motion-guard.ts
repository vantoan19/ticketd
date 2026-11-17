import { MotionGlobalConfig } from "motion/react";

// The input guard (DESIGN.md section 12). Holding a key or clicking rapidly
// must never queue motion behind the input. While either goes on, the document
// is marked `data-motion="instant"`, which zeroes every CSS motion token so
// running CSS motion finishes at once, and the motion library skips whatever it
// would start next. A single press or click keeps its motion.

/** How long motion stays instant after the last repeat or rapid click. */
const HOLD_MS = 300;
/** Two clicks closer than this are rapid. */
const RAPID_MS = 350;

/** Start guarding the window; returns the function that stops it. */
export function installMotionGuard(): () => void {
  const root = document.documentElement;
  let release: ReturnType<typeof setTimeout> | undefined;
  let lastClick = Number.NEGATIVE_INFINITY;

  const setInstant = (on: boolean) => {
    if (on) root.dataset.motion = "instant";
    else delete root.dataset.motion;
    MotionGlobalConfig.skipAnimations = on;
  };
  const hold = () => {
    setInstant(true);
    clearTimeout(release);
    release = setTimeout(() => setInstant(false), HOLD_MS);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) hold();
  };
  const onClick = () => {
    const now = performance.now();
    if (now - lastClick < RAPID_MS) hold();
    lastClick = now;
  };

  // Capture, so the guard is set before the handler that starts the motion.
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("click", onClick, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("click", onClick, true);
    clearTimeout(release);
    setInstant(false);
  };
}
