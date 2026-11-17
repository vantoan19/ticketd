import { MotionGlobalConfig } from "motion/react";

// The input guard (DESIGN.md section 12). Holding a key or clicking rapidly
// must never queue motion behind the input. While either goes on, the document
// is marked `data-motion="instant"`, which zeroes every CSS motion token, and
// the motion library skips whatever it would start next. Motion that is already
// running finishes at once, when the guard engages: a running CSS transition
// keeps the timing it started with, and a started library animation ignores the
// flag, so both are finished by hand. A single press or click keeps its motion.

/** How long motion stays instant after the last repeat or rapid click. */
const HOLD_MS = 300;
/** Two clicks closer than this are rapid. */
const RAPID_MS = 350;

/** What the motion library hands the inspector for each animation it starts. */
type Started = { animation: Running };
interface Running {
  state: unknown;
  complete(): void;
}
declare global {
  var __MOTION_INSPECT__: ((record: Started) => void) | undefined;
}

/**
 * Every animation the library starts, until it is swept after it ends. The
 * library has no registry of running animations; the inspector hook
 * (`__MOTION_INSPECT__`, pinned with the exact `motion` version in
 * package.json) is the one place it announces each start with the live handle.
 */
class RunningMotion {
  private started = new Set<Running>();
  private sweepAt = 64;

  add({ animation }: Started) {
    this.started.add(animation);
    if (this.started.size < this.sweepAt) return;
    for (const one of this.started)
      if (one.state !== "running" && one.state !== "paused")
        this.started.delete(one);
    this.sweepAt = Math.max(64, this.started.size * 2);
  }

  /** Jump the animations still running to their end. */
  finish() {
    for (const one of this.started) if (one.state === "running") one.complete();
    this.started.clear();
  }
}

/** Finish what the browser is running: CSS transitions and animations. */
function finishBrowserMotion() {
  for (const animation of document.getAnimations?.() ?? []) {
    // A loop (the skeleton sheen) has no end to finish at.
    const end = animation.effect?.getComputedTiming().endTime;
    if (typeof end === "number" && Number.isFinite(end)) animation.finish();
  }
}

/** Start guarding the window; returns the function that stops it. */
export function installMotionGuard(): () => void {
  const root = document.documentElement;
  let release: ReturnType<typeof setTimeout> | undefined;
  let lastClick = Number.NEGATIVE_INFINITY;

  const running = new RunningMotion();
  const inspector = globalThis.__MOTION_INSPECT__;
  globalThis.__MOTION_INSPECT__ = (record) => {
    running.add(record);
    inspector?.(record);
  };

  const setInstant = (on: boolean) => {
    if (on) root.dataset.motion = "instant";
    else delete root.dataset.motion;
    MotionGlobalConfig.skipAnimations = on;
  };
  const hold = () => {
    const engaging = root.dataset.motion !== "instant";
    setInstant(true);
    if (engaging) {
      running.finish();
      finishBrowserMotion();
    }
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
    globalThis.__MOTION_INSPECT__ = inspector;
  };
}
