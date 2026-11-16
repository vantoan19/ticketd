import { useCallback, useEffect, useRef, useState } from "react";
import { setPageZoom } from "@/lib/page-zoom";
import { matchesShortcut } from "@/lib/shortcuts";

const levels = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200] as const;
export type PageZoomAction =
  "page-zoom-in" | "page-zoom-out" | "page-zoom-reset";
type Outcome = { percent: number; error?: unknown };

/** One owner for native page zoom: keys and palette share the same request queue. */
export function usePageZoom() {
  const [percent, setPercent] = useState(100);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const applied = useRef(100);
  const wanted = useRef(100);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const request = useCallback(async (target: number) => {
    wanted.current = target;
    if (running.current || target === applied.current) return;
    running.current = true;
    setPending(true);
    try {
      // Only one IPC may be in flight. Coalesce intermediate keys, and always
      // finish at the latest target (especially a reset pressed during a request).
      while (mounted.current && wanted.current !== applied.current) {
        const next = wanted.current;
        try {
          await setPageZoom(next);
          applied.current = next;
          if (!mounted.current) return;
          setPercent(next);
        } catch (error) {
          // Failed targets and older queued keys cannot become later successes.
          wanted.current = applied.current;
          if (mounted.current) setOutcome({ percent: next, error });
          return;
        }
      }
      if (mounted.current) setOutcome({ percent: applied.current });
    } finally {
      running.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  const run = useCallback(
    (action: PageZoomAction) => {
      const index = levels.findIndex((level) => level === wanted.current);
      const target =
        action === "page-zoom-reset"
          ? 100
          : levels[
              Math.max(
                0,
                Math.min(
                  levels.length - 1,
                  index + (action === "page-zoom-in" ? 1 : -1),
                ),
              )
            ];
      if (target !== undefined) void request(target);
    },
    [request],
  );

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || !("__TAURI_INTERNALS__" in window)) return;
      const action = (
        ["page-zoom-in", "page-zoom-out", "page-zoom-reset"] as const
      ).find((id) => matchesShortcut(event, id));
      if (!action) return;
      // Capture intentionally includes fields, rich editors, dialogs and the
      // graph. Bare +/- remain the graph's own canvas keys. Tauri's native
      // hotkey polyfill is disabled so this event has exactly one zoom owner.
      event.preventDefault();
      event.stopPropagation();
      run(action);
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [run]);

  return { percent, pending, outcome, run, retry: request };
}

export type PageZoom = ReturnType<typeof usePageZoom>;
